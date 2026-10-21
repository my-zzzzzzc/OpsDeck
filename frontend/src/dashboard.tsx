import { useState } from 'react'
import type { ReactNode } from 'react'

import type { Metric, Server } from './api'
import {
  ChartTimeSelect,
  CHART_TIMES,
  MetricLineChart,
  SERIES_COLOR,
  type ChartPoint,
  type ChartTime,
} from './charts'
import { cn } from './cn'
import { HEALTH, levelOf, ratio } from './health'
import {
  IconActivity,
  IconAlert,
  IconAlertOctagon,
  IconCheck,
  IconClock,
  IconCpu,
  IconDisk,
  IconMemory,
  IconServer,
  IconTerminal,
} from './icons'
import { Card, GhostButton, STAT_TONE, StatusDot } from './ui'

/*
 * 首页看板的表现层。
 *
 * 这一版把「有没有事」提到最前面:一张状态卡给出结论、部署机身份和四项资源
 * 的当前水位,下面是「趋势」与「容器」两个工作区。旧版是身份条 + 四张等大的
 * 图表卡 + 容器卡片墙,九块内容同重、同底色,读者得自己找重点。
 *
 * 三条硬规则保持不变:
 *   - 正常值不上色。只有越过 70 / 85 阈值的那一项才拿到语义色。
 *   - 缺失不画成 0。曲线断在 null 处,读数写「—」。
 *   - 不编数据。采集器没下发的指标(温度 / 磁盘 IO / 带宽)这里没有。
 */

/** 部署机上的容器摘要。与 ContainerBoard 的 bad 口径保持一致。 */
export interface HostContainerSummary {
  total: number
  running: number
  bad: number
}

const LOAD_SERIES = [
  { key: 'load_1', label: '1 分钟', color: 'hsl(271, 81%, 60%)' },
  { key: 'load_5', label: '5 分钟', color: 'hsl(217, 91%, 60%)' },
  { key: 'load_15', label: '15 分钟', color: 'hsl(25, 95%, 53%)' },
] as const

type Tone = 'ok' | 'warn' | 'bad'

const STATUS_TONE: Record<Tone, { accent: string; orb: string; icon: ReactNode }> = {
  ok: {
    accent: 'bg-status-ok',
    orb: 'bg-tint-success text-ink-success',
    icon: <IconCheck size={20} />,
  },
  warn: {
    accent: 'bg-status-warn',
    orb: 'bg-tint-warning text-ink-warning',
    icon: <IconAlert size={20} />,
  },
  bad: {
    accent: 'bg-status-bad',
    orb: 'bg-tint-danger text-ink-danger',
    icon: <IconAlertOctagon size={20} />,
  },
}

/** MB → GB 的展示值。缺失返回「—」,不返回 0。 */
function memGb(v?: number | null): string {
  return v != null ? (v / 1024).toFixed(1) : '—'
}

/** 从 points 里取一列,把 undefined / NaN 统一成 null。 */
function column(points: ChartPoint[], key: string): Array<number | null> {
  return points.map((p) => {
    const v = p[key]
    return typeof v === 'number' && Number.isFinite(v) ? v : null
  })
}

/**
 * 迷你走势线。
 *
 * 用途是让「当前值」旁边有一点形状,而不是替代大图。
 * 空值处**断开**,不连成一条直线 —— 采集器掉线看起来不该像机器很闲。
 */
function Sparkline({
  values,
  color,
  className,
}: {
  values: Array<number | null>
  color: string
  className?: string
}) {
  const W = 120
  const H = 32
  const finite = values.filter((v): v is number => v !== null)

  if (finite.length < 2) {
    return (
      <span className={cn('flex items-center justify-end text-[9.5px] text-ink-tertiary', className)}>
        无历史
      </span>
    )
  }

  const min = Math.min(...finite)
  const max = Math.max(...finite)
  const flat = max - min < 1e-9
  const lo = flat ? min - 0.5 : min
  const hi = flat ? max + 0.5 : max
  const span = hi - lo || 1

  const xAt = (i: number) => (values.length <= 1 ? W / 2 : (i / (values.length - 1)) * (W - 2) + 1)
  const yAt = (v: number) => H - 3 - ((v - lo) / span) * (H - 6)

  const segments: Array<Array<[number, number]>> = []
  let segment: Array<[number, number]> = []
  values.forEach((v, i) => {
    if (v === null) {
      if (segment.length) {
        segments.push(segment)
        segment = []
      }
      return
    }
    segment.push([xAt(i), yAt(v)])
  })
  if (segment.length) segments.push(segment)

  const tail = segments.length ? segments[segments.length - 1] : null
  const last = tail && tail.length ? tail[tail.length - 1] : null

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="none"
      className={className}
      aria-hidden="true"
    >
      {segments.map((seg, idx) => {
        const line = seg.map(([x, y]) => `${x},${y}`).join(' ')
        const area = `${seg[0][0]},${H} ${line} ${seg[seg.length - 1][0]},${H}`
        return (
          <g key={idx}>
            <polygon points={area} fill={color} opacity={0.1} />
            <polyline
              points={line}
              fill="none"
              stroke={color}
              strokeWidth={1.5}
              strokeLinecap="round"
              strokeLinejoin="round"
              vectorEffect="non-scaling-stroke"
            />
          </g>
        )
      })}
      {last ? <circle cx={last[0]} cy={last[1]} r={2.2} fill={color} /> : null}
    </svg>
  )
}

