import { History } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Area,
  AreaChart,
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'

import { cn } from './cn'

/*
 * 图表组件。
 *
 * 这一版是**照着 Beszel 的源码一比一还原**的,不是"参考风格"。对应文件:
 *   internal/site/src/components/charts/area-chart.tsx   —— 面积图
 *   internal/site/src/components/charts/line-chart.tsx   —— 折线图
 *   internal/site/src/components/routes/system/chart-card.tsx —— 卡片外壳
 *   internal/site/src/components/ui/chart.tsx            —— fixedDomainTicks / xAxis
 *   internal/site/src/index.css                          —— --chart-1..5
 *
 * 逐条对齐的关键细节(括号内是 Beszel 原值):
 *   - chartMargin = { top: 12, right: 5 }       只有 top/right,left/bottom 走 recharts 默认 5
 *   - 面积是**平涂** fill + fillOpacity,不是渐变 —— 原来那版用了 linearGradient,是错的
 *   - type="monotoneX" / isAnimationActive={false}(指标定时刷新,开动画会持续闪烁)
 *   - CartesianGrid vertical={false} 且**不传 stroke**,用 recharts 默认色
 *   - Y 轴 ticks 走 fixedDomainTicks:min===0 且 max 有限时固定取 [0, max/4, max/2, 3max/4, max]
 *   - X 轴是**数值时间轴**(type="number" scale="time" + 显式 ticks),不是按数据点均分的类目轴
 *   - Y 轴宽度实测后再显形(opacity-0 → opacity-100),避免轴宽跳变
 *   - 卡片标题 1.4rem / sm:2xl 加粗 —— 这是"像不像"的最大变量,之前写成 13px 完全不对
 *   - 图表区高度 h-48 md:h-52,带图例时 h-54 md:h-56
 */

/** 时间档位。数值取自 Beszel 的 chartTimeData。 */
export const CHART_TIMES = {
  '1h': { label: '1 小时', hours: 1, spanMs: 3_600_000, ticks: 12, expectedInterval: 60_000, day: false },
  '12h': { label: '12 小时', hours: 12, spanMs: 43_200_000, ticks: 12, expectedInterval: 600_000, day: false },
  '24h': { label: '24 小时', hours: 24, spanMs: 86_400_000, ticks: 12, expectedInterval: 1_200_000, day: false },
  '7d': { label: '7 天', hours: 168, spanMs: 604_800_000, ticks: 7, expectedInterval: 7_200_000, day: true },
  '30d': { label: '30 天', hours: 720, spanMs: 2_592_000_000, ticks: 30, expectedInterval: 28_800_000, day: true },
} as const

export type ChartTime = keyof typeof CHART_TIMES

/** 与 Beszel 完全一致:只给 top / right。 */
const CHART_MARGIN = { top: 12, right: 5 }

/**
 * 图表外层的工具类。
 *
 * 对应 Beszel `components/ui/chart.tsx` 里 ChartContainer 的那串
 * `[&_.recharts-...]:` 选择器,只保留 OpsDeck 用得到的三条:
 *
 *   - `text-xs`        刻度字号。recharts 的 Text 不给 fontSize,靠继承 —— 所以
 *                      量宽用的 div 也必须是 text-xs,否则轴宽算不准。
 *   - `axis-tick_text` 刻度文字颜色。recharts 默认写死 fill="#808080",
 *                      只有 CSS 规则能盖掉它(SVG 呈现属性优先级低于 CSS)。
 *   - `cartesian-grid_line` 网格线。Beszel 走 CSS 而不是给 CartesianGrid 传
 *                      stroke,所以不传 stroke 才是对的,但要给颜色。
 */
const CHART_SURFACE_CLS =
  'text-xs [&_.recharts-cartesian-axis-tick_text]:fill-ink-tertiary [&_.recharts-cartesian-grid_line]:stroke-line/50 [&_.recharts-surface]:outline-hidden'

