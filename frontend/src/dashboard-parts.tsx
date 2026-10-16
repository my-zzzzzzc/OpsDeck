import type { ReactNode } from 'react'

import type { EventItem, Instance, Project, Server } from './api'
import { HEALTH, levelOf, ratio } from './health'
import { Card } from './ui'

/*
 * 仪表板的三块新积木。
 *
 * 设计意图(按重要性排序):
 *   1. AlertBar   —— 回答「现在有没有事」。这是首页**唯一**必须第一眼看的东西。
 *                    没问题时它收敛成一行绿字,不占视觉重量;
 *                    有问题时它按严重度展开,并直接给出「哪台机器、什么事」。
 *   2. ContainerGrid —— 回答「我的服务在不在跑」。
 *                    容器名 + 所属服务器 + 健康状态 + 内存,一屏看全。
 *   3. TrendPanel —— 回答「在变好还是变坏」。
 *                    水位线只说此刻多少,曲线才说趋势。
 *
 * 三条共同约束:
 *   - 缺数据一律渲染成「—」,不编造 0。0 与「没采到」在运维语境里是两回事。
 *   - 颜色只在需要动作时出现(见 health.ts 的注释),常态一律中性色。
 *   - 所有判定走 health.ts 的 levelOf,不在组件里另写阈值。
 */

// ---------------------------------------------------------------- 告警条

/** 一条待展示的告警。由 EventItem 归一化而来,便于合并"本地计算"的异常。 */
export interface AlertRow {
  key: string
  level: 'critical' | 'warning' | 'info'
  title: string
  detail?: string
  /** 来源标签,如服务器名或容器名。 */
  source?: string
  /** 点击跳转(可选)。 */
  onClick?: () => void
}

const LEVEL_STYLE = {
  critical: {
    wrap: 'border-line-danger bg-tint-danger',
    text: 'text-ink-danger',
    label: '严重',
  },
  warning: {
    wrap: 'border-line-strong bg-tint-orange',
    text: 'text-ink-warning',
    label: '警告',
  },
  info: {
    wrap: 'border-line bg-secondary',
    text: 'text-ink-secondary',
    label: '提示',
  },
} as const

/**
 * 告警条。
 *
 * 三种形态:
 *   - 有 critical/warning 告警 → 逐条列出,红色/琥珀色描边。
 *   - 无告警但系统正常      → 一行绿字「全部正常」,不抢视线。
 *   - 无告警但从未检测过    → 中性提示,并说明「尚未产生告警」而不是「一切正常」。
 *
 * 第三种是刻意区分的:把"没检测"说成"没问题"是这类看板最容易撒的谎。
 */