/** 资源读数方块:标签 + 当前值 + 24h 走势 + 水位条。 */
function ResourceTile({
  label,
  icon,
  value,
  decimals,
  unit,
  hint,
  percent,
  color,
  values,
}: {
  label: string
  icon: ReactNode
  value: number | null
  decimals: number
  unit?: string
  hint: string
  percent: number | null
  color: string
  values: Array<number | null>
}) {
  const has = value !== null && Number.isFinite(value)
  const level = percent === null ? 'ok' : levelOf(Math.min(100, Math.max(0, percent)))
  const pct = percent === null ? 0 : Math.min(100, Math.max(0, percent))
  const tone = percent === null ? STAT_TONE.neutral : STAT_TONE[levelOf(pct)]

  return (
    <div className="flex min-w-0 flex-col rounded-md bg-sunken p-3">
      <div className="flex min-w-0 items-center gap-1.5">
        <span className="shrink-0 text-ink-tertiary">{icon}</span>
        <span className="truncate text-[11px] font-medium text-ink-secondary">{label}</span>
        <Sparkline values={values} color={color} className="ms-auto h-6 w-16 shrink-0 opacity-85" />
      </div>

      <div className="mt-1 flex items-baseline gap-1">
        {has ? (
          <span
            className={cn(
              'text-[25px] leading-none font-semibold tracking-tight tabular-nums',
              tone,
            )}
          >
            {value.toFixed(decimals)}
          </span>
        ) : (
          <span className="text-[25px] leading-none font-semibold text-ink-tertiary">—</span>
        )}
        {has && unit ? <span className="text-[12px] text-ink-tertiary">{unit}</span> : null}
      </div>

      <div className="mt-auto flex items-center gap-2 pt-2">
        <span className="block h-1 flex-1 overflow-hidden rounded-full bg-overlay-medium">
          <span
            className={cn(
              'block h-full rounded-full transition-[width] duration-500 ease-out',
              HEALTH[level].bar,
            )}
            style={{ width: `${pct}%` }}
          />
        </span>
        <span className="shrink-0 truncate text-[9.5px] tabular-nums text-ink-tertiary">
          {hint}
        </span>
      </div>
    </div>
  )
}

export interface DashboardHeroProps {
  host: Server
  metric?: Metric
  points: ChartPoint[]
  containers: HostContainerSummary
  alertCount: number
  criticalCount: number
  capturedAt: string | null
  onOpenTerminal?: () => void
}

/**
 * 首屏状态卡。
 *
 * 左边回答「有没有事」并交代这是哪台机器;右边是四项资源的当前水位。
 * 结论区只有一句加粗的话,不再把五个指标做成五张同重的统计卡。
 */