/**
 * 指标曲线的配色。
 *
 * 编号与 Beszel 的 `--chart-N` 一一对应:CPU=1 蓝、内存=2 绿、磁盘=4 紫。
 *
 * 这是**分类色** —— 只表示"这是哪条线",不表示好坏。所以刻意不复用
 * `--t-ink-success` / `-warning` / `-danger`:混进来之后,一条紫色的磁盘线
 * 会被读成"磁盘有问题"。
 *
 * 定在这里而不是各页各写一份:同一个指标在服务器详情页和首页换了颜色,
 * 读者就得重新学一遍"这个绿是不是那个绿"。
 */
export const SERIES_COLOR = {
  cpu: 'var(--chart-1, hsl(220 70% 50%))',
  mem: 'var(--chart-2, hsl(160 60% 45%))',
  disk: 'var(--chart-4, hsl(280 65% 60%))',
} as const

/** 一个图表数据点。`created` 是毫秒时间戳 —— 数值时间轴靠它定位。 */
export type ChartPoint = Record<string, number | null>

/**
 * 固定刻度。照抄 Beszel 的 fixedDomainTicks:
 * 只有 domain 形如 [0, 有限正数] 时才给固定刻度,否则交回 recharts 自动算。
 *
 * 这就是参考图里 Y 轴恒为 0 / 25 / 50 / 75 / 100% 的原因 ——
 * domain 给 [0,100] 时它正好四等分。
 */
export function fixedDomainTicks(domain?: readonly [number, number | 'auto']): number[] | undefined {
  if (!Array.isArray(domain)) return undefined
  const [min, max] = domain
  if (min !== 0 || typeof max !== 'number' || !(max > 0) || !Number.isFinite(max)) {
    return undefined
  }
  return [0, 1, 2, 3, 4].map((i) => (max * i) / 4)
}

/** 刻度候选间隔,按"整点/整分"对齐用。 */
const TICK_STEPS = [
  60_000, 120_000, 300_000, 600_000, 900_000, 1_800_000, 3_600_000, 7_200_000, 10_800_000, 21_600_000,
  43_200_000, 86_400_000, 172_800_000, 604_800_000, 1_209_600_000,
]

/**
 * 生成对齐到"整间隔"的时间刻度。
 *
 * 不能简单地 start + i*(span/n):那样刻度会落在 22:47 这种数上,
 * 而参考图里全是 4:00 / 4:10 这种整点刻度。
 */
function timeTicks(start: number, end: number, count: number): number[] {
  const span = end - start
  if (!(span > 0) || count < 2) return []
  const raw = span / count
  const step = TICK_STEPS.find((s) => s >= raw) ?? TICK_STEPS[TICK_STEPS.length - 1]
  const first = Math.ceil(start / step) * step
  const out: number[] = []
  for (let t = first; t <= end; t += step) out.push(t)
  return out
}

/** X 轴刻度文本:短跨度显示时分,长跨度显示月/日。 */
function formatAxisTime(ts: number, day: boolean): string {
  const d = new Date(ts)
  const p = (n: number) => String(n).padStart(2, '0')
  return day ? `${p(d.getMonth() + 1)}/${p(d.getDate())}` : `${p(d.getHours())}:${p(d.getMinutes())}`
}

function formatTooltipTime(ts: number, day: boolean): string {
  const d = new Date(ts)
  const p = (n: number) => String(n).padStart(2, '0')
  const hm = `${p(d.getHours())}:${p(d.getMinutes())}`
  return day ? `${p(d.getMonth() + 1)}/${p(d.getDate())} ${hm}` : hm
}

/**
 * Y 轴宽度自适应 —— 与 Beszel `components/charts/hooks.ts` 的 useYAxisWidth 同构。
 *
 * 这段踩过两个坑,两个都不能省:
 *
 *  1. **量的必须是「离屏 div 里的裸文本」,不能量已渲染的刻度。**
 *     recharts 会把超出轴宽的刻度文字折成多行,量一个已经被折行的
 *     "3.2 GB" 只会得到半行宽 → 轴还是不够宽 → 永远折行。所以这里临时
 *     造一个 div 量文本的**固有宽度**。div 同时带 `table` 和 `sr-only`:
 *     sr-only 把它压到 1px 并移出视口,而 CSS 表格在 auto 布局下会
 *     撑到内容的最小宽度,offsetWidth 正好是文本真实宽度。
 *
 *  2. **setState 必须推迟到 render 之外。**
 *     这个函数是在 tickFormatter 里被调用的,也就是 render 期间。
 *     直接 setState 会触发 React 的
 *     "Cannot update a component while rendering a different component" 警告,
 *     所以套一层 setTimeout。宽度只增不减,避免来回抖动。
 *
 * 量宽用的字体必须和 YAxis 的 tick 一致,否则算出来的宽度对不上。
 */
