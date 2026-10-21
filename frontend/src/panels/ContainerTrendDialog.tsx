import { X } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'

import { api, type ContainerMetricPoint, type InstanceDetail } from '../api'
import { CHART_TIMES, MetricAreaChart, SERIES_COLOR, type ChartPoint, type ChartSeries, type ChartTime } from '../charts'
import { cn } from '../cn'

type MetricKey = 'cpu' | 'mem' | 'net' | 'io'
type RangeKey = '1h' | '12h' | '24h'

const RANGES: Array<{ key: RangeKey; label: string; hours: number }> = [
  { key: '1h', label: '1 小时', hours: 1 },
  { key: '12h', label: '12 小时', hours: 12 },
  { key: '24h', label: '24 小时', hours: 24 },
]

const METRICS: Array<{ key: MetricKey; label: string }> = [
  { key: 'cpu', label: 'CPU' },
  { key: 'mem', label: '内存' },
  { key: 'net', label: '网络' },
  { key: 'io', label: '磁盘 IO' },
]

const NET_RX = 'var(--chart-1, hsl(220 70% 50%))'
const NET_TX = 'var(--chart-3, hsl(30 80% 55%))'
const IO_READ = 'var(--chart-4, hsl(280 65% 60%))'
const IO_WRITE = 'var(--chart-5, hsl(340 75% 55%))'

const SERIES: Record<MetricKey, ChartSeries[]> = {
  cpu: [{ key: 'cpu', label: 'CPU', color: SERIES_COLOR.cpu }],
  mem: [{ key: 'mem', label: '内存', color: SERIES_COLOR.mem }],
  net: [
    { key: 'rx', label: '接收', color: NET_RX },
    { key: 'tx', label: '发送', color: NET_TX },
  ],
  io: [
    { key: 'read', label: '读取', color: IO_READ },
    { key: 'write', label: '写入', color: IO_WRITE },
  ],
}