export function DashboardHero({
  host,
  metric,
  points,
  containers,
  alertCount,
  criticalCount,
  capturedAt,
  onOpenTerminal,
}: DashboardHeroProps) {
  const online = host.status === 'online'
  const cpu = metric?.cpu_percent ?? null
  const memPct = ratio(metric?.mem_used_mb, metric?.mem_total_mb)
  const diskPct = ratio(metric?.disk_used_gb, metric?.disk_total_gb)
  const load = metric?.load_1 ?? null
  const cores = host.cpu_cores
  const loadPct = load !== null && cores ? Math.min(100, (load / cores) * 100) : null

  let tone: Tone = 'ok'
  let headline = '运行平稳'
  let detail = capturedAt ? `监控数据更新于 ${capturedAt}` : '正在等待采集器上报数据'

  if (!online) {
    tone = 'bad'
    headline = '服务器离线'
    detail = capturedAt ? `最后一次采集于 ${capturedAt}` : '尚未收到采集数据'
  } else if (criticalCount > 0) {
    tone = 'bad'
    headline = `${criticalCount} 项故障待处理`
    detail = '请在容器状态中定位并处理异常'
  } else if (containers.bad > 0) {
    tone = 'warn'
    headline = `${containers.bad} 个容器需要关注`
    detail = '请在容器状态中查看受影响的服务'
  } else if (alertCount > 0) {
    tone = 'warn'
    headline = `${alertCount} 条告警待确认`
    detail = '请核对告警详情后标记已读'
  }

  const status = STATUS_TONE[tone]

  const resources = [
    {
      label: 'CPU',
      icon: <IconCpu size={13} />,
      value: cpu,
      decimals: 1,
      unit: '%',
      hint: cores ? `${cores} 核` : '—',
      percent: cpu,
      color: SERIES_COLOR.cpu,
      values: column(points, 'cpu'),
    },
    {
      label: '内存',
      icon: <IconMemory size={13} />,
      value: memPct,
      decimals: 1,
      unit: '%',
      hint: `${memGb(metric?.mem_used_mb)} / ${memGb(metric?.mem_total_mb)} GB`,
      percent: memPct,
      color: SERIES_COLOR.mem,
      values: column(points, 'mem_pct'),
    },
    {
      label: '磁盘',
      icon: <IconDisk size={13} />,
      value: diskPct,
      decimals: 1,
      unit: '%',
      hint:
        metric?.disk_used_gb != null && metric?.disk_total_gb != null
          ? `${metric.disk_used_gb.toFixed(0)} / ${metric.disk_total_gb.toFixed(0)} GB`
          : '—',
      percent: diskPct,
      color: SERIES_COLOR.disk,
      values: column(points, 'disk_pct'),
    },
    {
      label: '负载',
      icon: <IconActivity size={13} />,
      value: load,
      decimals: 2,
      hint: cores ? `${cores} 核 · 1 分钟` : '1 分钟',
      percent: loadPct,
      color: LOAD_SERIES[0].color,
      values: column(points, 'load_1'),
    },
  ]

  return (
    <Card padded={false} className="relative overflow-hidden">
      {/* 顶部一根 2px 状态线:颜色本身就是结论,比再加一个徽标安静 */}
      <span className={cn('absolute inset-x-0 top-0 h-[2px]', status.accent)} aria-hidden="true" />

      <div className="grid lg:grid-cols-[minmax(0,1.02fr)_minmax(0,1fr)]">
        <div className="flex min-w-0 flex-col p-4 sm:p-5">
          {/* 上半部分只给状态结论留位,下半部分固定为部署节点资料。 */}
          <div className="flex min-h-0 flex-1 items-center">
            <div className="flex items-start gap-3">
              <span
                className={cn(
                  'flex size-11 shrink-0 items-center justify-center rounded-full',
                  status.orb,
                )}
                role="img"
                aria-label={headline}
              >
                {status.icon}
              </span>
              <div className="min-w-0">
                <div className="text-[10.5px] font-medium text-ink-tertiary">
                  OpsDeck 部署节点
                </div>
                <h2 className="mt-1 text-[23px] leading-tight font-semibold tracking-tight text-ink">
                  {headline}
                </h2>
                <p className="mt-1 text-[12px] text-ink-secondary">{detail}</p>
              </div>
            </div>
          </div>

          {/* 下半部分是资料行,直接挂在分隔线下,不嵌套第二张卡片。 */}
          <div className="border-t border-line pt-3">
            <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1.5">
              <StatusDot status={online ? 'online' : host.status === 'offline' ? 'offline' : 'unknown'} />
              <IconServer size={13} className="shrink-0 text-ink-tertiary" />
              <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-ink" title={host.name}>
                {host.name}
              </span>
              <span className="shrink-0 rounded-xs bg-overlay-light px-1.5 py-0.5 text-[10px] text-ink-tertiary">
                部署节点
              </span>
            </div>

            <div className="mt-1.5 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[10.5px] text-ink-tertiary">
              <span className="mono">{host.ip ?? host.hostname ?? '—'}</span>
              {host.os_info ? <span className="truncate">{host.os_info}</span> : null}
              {host.cpu_cores ? <span>{host.cpu_cores} 核</span> : null}
              {host.mem_total_mb ? <span>{memGb(host.mem_total_mb)} GB 内存</span> : null}
              {capturedAt ? (
                <span className="flex items-center gap-1">
                  <IconClock size={10} />
                  采集于 {capturedAt}
                </span>
              ) : null}
            </div>
          </div>

          {/* 终端是直接运维入口;图表跳转不放在状态卡里。 */}
          {onOpenTerminal ? (
            <div className="flex flex-wrap items-center gap-1.5 pt-2.5">
              <GhostButton onClick={onOpenTerminal}>
                <span className="flex items-center gap-1">
                  <IconTerminal size={11} />
                  终端
                </span>
              </GhostButton>
            </div>
          ) : null}
        </div>

        <div className="grid grid-cols-2 gap-2 border-t border-line p-3 sm:p-4 lg:border-s lg:border-t-0">
          {resources.map((r) => (
            <ResourceTile key={r.label} {...r} />
          ))}
        </div>
      </div>
    </Card>
  )
}

