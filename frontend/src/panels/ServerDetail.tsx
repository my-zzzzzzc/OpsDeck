import {
  ArrowLeft,
  Cpu,
  Globe,
  HardDrive,
  MemoryStick,
  Monitor,
  RefreshCw,
  Settings2,
  Terminal as TerminalIcon,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'

import { api, type Metric, type Server } from '../api'
import {
  ChartCard,
  ChartLegend,
  ChartTimeSelect,
  CHART_TIMES,
  MetricAreaChart,
  MetricLineChart,
  SERIES_COLOR,
  type ChartPoint,
  type ChartTime,
} from '../charts'
import { cn } from '../cn'
import { GhostButton, PrimaryButton } from '../ui'

/**
 * 服务器详情页。
 *
 * **一比一还原 Beszel 的 system detail**,对应源码:
 *   internal/site/src/components/routes/system.tsx  —— 页面骨架与图表顺序
 *   internal/site/src/components/routes/system/info-bar.tsx —— 顶部信息条
 *   internal/site/src/components/routes/system/charts/*.tsx —— 每张图的取值与配色
 *
 * Beszel 的 defaultLayout 顺序是:
 *   CPU → [Docker CPU] → 内存 → [Docker 内存] → 根分区 → [磁盘 IO] → [带宽]
 *   → [Docker 网络] → Swap → 负载 → [温度] → [风扇] → [电池] → [WiFi] → [GPU]
 * 方括号里的 OpsDeck 采集端没有上报(collector 只给 CPU/内存/Swap/磁盘/负载),
 * 按"没有的图就不要"直接不渲染 —— 不留占位、也不用别的指标去凑。
 * 剩下的 5 张,顺序与 Beszel 完全一致。
 *
 * 取色也照 Beszel:CPU=1 蓝、内存=2 绿、根分区=4 紫、Swap=2 绿;
 * 负载是三条折线,用 Beszel 硬编码的紫/蓝/橙。
 */

/** 与 Beszel 一致:各档位的数据点数量(对应它的桶宽 1m / 10m / 20m / 120m / 480m)。 */
const POINTS: Record<ChartTime, number> = { '1h': 60, '12h': 72, '24h': 96, '7d': 84, '30d': 90 }

/** 图表配色。定义在 charts.tsx,首页与详情页共用同一份,避免两页对不上号。 */
const C = SERIES_COLOR

/** 负载的三条线。Beszel 在 load-average-chart.tsx 里直接写死了这三个色值。 */
const LOAD_SERIES = [
  { key: 'load_1', label: '1 分钟', color: 'hsl(271, 81%, 60%)' },
  { key: 'load_5', label: '5 分钟', color: 'hsl(217, 91%, 60%)' },
  { key: 'load_15', label: '15 分钟', color: 'hsl(25, 95%, 53%)' },
] as const

/** 去掉多余的小数位:25.00 → 25。Beszel 的 toFixedFloat 就是这个行为。 */
const trim = (v: number, d = 2) => String(Number(v.toFixed(d)))

/** 容量刻度:统一一位小数,与参考稿的 73.4GB / 60.4GB 观感一致。 */
const gbTick = (v: number) => `${v.toFixed(1)} GB`
const gbValue = (v: number) => `${v.toFixed(1)} GB`

/** 把后端返回的原始指标点转换成图表可用的形状。 */
function toChartPoints(metrics: Metric[]): ChartPoint[] {
  return metrics.map((m) => ({
    // 数值时间轴靠这个字段定位,必须是毫秒数而不是格式化后的字符串
    created: new Date(m.captured_at).getTime(),
    cpu_percent: m.cpu_percent,
    // 后端给的是 MB,统一换算成 GB —— Beszel 的内存/磁盘/Swap 图都是 GB 绝对值
    mem_gb: m.mem_used_mb != null ? m.mem_used_mb / 1024 : null,
    swap_gb: m.swap_used_mb != null ? m.swap_used_mb / 1024 : null,
    disk_gb: m.disk_used_gb,
    load_1: m.load_1,
    load_5: m.load_5,
    load_15: m.load_15,
  }))
}

export function ServerDetail({
  server,
  onBack,
  onOpenTerminal,
}: {
  server: Server
  onBack: () => void
  onOpenTerminal: () => void
}) {
  const [metrics, setMetrics] = useState<Metric[]>([])
  const [time, setTime] = useState<ChartTime>('1h')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [grid, setGrid] = useState(true)
  const [menuOpen, setMenuOpen] = useState(false)

  const load = useCallback(async () => {
    try {
      setMetrics(await api.metricHistory(server.id, CHART_TIMES[time].hours, POINTS[time]))
      setError(null)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setLoading(false)
    }
  }, [server.id, time])

  useEffect(() => {
    setLoading(true)
    void load()
    // 只在使用较短时间范围时轮询,长时间范围没必要频繁刷新
    if (time === '1h' || time === '12h') {
      const timer = setInterval(() => void load(), 15_000)
      return () => clearInterval(timer)
    }
  }, [load, time])

  const points = useMemo(() => toChartPoints(metrics), [metrics])
  const latest = metrics.at(-1)

  const memTotalGb = latest?.mem_total_mb != null ? latest.mem_total_mb / 1024 : null
  const diskTotalGb = latest?.disk_total_gb ?? null
  const swapTotalGb = latest?.swap_total_mb != null ? latest.swap_total_mb / 1024 : null

  // Beszel 的 SwapChart 在 swap 为 0 时直接 return null —— 没开交换分区就整张卡不出现
  const hasSwap = (latest?.swap_total_mb ?? 0) > 0

  const online = server.status === 'online'

  // 顶部信息条的内容项。Beszel 用「图标 + 值」并用竖线分隔,不是「·」。
  const chips: Array<{ key: string; icon: React.ReactNode; value: string }> = []
  if (server.ip) chips.push({ key: 'ip', icon: <Globe className="size-4" />, value: server.ip })
  if (server.hostname && server.hostname !== server.ip) {
    chips.push({ key: 'host', icon: <Monitor className="size-4" />, value: server.hostname })
  }
  if (server.os_info) {
    chips.push({ key: 'os', icon: <HardDrive className="size-4" />, value: server.os_info })
  }
  if (server.cpu_cores) {
    chips.push({ key: 'cpu', icon: <Cpu className="size-4" />, value: `${server.cpu_cores} 核` })
  }
  if (server.mem_total_mb) {
    chips.push({
      key: 'mem',
      icon: <MemoryStick className="size-4" />,
      value: `${(server.mem_total_mb / 1024).toFixed(1)} GB`,
    })
  }

  const gridCls = grid ? 'grid xl:grid-cols-2 gap-4' : 'grid gap-4'

  return (
    <div className="grid gap-4">
      {/* 顶部信息条 —— 照 Beszel 的 InfoBar,整块包在一张卡片里 */}
      <div className="rounded-lg border border-line bg-primary">
        <div className="grid gap-3 px-4 pt-3 pb-5 sm:px-6 sm:pt-4 xl:flex xl:gap-4">
          <div className="min-w-0">
            <button
              type="button"
              onClick={onBack}
              className="mb-1.5 flex cursor-pointer items-center gap-1 text-[12px] text-ink-tertiary transition-colors hover:text-ink"
            >
              <ArrowLeft size={13} />
              返回
            </button>
            <h1 className="mb-1.5 text-2xl font-semibold text-ink sm:text-[1.6rem]">{server.name}</h1>

            <div className="flex flex-wrap items-center gap-3 text-sm text-ink-secondary">
              <span className="flex items-center gap-2">
                <span className="relative flex size-3">
                  {online ? (
                    <span
                      className="absolute inline-flex size-full animate-ping rounded-full bg-ink-success opacity-75"
                      style={{ animationDuration: '1.5s' }}
                    />
                  ) : null}
                  <span
                    className={cn(
                      'relative inline-flex size-3 rounded-full',
                      online ? 'bg-ink-success' : 'bg-ink-danger',
                    )}
                  />
                </span>
                {online ? '在线' : '离线'}
              </span>

              {chips.map((c) => (
                <span key={c.key} className="flex items-center gap-3">
                  <span className="h-4 w-px bg-overlay-medium" aria-hidden />
                  <span className="flex items-center gap-1.5">
                    {c.icon}
                    {c.value}
                  </span>
                </span>
              ))}
            </div>
          </div>

          <div className="flex items-center gap-2 xl:ms-auto">
            <ChartTimeSelect value={time} onChange={setTime} className="w-full xl:w-40" />

            <div className="relative">
              <button
                type="button"
                aria-label="图表设置"
                onClick={() => setMenuOpen((o) => !o)}
                className="flex size-9 cursor-pointer items-center justify-center rounded-md border border-line bg-primary text-ink-secondary transition-colors hover:bg-overlay-light"
              >
                <Settings2 className="size-4 opacity-90" />
              </button>
              {menuOpen ? (
                <>
                  <div className="fixed inset-0 z-40" onClick={() => setMenuOpen(false)} aria-hidden />
                  <div className="absolute end-0 top-full z-50 mt-1 min-w-40 rounded-md border border-line bg-primary p-1 shadow-lg">
                    <div className="px-2.5 py-1.5 text-[11px] font-medium tracking-wider text-ink-tertiary uppercase">
                      图表宽度
                    </div>
                    {[
                      { value: true, label: '双列' },
                      { value: false, label: '单列' },
                    ].map((o) => (
                      <button
                        key={o.label}
                        type="button"
                        onClick={() => {
                          setGrid(o.value)
                          setMenuOpen(false)
                        }}
                        className={cn(
                          'flex w-full cursor-pointer items-center gap-2 rounded-sm px-2.5 py-1.5 text-left text-[13px] transition-colors',
                          grid === o.value ? 'bg-overlay-light text-ink' : 'text-ink-secondary hover:bg-overlay-lighter',
                        )}
                      >
                        <span
                          className={cn(
                            'inline-block size-1.5 rounded-full',
                            grid === o.value ? 'bg-accent' : 'bg-transparent',
                          )}
                        />
                        {o.label}
                      </button>
                    ))}
                  </div>
                </>
              ) : null}
            </div>

            <GhostButton onClick={() => void load()}>
              <span className="flex items-center gap-1">
                <RefreshCw size={11} />
                刷新
              </span>
            </GhostButton>
            {server.terminal_enabled ? (
              <PrimaryButton onClick={onOpenTerminal}>
                <span className="flex items-center gap-1">
                  <TerminalIcon size={12} />
                  终端
                </span>
              </PrimaryButton>
            ) : null}
          </div>
        </div>
      </div>

      {error ? (
        <p className="rounded-md bg-tint-danger px-3 py-2 text-[12px] text-ink-danger">{error}</p>
      ) : null}

      {loading ? (
        <div className={gridCls}>
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="h-72 animate-pulse rounded-lg border border-line bg-primary" />
          ))}
        </div>
      ) : (
        /* 图表墙。顺序 = Beszel 的 defaultLayout 去掉没有数据源的图。 */
        <div className={gridCls}>
          <ChartCard title="CPU 使用率" description="整机 CPU 平均利用率">
            <MetricAreaChart
              data={points}
              time={time}
              domain={[0, 100]}
              series={[{ key: 'cpu_percent', label: 'CPU', color: C.cpu, opacity: 0.4 }]}
              tickFormatter={(v) => `${trim(v, 2)}%`}
              valueFormatter={(v) => `${trim(v, 2)}%`}
            />
          </ChartCard>

          <ChartCard title="内存使用率" description="记录时刻的精确占用">
            <MetricAreaChart
              data={points}
              time={time}
              domain={[0, memTotalGb ?? 'auto']}
              series={[{ key: 'mem_gb', label: '已用', color: C.mem, opacity: 0.4 }]}
              tickFormatter={gbTick}
              valueFormatter={gbValue}
            />
          </ChartCard>

          <ChartCard title="根分区使用率" description="根分区的磁盘占用">
            <MetricAreaChart
              data={points}
              time={time}
              domain={[0, diskTotalGb ?? 'auto']}
              series={[{ key: 'disk_gb', label: '已用', color: C.disk, opacity: 0.4 }]}
              tickFormatter={gbTick}
              valueFormatter={gbValue}
            />
          </ChartCard>

          {hasSwap ? (
            <ChartCard title="Swap 使用率" description="系统使用的交换空间">
              <MetricAreaChart
                data={points}
                time={time}
                domain={[0, swapTotalGb ?? 'auto']}
                series={[{ key: 'swap_gb', label: '已用', color: C.mem, opacity: 0.4 }]}
                tickFormatter={gbTick}
                valueFormatter={gbValue}
              />
            </ChartCard>
          ) : null}

          {/* 负载用折线而不是面积图:三条面积叠起来会互相糊住 */}
          <ChartCard
            title="系统负载"
            description="系统平均负载随时间变化"
            legend={<ChartLegend items={LOAD_SERIES.map((s) => ({ label: s.label, color: s.color }))} />}
          >
            <MetricLineChart
              data={points}
              time={time}
              series={LOAD_SERIES.map((s) => ({ key: s.key, label: s.label, color: s.color }))}
              tickFormatter={(v) => trim(v, 2)}
              valueFormatter={(v) => trim(v, 2)}
            />
          </ChartCard>
        </div>
      )}
    </div>
  )
}
