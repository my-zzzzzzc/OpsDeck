import { cn } from './cn'
import { HEALTH, levelOf } from './health'

/*
 * 环形仪表盘。
 *
 * 用于首屏展示单个资源的占用率(CPU / 内存 / 磁盘)。
 *
 * 三个实现细节,都是踩过的:
 *
 * 1. **用 SVG 的 strokeDasharray 画弧,不用 3 个 div 拼**。
 *    拼圆在深色模式下边缘会露出底色缝隙,而且半径一变就得重算所有角度。
 *
 * 2. **从 12 点方向顺时针起笔**(rotate(-90))。0° 在 SVG 里是 3 点方向,
 *    不转过来的话 25% 会落在正下方,读起来完全反直觉。
 *
 * 3. **颜色只跟阈值走,不跟指标走**。CPU 蓝、内存绿这类分类色在仪表盘上
 *    会被读成"绿色=健康",而仪表盘要回答的恰恰是"满没满"。
 */

/** 弧长比例。0 与 1 之间,超界钳位。 */
function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v))
}

export function RadialGauge({
  value,
  label,
  sublabel,
  unit = '%',
  decimals,
  size = 110,
  thickness = 9,
}: {
  /** 0–100 的百分比。null 表示没采集到。 */
  value: number | null
  label: string
  sublabel?: string
  unit?: string
  /** 小数位。默认按量级决定:低于 10% 时保留一位,否则取整。 */
  decimals?: number
  size?: number
  thickness?: number
}) {
  const has = value !== null && Number.isFinite(value)
  const pct = has ? clamp01((value as number) / 100) : 0
  const level = has ? levelOf(value as number) : 'ok'

  /*
   * 小数位按量级取,不写死。
   *
   * 一台空闲机器的 CPU 常在 1% 上下,取整就变成「0%」——
   * 读起来像"没数据 / 坏了",而且环形弧只剩一个点,看不出它在动。
   * 高于 10% 时整数够用,再多一位反而是噪声。
   */
  const shown = decimals ?? ((value ?? 0) < 10 ? 1 : 0)

  const r = (size - thickness) / 2
  const c = 2 * Math.PI * r

  // 缺失时轨道用中性灰,不画任何进度 —— 画成 0% 会被读成"非常空闲"
  const arcColor = has
    ? level === 'bad'
      ? 'stroke-ink-danger'
      : level === 'warn'
        ? 'stroke-ink-warning'
        : 'stroke-ink-success'
    : 'stroke-transparent'

  const textColor = has
    ? level === 'bad'
      ? 'text-ink-danger'
      : level === 'warn'
        ? 'text-ink-warning'
        : 'text-ink'
    : 'text-ink-tertiary'

  return (
    <div className="flex flex-col items-center justify-center">
      <div className="relative shrink-0" style={{ width: size, height: size }}>
        <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="-rotate-90">
          {/* 轨道 */}
          <circle
            cx={size / 2}
            cy={size / 2}
            r={r}
            fill="none"
            strokeWidth={thickness}
            className="stroke-overlay-medium"
          />
          {/* 进度弧 */}
          {has ? (
            <circle
              cx={size / 2}
              cy={size / 2}
              r={r}
              fill="none"
              strokeWidth={thickness}
              strokeLinecap="round"
              strokeDasharray={`${c * pct} ${c}`}
              className={cn(arcColor, 'transition-[stroke-dasharray] duration-700 ease-out')}
            />
          ) : null}
        </svg>

        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <span className={cn('tnum font-semibold leading-none', textColor)} style={{ fontSize: size * 0.23 }}>
            {has ? (value as number).toFixed(shown) : '—'}
          </span>
          {has ? <span className="mt-0.5 text-[11px] text-ink-tertiary">{unit}</span> : null}
        </div>
      </div>

      <div className="mt-2 text-center">
        <div className="text-[12px] font-medium text-ink-secondary">{label}</div>
        {sublabel ? <div className="mt-0.5 text-[10.5px] text-ink-tertiary">{sublabel}</div> : null}
      </div>
    </div>
  )
}