function rate(value: number): string {
  if (value >= 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB/s`
  if (value >= 1024) return `${(value / 1024).toFixed(1)} KB/s`
  return `${Math.round(value)} B/s`
}

function rateTick(value: number): string {
  if (value >= 1024 * 1024) return `${(value / 1024 / 1024).toFixed(0)}M`
  if (value >= 1024) return `${(value / 1024).toFixed(0)}K`
  return String(Math.round(value))
}

function buildData(rows: ContainerMetricPoint[], metric: MetricKey): ChartPoint[] {
  const data: ChartPoint[] = []
  for (const row of rows) {
    const created = Date.parse(row.captured_at)
    if (!Number.isFinite(created)) continue
    if (metric === 'cpu') data.push({ created, cpu: row.cpu_percent })
    else if (metric === 'mem') data.push({ created, mem: row.mem_used_mb })
    else if (metric === 'net') data.push({ created, rx: row.net_rx_bps, tx: row.net_tx_bps })
    else data.push({ created, read: row.block_read_bps, write: row.block_write_bps })
  }
  return data
}

/** 单容器资源趋势。数据由采集器按上报间隔写入,这里只看一个容器。 */
export function ContainerTrendDialog({ container, onClose }: { container: InstanceDetail; onClose: () => void }) {
  const [range, setRange] = useState<RangeKey>('1h')
  const [metric, setMetric] = useState<MetricKey>('cpu')
  const [rows, setRows] = useState<ContainerMetricPoint[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  useEffect(() => {
    let active = true
    const hours = RANGES.find((item) => item.key === range)?.hours ?? 1

    const load = async () => {
      try {
        const points = await api.containerMetrics(container.id, hours, 60)
        if (!active) return
        setRows(points)
        setError(null)
      } catch (err) {
        if (active) setError((err as Error).message)
      } finally {
        if (active) setLoading(false)
      }
    }

    setLoading(true)
    void load()
    const timer = setInterval(() => void load(), 30_000)
    return () => {
      active = false
      clearInterval(timer)
    }
  }, [container.id, range])

  const data = useMemo(() => buildData(rows, metric), [rows, metric])
  const series = SERIES[metric]
  const isRate = metric === 'net' || metric === 'io'
  const unit = metric === 'cpu' ? '整机占比' : metric === 'mem' ? 'MB' : '字节/秒'

  return (
    <div
      className="fixed inset-0 z-50 bg-black/60"
      role="presentation"
      onClick={(event) => { event.stopPropagation(); onClose() }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`${container.name} 资源趋势`}
        onClick={(event) => event.stopPropagation()}
        style={{ width: 'min(90vw, 820px)' }}
        className="absolute left-1/2 top-1/2 max-h-[92vh] min-w-[22rem] max-w-[96vw] -translate-x-1/2 -translate-y-1/2 overflow-hidden rounded-lg border border-line bg-primary shadow-2xl"
      >
        <header className="flex items-start gap-2 border-b border-line px-4 py-2.5">
          <div className="min-w-0 flex-1">
            <h2 className="mono truncate text-[13px] font-semibold text-ink">{container.name} · 资源趋势</h2>
            <p className="truncate text-[10px] text-ink-tertiary">
              {container.project_name ?? '未归属项目'} · {container.server_name ?? '未知服务器'} · {unit}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            title="关闭"
            className="flex size-7 cursor-pointer items-center justify-center rounded-md text-ink-tertiary hover:bg-overlay-light hover:text-ink"
          >
            <X className="size-4" />
          </button>
        </header>

        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-4 py-2">
          <div className="flex flex-wrap items-center gap-0.5">
            {METRICS.map((item) => {
              const active = metric === item.key
              return (
                <button
                  key={item.key}
                  type="button"
                  onClick={() => setMetric(item.key)}
                  aria-pressed={active}
                  className={cn(
                    'h-6 cursor-pointer rounded-sm px-2 text-[10.5px] transition-colors',
                    active ? 'bg-overlay-light font-medium text-ink' : 'text-ink-tertiary hover:text-ink-secondary',
                  )}
                >
                  {item.label}
                </button>
              )
            })}
          </div>
          <div className="flex items-center gap-0.5">
            {RANGES.map((item) => {
              const active = range === item.key
              return (
                <button
                  key={item.key}
                  type="button"
                  onClick={() => setRange(item.key)}
                  aria-pressed={active}
                  className={cn(
                    'h-6 cursor-pointer rounded-sm px-2 text-[10.5px] transition-colors',
                    active ? 'bg-overlay-light font-medium text-ink' : 'text-ink-tertiary hover:text-ink-secondary',
                  )}
                >
                  {item.label}
                </button>
              )
            })}
          </div>
        </div>

        <div className="px-4 pt-2 pb-4">
          {error ? (
            <div className="flex h-56 items-center justify-center text-[12px] text-ink-danger">趋势加载失败：{error}</div>
          ) : loading && rows.length === 0 ? (
            <div className="flex h-56 items-center justify-center text-[12px] text-ink-tertiary">正在加载趋势…</div>
          ) : (
            <div className="h-56">
              <MetricAreaChart
                key={`${metric}-${range}`}
                data={data}
                time={range as ChartTime}
                series={series}
                domain={metric === 'cpu' ? [0, 100] : [0, 'auto']}
                tickFormatter={isRate ? rateTick : metric === 'cpu' ? (value) => `${Math.round(value)}%` : (value) => `${Math.round(value)}`}
                valueFormatter={(value) => isRate ? rate(value) : metric === 'cpu' ? `${Math.round(value)}%` : `${Math.round(value)} MB`}
                gradient
                strokeWidth={1.5}
              />
            </div>
          )}

          {rows.length > 0 && !error ? (
            <div className="mt-2 flex flex-wrap items-center justify-between gap-2 border-t border-line pt-2">
              <div className="flex flex-wrap items-center gap-3 text-[10.5px] text-ink-tertiary">
                {series.map((item) => (
                  <span key={item.key} className="flex items-center gap-1">
                    <i className="size-1.5 rounded-full" style={{ background: item.color }} />
                    {item.label}
                  </span>
                ))}
              </div>
              <span className="text-[10px] text-ink-tertiary">
                采集器每 30 秒采样 · 时间档位 {CHART_TIMES[range as ChartTime].label}
              </span>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  )
}