export function AlertBar({
  alerts,
  hasData,
  onOpenAlerts,
}: {
  alerts: AlertRow[]
  /** 是否已有服务器在正常上报。false 时不说「正常」。 */
  hasData: boolean
  onOpenAlerts?: () => void
}) {
  const critical = alerts.filter((a) => a.level === 'critical')
  const warning = alerts.filter((a) => a.level === 'warning')
  const rest = alerts.filter((a) => a.level === 'info')
  const ordered = [...critical, ...warning, ...rest]

  // ---- 无告警 ----
  if (ordered.length === 0) {
    return (
      <Card
        padded={false}
        className={`flex items-center gap-2.5 px-3.5 py-2.5 ${
          hasData ? 'border-ink-success/40' : ''
        }`}
      >
        <span className={`size-2 shrink-0 rounded-full ${hasData ? 'bg-ink-success' : 'bg-ink-tertiary'}`} />
        <span className={`text-[13px] font-medium ${hasData ? 'text-ink-success' : 'text-ink-secondary'}`}>
          {hasData ? '一切正常' : '尚无告警数据'}
        </span>
        <span className="text-[11.5px] text-ink-tertiary">
          {hasData
            ? '所有服务器在线,指标均未越过阈值'
            : '等待服务器上报,或前往告警页配置阈值'}
        </span>
        {onOpenAlerts ? (
          <button
            type="button"
            onClick={onOpenAlerts}
            className="ml-auto shrink-0 cursor-pointer text-[11.5px] text-ink-tertiary transition-colors hover:text-ink"
          >
            查看告警 →
          </button>
        ) : null}
      </Card>
    )
  }

  // ---- 有告警 ----
  const worst = critical.length > 0 ? 'critical' : 'warning'
  const style = LEVEL_STYLE[worst]

  return (
    <Card padded={false} className={`overflow-hidden border ${style.wrap}`}>
      <div className="flex items-center gap-2 px-3.5 pt-2.5 pb-1.5">
        <span className={`text-[13px] font-semibold ${style.text}`}>
          {critical.length > 0
            ? `${critical.length} 项严重问题`
            : `${warning.length} 项警告`}
        </span>
        <span className="text-[11.5px] text-ink-tertiary">
          需要处理 · 共 {ordered.length} 条
        </span>
        {onOpenAlerts ? (
          <button
            type="button"
            onClick={onOpenAlerts}
            className="ml-auto shrink-0 cursor-pointer text-[11.5px] text-ink-tertiary transition-colors hover:text-ink"
          >
            全部 →
          </button>
        ) : null}
      </div>

      <div className="flex flex-col">
        {ordered.slice(0, 5).map((a) => {
          const s = LEVEL_STYLE[a.level]
          return (
            <button
              key={a.key}
              type="button"
              onClick={a.onClick}
              disabled={!a.onClick}
              className={`flex items-start gap-2 border-t border-line/60 px-3.5 py-1.5 text-left ${
                a.onClick ? 'cursor-pointer transition-colors hover:bg-overlay-light' : 'cursor-default'
              }`}
            >
              <span className={`mt-1 shrink-0 text-[10px] font-medium ${s.text}`}>{s.label}</span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[12.5px] text-ink">{a.title}</span>
                {a.detail ? (
                  <span className="mt-0.5 block truncate text-[11px] text-ink-tertiary">{a.detail}</span>
                ) : null}
              </span>
              {a.source ? (
                <span className="mono shrink-0 text-[11px] text-ink-tertiary">{a.source}</span>
              ) : null}
            </button>
          )
        })}
        {ordered.length > 5 ? (
          <div className="border-t border-line/60 px-3.5 py-1.5 text-[11.5px] text-ink-tertiary">
            还有 {ordered.length - 5} 条未显示
          </div>
        ) : null}
      </div>
    </Card>
  )
}

// ---------------------------------------------------------------- 容器面板

interface ContainerRow {
  instance: Instance
  serverName: string
  projectName: string
}

/** 容器健康度 → 三级。docker 的 health 字段可能是 healthy/unhealthy/starting/空。 */
function containerLevel(c: Instance): 'ok' | 'warn' | 'bad' {
  if (c.state !== 'running') return 'bad'
  if (c.health === 'unhealthy') return 'bad'
  if (c.health === 'starting') return 'warn'
  return 'ok'
}

const CONTAINER_TEXT: Record<'ok' | 'warn' | 'bad', string> = {
  ok: 'running',
  warn: 'starting',
  bad: '异常',
}

/**
 * 容器状态面板。
 *
 * 关键信息是**「哪个容器 + 在哪台服务器上」** ——
 * 只写容器名的话,多机环境下根本不知道该去哪台机器处理。
 *
 * 排序:异常在前。看板的作用是让你先看到有事的那个。
 */