/**
 * 横向水位条,用于环形仪表旁边补充绝对值。
 *
 * 与 meter.tsx 的 MeterCell 的区别:那个是表格里的窄格(字号 12px、条高 1em),
 * 这个是大卡里的宽条,带标签与左右两端的量纲。
 *
 * `showValue=false` 时只画条、不写百分比 —— 调用方若已在标题行给过数值,
 * 这里再写一遍就会在同一张卡里出现两个「49.9%」。
 */
export function UsageBar({
  label,
  percent,
  detail,
  showValue = true,
  warn = 70,
  crit = 85,
}: {
  label: string
  percent: number | null
  detail?: string
  showValue?: boolean
  warn?: number
  crit?: number
}) {
  const has = percent !== null && Number.isFinite(percent)
  const pct = has ? Math.max(0, Math.min(100, percent as number)) : 0
  const level = has ? (pct >= crit ? 'bad' : pct >= warn ? 'warn' : 'ok') : 'ok'

  // 没有标签、也没有数值时,这一行整个省掉,免得留一条空行占高度
  const hasHead = label !== '' || showValue || detail

  return (
    <div className="flex flex-col gap-1">
      {hasHead ? (
        <div className="flex items-baseline justify-between gap-2">
          <span className="truncate text-[11.5px] text-ink-secondary">{label}</span>
          <span className="flex shrink-0 items-baseline gap-1 tabular-nums">
            {detail ? <span className="text-[10.5px] text-ink-tertiary">{detail}</span> : null}
            {showValue ? (
              <span className={cn('text-[12px] font-medium', has ? HEALTH[level].text : 'text-ink-tertiary')}>
                {has ? `${(percent as number).toFixed(1)}%` : '—'}
              </span>
            ) : null}
          </span>
        </div>
      ) : null}
      <span className="block h-1.5 overflow-hidden rounded-full bg-overlay-medium">
        <span
          className={cn('block h-full rounded-full transition-[width] duration-500 ease-out', has ? HEALTH[level].bar : '')}
          style={{ width: `${pct}%` }}
        />
      </span>
    </div>
  )
}

/**
 * 迷你走势条(sparkline)。
 *
 * 用于「值几乎不变、但偶尔会跳一下」的指标 —— 内存和磁盘就是典型:
 * 它们长期是 45% / 50%,给一张 200px 高的面积图只会得到一大块纯色,
 * 信息量与这几十像素的折线完全一样。
 *
 * 不做刻度、不做 tooltip:它回答的是"有没有抖过",不是"某分钟是多少"。
 * 需要精确值就点「全部图表」进详情页。
 */
export function Sparkline({
  values,
  color = 'var(--chart-2)',
  height = 34,
}: {
  /** 按时间顺序的数值。null 会被断开。 */
  values: Array<number | null>
  color?: string
  height?: number
}) {
  const has = values.some((v): v is number => v !== null && Number.isFinite(v))
  if (!has) {
    return (
      <div className="flex items-center justify-center text-[11px] text-ink-tertiary" style={{ height }}>
        暂无数据
      </div>
    )
  }

  const W = 100
  const H = height
  const kept = values.filter((v): v is number => v !== null && Number.isFinite(v))
  const min = Math.min(...kept)
  const max = Math.max(...kept)

  /*
   * 上下各留 4% 的余量。
   *
   * 一条恒定在 45% 的线如果按 [min,max] 自适应,会顶到画布边缘变成一条
   * 贴边的直线;按 [0,100] 又会被压成一条几乎看不见的细线。
   * 折中:围绕真实区间展开,但两端留白,让"平的"看起来就是平的。
   */
  const pad = Math.max((max - min) * 0.15, 1.5)
  const lo = Math.max(0, min - pad)
  const hi = Math.min(100, max + pad)
  const span = hi - lo || 1

  const stepX = values.length > 1 ? W / (values.length - 1) : W
  const pts = values
    .map((v, i) => (v === null || !Number.isFinite(v) ? null : `${i * stepX},${H - ((v - lo) / span) * H}`))
    .filter((p): p is string => p !== null)

  if (pts.length === 0) return null

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="none"
      className="w-full"
      style={{ height }}
      aria-hidden
    >
      <polyline
        points={pts.join(' ')}
        fill="none"
        stroke={color}
        strokeWidth={1.25}
        strokeLinejoin="round"
        strokeLinecap="round"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  )
}