type TrendKey = 'cpu' | 'mem' | 'disk' | 'load'

const TREND_METRICS: Array<{
  key: TrendKey
  label: string
  pointKey: string
  color: string
  decimals: number
}> = [
  { key: 'cpu', label: 'CPU', pointKey: 'cpu', color: SERIES_COLOR.cpu, decimals: 1 },
  { key: 'mem', label: '内存', pointKey: 'mem_pct', color: SERIES_COLOR.mem, decimals: 1 },
  { key: 'disk', label: '磁盘', pointKey: 'disk_pct', color: SERIES_COLOR.disk, decimals: 1 },
  { key: 'load', label: '负载', pointKey: 'load_1', color: LOAD_SERIES[0].color, decimals: 2 },
]

const SERVER_COLORS = [
  'hsl(220 70% 50%)',
  'hsl(160 60% 45%)',
  'hsl(30 80% 55%)',
  'hsl(280 65% 60%)',
  'hsl(340 75% 55%)',
  'hsl(190 75% 42%)',
] as const

/**
 * 多机资源趋势。
 *
 * 同一指标下每台服务器一条线，颜色与服务器绑定。历史端点按相同桶数返回，
 * 因此按桶序号合并，避免不同机器在桶内的采样秒数差异把本应重合的曲线错开。
 */