export function ContainerGrid({
  instances,
  projects,
  servers,
  onSelectServer,
}: {
  instances: Instance[]
  projects: Project[]
  servers: Server[]
  onSelectServer?: (s: Server) => void
}) {
  const projectById = new Map(projects.map((p) => [p.id, p]))
  const serverById = new Map(servers.map((s) => [s.id, s]))

  const rows: ContainerRow[] = instances.map((i) => {
    const proj = projectById.get(i.project_id)
    const srv = proj ? serverById.get(proj.server_id) : undefined
    return {
      instance: i,
      serverName: srv?.name ?? '未知服务器',
      projectName: proj?.name ?? '未登记',
    }
  })

  const rank = { bad: 0, warn: 1, ok: 2 } as const
  rows.sort((a, b) => {
    const d = rank[containerLevel(a.instance)] - rank[containerLevel(b.instance)]
    if (d !== 0) return d
    return a.instance.name.localeCompare(b.instance.name)
  })

  const badCount = rows.filter((r) => containerLevel(r.instance) !== 'ok').length
  const serverNames = [...new Set(rows.map((r) => r.serverName))]

  return (
    <Card padded={false} className="overflow-hidden">
      <div className="flex items-center gap-2 border-b border-line px-3.5 py-2.5">
        <span className="text-[13px] font-semibold text-ink">容器</span>
        <span className="rounded-xs bg-overlay-light px-1.5 py-0.5 text-[11px] text-ink-tertiary">
          {rows.length - badCount}/{rows.length} 运行中
        </span>
        {badCount > 0 ? (
          <span className="rounded-xs bg-tint-danger px-1.5 py-0.5 text-[11px] text-ink-danger">
            {badCount} 个异常
          </span>
        ) : null}
        <span className="ml-auto truncate text-[11px] text-ink-tertiary">
          {serverNames.length} 台服务器
        </span>
      </div>

      {rows.length === 0 ? (
        <div className="px-3.5 py-8 text-center text-[12.5px] text-ink-tertiary">
          还没有采集到容器。请确认采集器已运行,且所属项目已登记。
        </div>
      ) : (
        <div className="grid gap-px bg-line sm:grid-cols-2 xl:grid-cols-3">
          {rows.map((r) => {
            const lv = containerLevel(r.instance)
            const h = HEALTH[lv]
            const srv = servers.find((s) => s.name === r.serverName)
            return (
              <div key={r.instance.id} className="min-w-0 bg-primary px-3.5 py-2.5">
                <div className="flex items-center gap-1.5">
                  <span className={`size-2 shrink-0 rounded-full ${h.dot}`} />
                  <span className="truncate text-[12.5px] font-medium text-ink" title={r.instance.name}>
                    {r.instance.name}
                  </span>
                  <span className={`ml-auto shrink-0 text-[11px] ${lv === 'ok' ? 'text-ink-tertiary' : h.text}`}>
                    {CONTAINER_TEXT[lv]}
                  </span>
                </div>

                {/* 所属服务器:多机环境下这是最关键的一列 */}
                <button
                  type="button"
                  disabled={!srv || !onSelectServer}
                  onClick={() => srv && onSelectServer?.(srv)}
                  className={`mono mt-1 flex w-full items-center gap-1 truncate text-left text-[11px] text-ink-tertiary ${
                    srv && onSelectServer ? 'cursor-pointer hover:text-accent hover:underline' : ''
                  }`}
                  title={r.serverName}
                >
                  <span className="truncate">{r.serverName}</span>
                </button>

                <div className="mt-1 flex items-center gap-2 text-[11px] text-ink-tertiary">
                  <span className="truncate" title={r.instance.image ?? ''}>
                    {r.instance.image ?? '—'}
                  </span>
                  <span className="ml-auto shrink-0">
                    {r.instance.mem_used_mb != null ? `${r.instance.mem_used_mb} MB` : '—'}
                  </span>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </Card>
  )
}

// ---------------------------------------------------------------- 水位行

/**
 * 带趋势的一行水位。
 *
 * 相比原来的纯水位条,右侧多了一个「24h 变化」的箭头与迷你曲线:
 *   水位 42% 本身不说明问题,**从 10% 涨到 42%** 才是。
 */
export function TrendRow({
  label,
  icon,
  pct,
  detail,
  hint,
  delta,
  spark,
}: {
  label: string
  icon?: ReactNode
  pct: number | null
  detail?: string
  hint?: string
  /** 24 小时内的百分点变化。null 表示没有足够历史。 */
  delta?: number | null
  /** 迷你曲线点(0-100)。 */
  spark?: Array<number | null>
}) {
  const has = pct !== null && Number.isFinite(pct)
  const p = has ? Math.max(0, Math.min(100, pct as number)) : 0
  const lv = has ? levelOf(p) : 'ok'

  return (
    <div className="flex items-center gap-3 py-1.5">
      <span className="flex w-[68px] shrink-0 items-center gap-1.5 text-[11.5px] text-ink-secondary">
        {icon ? <span className="text-ink-tertiary">{icon}</span> : null}
        <span className="truncate">{label}</span>
      </span>

      <span className="w-[52px] shrink-0 text-right text-[12.5px] font-medium tnum">
        {has ? (
          <span className={lv === 'ok' ? 'text-ink' : HEALTH[lv].text}>{p.toFixed(1)}%</span>
        ) : (
          <span className="text-ink-tertiary">—</span>
        )}
      </span>

      <span className="h-[6px] min-w-0 flex-1 overflow-hidden rounded-full bg-overlay-medium">
        <span
          className={`block h-full rounded-full transition-[width] duration-500 ease-out ${
            has ? HEALTH[lv].bar : ''
          }`}
          style={{ width: `${p}%` }}
        />
      </span>

      {/* 迷你趋势:只画形状,不画坐标轴 */}
      {spark && spark.length > 1 ? (
        <Sparkline values={spark} className="w-[70px] shrink-0" />
      ) : (
        <span className="w-[70px] shrink-0" />
      )}

      <span className="w-[104px] shrink-0 text-right text-[11px] text-ink-tertiary">
        {detail ?? '\u00a0'}
      </span>

      <span className="w-[68px] shrink-0 text-right text-[11px]">
        {delta === null || delta === undefined ? (
          <span className="text-ink-tertiary">新接入</span>
        ) : Math.abs(delta) < 0.5 ? (
          <span className="text-ink-tertiary">持平</span>
        ) : (
          <span className={delta > 0 ? 'text-ink-warning' : 'text-ink-success'}>
            {delta > 0 ? '↑' : '↓'} {Math.abs(delta).toFixed(1)}%
          </span>
        )}
      </span>

      {hint ? (
        <span className="hidden w-[92px] shrink-0 truncate text-right text-[11px] text-ink-tertiary xl:block">
          {hint}
        </span>
      ) : null}
    </div>
  )
}

/**
 * 迷你曲线。
 *
 * 用内联 SVG 而不是复用 recharts:这是 70×18 的装饰性形状,
 * 引一个完整图表组件进来只为画它,得不偿失。
 *
 * null 点会**断线**而不是补零 —— 与 charts.tsx 的约定一致:
 * 「没采到」和「掉到 0」必须长得不一样。
 */
export function Sparkline({
  values,
  className = '',
}: {
  values: Array<number | null>
  className?: string
}) {
  const pts = values.filter((v): v is number => v !== null && Number.isFinite(v))
  if (pts.length < 2) return <span className={className} />

  const min = Math.min(...pts)
  const max = Math.max(...pts)
  const span = max - min || 1

  const W = 70
  const H = 18
  const step = W / (values.length - 1)

  const segments: string[] = []
  let cur: string[] = []
  values.forEach((v, i) => {
    if (v === null || !Number.isFinite(v)) {
      if (cur.length > 1) segments.push(cur.join(' '))
      cur = []
      return
    }
    const x = i * step
    const y = H - ((v - min) / span) * (H - 2) - 1
    cur.push(`${x.toFixed(1)},${y.toFixed(1)}`)
  })
  if (cur.length > 1) segments.push(cur.join(' '))

  const last = values[values.length - 1]
  const lastY =
    last !== null && Number.isFinite(last) ? H - ((last - min) / span) * (H - 2) - 1 : null

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className={className} preserveAspectRatio="none" aria-hidden="true">
      {segments.map((s, i) => (
        <polyline
          key={i}
          points={s}
          fill="none"
          stroke="currentColor"
          strokeWidth="1.25"
          strokeLinejoin="round"
          strokeLinecap="round"
          className="text-ink-tertiary opacity-70"
        />
      ))}
      {lastY !== null ? <circle cx={W} cy={lastY} r="1.6" className="fill-accent" /> : null}
    </svg>
  )
}

/** 把 events 归一化成告警条能吃的行。 */
export function eventsToAlerts(
  events: EventItem[],
  serverName: (id: string | null) => string | undefined,
): AlertRow[] {
  const rank = { critical: 0, warning: 1, info: 2 } as const
  return events
    .filter((e) => !e.acknowledged)
    .map((e) => ({
      key: `ev-${e.id}`,
      level: (e.level === 'critical' || e.level === 'warning' ? e.level : 'info') as
        | 'critical'
        | 'warning'
        | 'info',
      title: e.title,
      detail: e.detail ?? undefined,
      source: serverName(e.server_id),
    }))
    .sort((a, b) => rank[a.level] - rank[b.level])
}

/** 从指标历史里取某个字段的百分比序列,供迷你曲线使用。 */
export function pctSeries(
  history: Array<{ mem_used_mb?: number | null; mem_total_mb?: number | null; disk_used_gb?: number | null; disk_total_gb?: number | null; swap_used_mb?: number | null; swap_total_mb?: number | null; cpu_percent?: number | null }>,
  kind: 'cpu' | 'mem' | 'disk' | 'swap',
): Array<number | null> {
  return history.map((m) => {
    if (kind === 'cpu') return m.cpu_percent ?? null
    if (kind === 'mem') return ratio(m.mem_used_mb, m.mem_total_mb)
    if (kind === 'disk') return ratio(m.disk_used_gb, m.disk_total_gb)
    return ratio(m.swap_used_mb, m.swap_total_mb)
  })
}

/** 首尾差值(百分点)。历史不足两个有效点时返回 null。 */
export function seriesDelta(values: Array<number | null>): number | null {
  const pts = values.filter((v): v is number => v !== null && Number.isFinite(v))
  if (pts.length < 2) return null
  return pts[pts.length - 1] - pts[0]
}