function useYAxisWidth() {
  const [yAxisWidth, setYAxisWidth] = useState(0)
  const widest = useRef(0)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  const updateYAxisWidth = (str: string) => {
    if (str.length >= widest.current) {
      widest.current = str.length
      clearTimeout(timer.current)
      timer.current = setTimeout(() => {
        const div = document.createElement('div')
        div.className = 'table sr-only text-xs tabular-nums tracking-tighter'
        div.textContent = str
        document.body.appendChild(div)
        const width = div.offsetWidth + 20
        document.body.removeChild(div)
        setYAxisWidth((prev) => (width > prev ? width : prev))
      })
    }
    return str
  }

  useEffect(() => () => clearTimeout(timer.current), [])

  return { yAxisWidth, updateYAxisWidth }
}

/** 图表容器。离屏时冻结更新,减少无谓重绘。 */
function useVisibility() {
  const ref = useRef<HTMLDivElement>(null)
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const observer = new IntersectionObserver(([entry]) => setVisible(entry.isIntersecting), { threshold: 0 })
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  return { ref, visible }
}

/**
 * X 轴的时间域与刻度。
 *
 * 终点取「最后一个数据点」和「当前时间减去半个采样间隔」里更大的那个 ——
 * 后者让轴一直顶到"现在",而不是停在最后一次采集,采集延迟时图上不会多出一段空白。
 */
function useTimeAxis(data: ChartPoint[], time: ChartTime) {
  const cfg = CHART_TIMES[time]
  const last = data.length ? Number(data[data.length - 1]?.created ?? 0) : 0

  return useMemo(() => {
    const end = Math.max(last, Date.now() - cfg.expectedInterval / 2)
    const start = end - cfg.spanMs
    return {
      domain: [start, end] as [number, number],
      ticks: timeTicks(start, end, cfg.ticks),
    }
  }, [last, cfg.spanMs, cfg.ticks, cfg.expectedInterval])
}

export interface ChartSeries {
  /** 数据字段名 */
  key: string
  /** 图例与 tooltip 显示名 */
  label: string
  /** CSS 颜色 */
  color: string
  /** 填充透明度,Beszel 默认 0.4 */
  opacity?: number
}

interface TooltipItem {
  name?: string
  value?: number
  color?: string
  dataKey?: string | number
}