export function TrendCard({
  servers,
  metricsByServer,
  pointsByServer,
  range,
  onRangeChange,
}: {
  servers: Server[]
  metricsByServer: Map<string, Metric>
  pointsByServer: Map<string, ChartPoint[]>
  range: ChartTime
  onRangeChange: (range: ChartTime) => void
}) {
  const [activeKey, setActiveKey] = useState<TrendKey>('cpu')
  const active = TREND_METRICS.find((m) => m.key === activeKey) ?? TREND_METRICS[0]
  const chartServers = servers.filter((s) => pointsByServer.has(s.id))
  const maxPoints = Math.max(0, ...chartServers.map((s) => pointsByServer.get(s.id)?.length ?? 0))
  const chartData: ChartPoint[] = Array.from({ length: maxPoints }, (_, index) => {
    const row: ChartPoint = { created: 0 }
    for (const server of chartServers) {
      const point = pointsByServer.get(server.id)?.[index]
      if (!point) continue
      if (!row.created && typeof point.created === 'number') row.created = point.created
      row[`server-${server.id}`] = point[active.pointKey] ?? null
    }
    return row
  })
  const series = chartServers.map((server, index) => ({
    key: `server-${server.id}`,
    label: server.name,
    color: SERVER_COLORS[index % SERVER_COLORS.length],
  }))
  const onlineCount = servers.filter((s) => s.status === 'online').length
  const isPercent = active.key !== 'load'

  return (
    <Card padded={false} className="flex flex-col overflow-hidden">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-2 border-b border-line px-3.5 py-2.5">
        <IconActivity size={14} className="shrink-0 text-ink-tertiary" />
        <h2 className="text-[12.5px] font-semibold text-ink">资源趋势</h2>

        <div className="ms-auto flex flex-wrap items-center gap-1.5">
          <div
            className="flex items-center gap-0.5 rounded-md border border-line bg-sunken p-0.5"
            role="group"
            aria-label="切换趋势指标"
          >
            {TREND_METRICS.map((m) => {
              const on = m.key === active.key
              return (
                <button
                  key={m.key}
                  type="button"
                  aria-pressed={on}
                  onClick={() => setActiveKey(m.key)}
                  className={cn(
                    'h-6 cursor-pointer rounded-sm border px-2.5 text-[11px] transition-colors',
                    on
                      ? 'border-line-strong bg-primary font-medium text-ink'
                      : 'border-transparent text-ink-tertiary hover:text-ink-secondary',
                  )}
                >
                  {m.label}
                </button>
              )
            })}
          </div>
          <ChartTimeSelect
            compact
            value={range}
            onChange={onRangeChange}
            className="w-[7.25rem] shrink-0"
          />
        </div>
      </div>

      <div className="min-w-0">
        <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-1 px-4 pt-3.5">
          <div className="min-w-0">
            <div className="flex flex-wrap items-baseline gap-x-1.5 gap-y-1">
              <span className="text-[22px] leading-none font-semibold tracking-tight text-ink">
                {servers.length} 台服务器
              </span>
              <span className="text-[11px] text-ink-tertiary">{active.label} 对比</span>
            </div>

            <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-ink-tertiary">
              <span>在线 {onlineCount}/{servers.length}</span>
              <span>每台服务器一条线</span>
            </div>
          </div>

          <span className="pb-0.5 text-[9.5px] text-ink-tertiary">
            {CHART_TIMES[range].label}历史
          </span>
        </div>

        {/* 图表父容器必须定高。大图固定 224px,不随容器列一起变高 ——
            空网格拉满半屏比一张矮图更像"没数据"。 */}
        <div className="relative h-72 px-1.5 pt-2">
          <MetricLineChart
            data={chartData}
            time={range}
            series={series}
            domain={isPercent ? [0, 100] : [0, 'auto']}
            tickFormatter={(v) => (isPercent ? `${Number(v.toFixed(0))}%` : Number(v.toFixed(2)).toString())}
            valueFormatter={(v) => (isPercent ? `${v.toFixed(1)}%` : v.toFixed(2))}
          />
        </div>

        {/*
          折线图只回答「谁在什么时候高」。这张表补的是「现在各台是什么数」——
          服务器名前的色点就是折线图例,不再单独占一行图例。
        */}
        <div className="border-t border-line">
          <div className="grid grid-cols-[minmax(0,1fr)_52px_58px_52px_52px] gap-2 px-3.5 py-1.5 text-[9px] text-ink-tertiary">
            <span>服务器</span>
            <span className="text-right">CPU</span>
            <span className="text-right">内存</span>
            <span className="text-right">磁盘</span>
            <span className="text-right">负载</span>
          </div>
          <div className="max-h-[6.5rem] overflow-y-auto">
            {servers.map((s) => {
              const m = metricsByServer.get(s.id)
              const cpu = m?.cpu_percent ?? null
              const mem = ratio(m?.mem_used_mb, m?.mem_total_mb)
              const disk = ratio(m?.disk_used_gb, m?.disk_total_gb)
              const load = m?.load_1 ?? null
              const colorIndex = chartServers.findIndex((cs) => cs.id === s.id)
              const color = colorIndex >= 0 ? SERVER_COLORS[colorIndex % SERVER_COLORS.length] : null
              const cellTone = s.status === 'online' ? 'text-ink-secondary' : 'text-ink-tertiary'
              const cell = (key: TrendKey, value: number | null) => (
                <span
                  className={cn(
                    'text-right text-[10.5px] tabular-nums',
                    active.key === key ? 'font-medium text-ink' : cellTone,
                  )}
                >
                  {value == null
                    ? '—'
                    : key === 'load'
                      ? value.toFixed(2)
                      : `${value.toFixed(1)}%`}
                </span>
              )
              return (
                <div
                  key={s.id}
                  className="grid grid-cols-[minmax(0,1fr)_52px_58px_52px_52px] items-center gap-2 px-3.5 py-1 text-[10.5px]"
                >
                  <span className="flex min-w-0 items-center gap-1.5">
                    <span
                      className={cn('size-1.5 shrink-0 rounded-full', !color && 'bg-ink-tertiary')}
                      style={color ? { background: color } : undefined}
                      aria-hidden="true"
                    />
                    <span className="truncate text-ink-secondary" title={s.name}>
                      {s.name}
                    </span>
                    {s.status !== 'online' ? (
                      <span className="shrink-0 text-[9px] text-ink-danger">
                        {s.status === 'offline' ? '离线' : '未知'}
                      </span>
                    ) : null}
                  </span>
                  {cell('cpu', cpu)}
                  {cell('mem', mem)}
                  {cell('disk', disk)}
                  {cell('load', load)}
                </div>
              )
            })}
          </div>
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 border-t border-line px-3.5 py-2 text-[10px] text-ink-tertiary">
        <span className="flex items-center gap-1">
          <IconClock size={10} />
          采集器 15 秒上报
        </span>
        <span>{CHART_TIMES[range].label} · 每 5 分钟重取历史</span>
      </div>
    </Card>
  )
}