/** 自定义 tooltip。照 Beszel 的 ChartTooltipContent:时间行 + 色块/名称/值。 */
function ChartTooltipInner({
  active,
  payload,
  label,
  formatter,
  time,
}: {
  active?: boolean
  payload?: TooltipItem[]
  label?: number | string
  formatter?: (value: number, key: string) => string
  time: ChartTime
}) {
  if (!active || !payload?.length) return null
  const day = CHART_TIMES[time].day

  return (
    <div className="min-w-[9rem] rounded-md border border-line bg-primary px-2.5 py-1.5 shadow-md">
      <div className="mb-1 text-[11px] text-ink-tertiary tabular-nums">
        {formatTooltipTime(Number(label), day)}
      </div>
      <div className="flex flex-col gap-0.5">
        {payload.map((p) => (
          <div key={String(p.dataKey)} className="flex items-center gap-2 text-[12px]">
            <span
              className="inline-block size-2 shrink-0 rounded-[2px]"
              style={{ background: p.color }}
              aria-hidden
            />
            <span className="truncate text-ink-secondary">{p.name}</span>
            <span className="ms-auto ps-3 tabular-nums text-ink">
              {formatter ? formatter(Number(p.value), String(p.dataKey)) : String(p.value)}
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}

/**
 * 面积图。
 *
 * 用于 CPU / 内存 / 磁盘 / Swap 这类随时间变化的指标。
 * 父容器必须给定高度(卡片里是 h-48 md:h-52)。
 */
export function MetricAreaChart({
  data,
  time,
  series,
  domain,
  tickFormatter,
  valueFormatter,
}: {
  data: ChartPoint[]
  time: ChartTime
  series: ChartSeries[]
  domain?: readonly [number, number | 'auto']
  tickFormatter?: (value: number) => string
  valueFormatter?: (value: number, key: string) => string
}) {
  const { ref, visible } = useVisibility()
  const { yAxisWidth, updateYAxisWidth } = useYAxisWidth()
  const [frozen, setFrozen] = useState(data)

  useEffect(() => {
    if (visible || frozen.length === 0) setFrozen(data)
  }, [visible, data, frozen.length])

  // 全空序列当作「暂无数据」——后端在空桶里返回 null 而不是 0,
  // 画出来会是一条贴底的假线。
  const hasValues = useMemo(
    () => frozen.some((d) => series.some((s) => typeof d[s.key] === 'number' && d[s.key] !== null)),
    [frozen, series],
  )

  const { domain: xDomain, ticks: xTicks } = useTimeAxis(frozen, time)
  const day = CHART_TIMES[time].day
  const fmt = tickFormatter ?? ((v: number) => String(v))

  if (frozen.length === 0 || !hasValues) {
    return (
      <div
        ref={ref}
        className="flex h-full items-center justify-center text-[13px] text-ink-tertiary"
      >
        暂无数据
      </div>
    )
  }

  return (
    <div
      ref={ref}
      className={cn(
        'h-full w-full transition-opacity',
        CHART_SURFACE_CLS,
        yAxisWidth ? 'opacity-100' : 'opacity-0',
      )}
    >
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={frozen} margin={CHART_MARGIN} accessibilityLayer>
          {/* 不传 stroke:颜色由外层 CHART_SURFACE_CLS 的 CSS 选择器给,和 Beszel 一致 */}
          <CartesianGrid vertical={false} />

          <YAxis
            direction="ltr"
            orientation="left"
            width={yAxisWidth}
            domain={domain ?? [0, 'auto']}
            ticks={fixedDomainTicks(domain)}
            tickFormatter={(v) => updateYAxisWidth(fmt(Number(v)))}
            tickLine={false}
            axisLine={false}
            className="tracking-tighter"
          />

          <XAxis
            dataKey="created"
            domain={xDomain}
            ticks={xTicks}
            allowDataOverflow
            type="number"
            scale="time"
            minTickGap={12}
            tickMargin={8}
            tickLine={false}
            axisLine={false}
            tickFormatter={(v) => formatAxisTime(Number(v), day)}
          />

          <Tooltip
            cursor={{ stroke: 'var(--t-font-color-tertiary)', strokeOpacity: 0.3 }}
            content={<ChartTooltipInner formatter={valueFormatter} time={time} /> as never}
          />

          {series.map((s) => (
            <Area
              key={s.key}
              type="monotoneX"
              dataKey={s.key}
              name={s.label}
              fill={s.color}
              fillOpacity={s.opacity ?? 0.4}
              stroke={s.color}
              strokeWidth={1}
              // 关闭动画:指标每 15 秒刷新一次,动画会导致持续闪烁
              isAnimationActive={false}
              activeDot={{ r: 3, strokeWidth: 0 }}
            />
          ))}
        </AreaChart>
      </ResponsiveContainer>
    </div>
  )
}

/**
 * 折线图。
 *
 * 用于「多条线要逐条比较」的场景 —— Beszel 的 Load Average 用的就是这个
 * (1 / 5 / 15 分钟三条线),面积图叠三条会互相糊住。
 */
export function MetricLineChart({
  data,
  time,
  series,
  domain,
  tickFormatter,
  valueFormatter,
}: {
  data: ChartPoint[]
  time: ChartTime
  series: ChartSeries[]
  domain?: readonly [number, number | 'auto']
  tickFormatter?: (value: number) => string
  valueFormatter?: (value: number, key: string) => string
}) {
  const { ref, visible } = useVisibility()
  const { yAxisWidth, updateYAxisWidth } = useYAxisWidth()
  const [frozen, setFrozen] = useState(data)

  useEffect(() => {
    if (visible || frozen.length === 0) setFrozen(data)
  }, [visible, data, frozen.length])

  const hasValues = useMemo(
    () => frozen.some((d) => series.some((s) => typeof d[s.key] === 'number' && d[s.key] !== null)),
    [frozen, series],
  )

  const { domain: xDomain, ticks: xTicks } = useTimeAxis(frozen, time)
  const day = CHART_TIMES[time].day
  const fmt = tickFormatter ?? ((v: number) => String(v))

  if (frozen.length === 0 || !hasValues) {
    return (
      <div ref={ref} className="flex h-full items-center justify-center text-[13px] text-ink-tertiary">
        暂无数据
      </div>
    )
  }

  return (
    <div
      ref={ref}
      className={cn(
        'h-full w-full transition-opacity',
        CHART_SURFACE_CLS,
        yAxisWidth ? 'opacity-100' : 'opacity-0',
      )}
    >
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={frozen} margin={{ ...CHART_MARGIN, bottom: 16 }} accessibilityLayer>
          <CartesianGrid vertical={false} />

          <YAxis
            direction="ltr"
            orientation="left"
            width={yAxisWidth}
            domain={domain ?? [0, 'auto']}
            ticks={fixedDomainTicks(domain)}
            tickFormatter={(v) => updateYAxisWidth(fmt(Number(v)))}
            tickLine={false}
            axisLine={false}
            className="tracking-tighter"
          />

          <XAxis
            dataKey="created"
            domain={xDomain}
            ticks={xTicks}
            allowDataOverflow
            type="number"
            scale="time"
            minTickGap={12}
            tickMargin={8}
            tickLine={false}
            axisLine={false}
            tickFormatter={(v) => formatAxisTime(Number(v), day)}
          />

          <Tooltip
            cursor={{ stroke: 'var(--t-font-color-tertiary)', strokeOpacity: 0.3 }}
            content={<ChartTooltipInner formatter={valueFormatter} time={time} /> as never}
          />

          {series.map((s) => (
            <Line
              key={s.key}
              type="monotoneX"
              dataKey={s.key}
              name={s.label}
              stroke={s.color}
              strokeWidth={1.5}
              dot={false}
              isAnimationActive={false}
              activeDot={{ r: 3, strokeWidth: 0 }}
            />
          ))}
        </LineChart>
      </ResponsiveContainer>
    </div>
  )
}

/**
 * 图表卡片外壳。
 *
 * 几何与字号照 Beszel 的 chart-card.tsx:
 *   px-3 py-5 sm:px-6 sm:py-6 / 标题 1.4rem→sm:2xl 加粗 / 说明 text-sm /
 *   图表区 h-48 md:h-52(带图例 h-54 md:h-56)
 * 标题字号是这轮"像不像"的关键 —— 之前写成 13px,和参考稿差了近一倍。
 *
 * `compact` 是给**一屏多张**的场景(首页的 2×2 图表墙)用的。
 * 上面那套尺寸是为"一页一两张大图"调的:1.4rem 的标题在首页比页面标题
 * 还大,四张 h-52 的图纵向铺开又要吃掉一千多像素 —— 版面重心全跑到图表上,
 * 而首页真正的主角是上面那排读数。紧凑档把小标题收到 12.5px、
 * 图表区压到 h-32,四张图一屏看得完,详情页仍用原尺寸。
 */
export function ChartCard({
  title,
  description,
  action,
  legend,
  children,
  className,
  compact = false,
}: {
  title: string
  description?: React.ReactNode
  action?: React.ReactNode
  /** 图例,渲染在图表区下方。 */
  legend?: React.ReactNode
  children: React.ReactNode
  className?: string
  /** 紧凑档:小标题 + 矮图表区,用于一屏多张图。 */
  compact?: boolean
}) {
  return (
    <div
      className={cn(
        // 后两条来自 Beszel ChartCard 的 odd:last-of-type:col-span-full min-h-full ——
        // 图表总数为奇数时,最后一张占满整行,不然右下角会空出一块。
        // 紧凑档不要那两条:2×2 网格里正好四张,占满是多余的,
        // 而 min-h-full 会让某张图被同伴撑高。
        compact
          ? 'rounded-lg border border-line bg-primary px-3 py-3 sm:px-4'
          : 'rounded-lg border border-line bg-primary px-3 py-5 sm:px-6 sm:py-6',
        compact ? '' : 'odd:last-of-type:col-span-full min-h-full',
        className,
      )}
    >
      <div className={cn('relative grid', compact ? 'mb-1.5 gap-0.5' : 'mb-3 gap-1.5 sm:mb-4')}>
        <h3
          className={cn(
            'leading-none font-semibold tracking-tight text-ink',
            compact ? 'text-[12.5px]' : 'text-[1.4rem] sm:text-2xl',
          )}
        >
          {title}
        </h3>
        {/* 紧凑档不出说明文字:四张图各自带一句"随时间变化"是纯占位噪声 */}
        {description && !compact ? <p className="text-sm text-ink-tertiary">{description}</p> : null}
        {action ? (
          <div
            className={cn(
              'grid justify-end',
              compact ? 'my-0' : 'my-1 sm:absolute sm:end-0 sm:top-0 sm:my-0',
            )}
          >
            {action}
          </div>
        ) : null}
      </div>

      <div
        className={cn(
          'relative ps-0',
          compact ? '-me-0.5 -ms-3' : '-me-1 -ms-3.5',
          compact
            ? legend
              ? 'h-36'
              : 'h-32'
            : legend
              ? 'h-54 md:h-56'
              : 'h-48 md:h-52',
        )}
      >
        <div className={cn('h-full w-full', legend ? (compact ? 'pb-5' : 'pb-6') : undefined)}>{children}</div>
        {legend ? (
          <div className="absolute inset-x-0 bottom-0 flex justify-center">{legend}</div>
        ) : null}
      </div>
    </div>
  )
}

/**
 * 图例。
 *
 * 色块用圆角方块而不是圆点 —— 和面积图的色带形状呼应,
 * 圆点会让人以为是折线图。
 */
export function ChartLegend({
  items,
  className,
}: {
  items: Array<{ label: string; color: string }>
  className?: string
}) {
  return (
    <div className={cn('flex flex-wrap items-center justify-center gap-x-3 gap-y-1', className)}>
      {items.map((it) => (
        <span key={it.label} className="flex items-center gap-1.5 text-[12px] text-ink-secondary">
          <span
            className="inline-block size-2 shrink-0 rounded-[2px]"
            style={{ background: it.color }}
            aria-hidden
          />
          <span className="truncate">{it.label}</span>
        </span>
      ))}
    </div>
  )
}

/**
 * 时间范围切换。
 *
 * 照 Beszel 的 chart-time-select.tsx:左侧 History 图标 + 无边框感的下拉。
 */
export function ChartTimeSelect({
  value,
  onChange,
  className,
}: {
  value: ChartTime
  onChange: (t: ChartTime) => void
  className?: string
}) {
  return (
    <div className={cn('relative', className)}>
      <History
        className="pointer-events-none absolute start-4 top-1/2 size-4 -translate-y-1/2 opacity-85"
        aria-hidden
      />
      <select
        value={value}
        onChange={(e) => onChange(e.target.value as ChartTime)}
        aria-label="时间范围"
        className="h-9 w-full cursor-pointer appearance-none rounded-md border border-line bg-primary ps-10 pe-5 text-[13px] text-ink outline-none transition-colors hover:bg-overlay-light focus:border-accent"
      >
        {Object.entries(CHART_TIMES).map(([key, cfg]) => (
          <option key={key} value={key}>
            {cfg.label}
          </option>
        ))}
      </select>
    </div>
  )
}
