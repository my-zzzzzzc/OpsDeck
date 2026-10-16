import type { LucideIcon } from 'lucide-react'

/*
 * 指标条与阈值判定。
 *
 * 规格取自 Beszel(internal/site/src/components/systems-table/systems-table-columns.tsx):
 *   - 条高 h-[1em] —— 跟随字号,而不是固定像素
 *   - 数值列定宽 + tabular-nums —— 百分比跳变时列不抖动,纵向可对齐
 *   - 轨道用 muted 底色,填充色按阈值切换
 *
 * 阈值可配置:默认 65% 警告、90% 危险(与 Beszel 一致)。
 * 比常见的 70/85 更早预警 —— 内存到 90% 时已经很危险。
 */

export const DEFAULT_WARN = 65
export const DEFAULT_CRIT = 90

export type MeterState = 'good' | 'warn' | 'crit' | 'paused'

/** 按阈值判定状态。 */
export function meterState(pct: number, warn = DEFAULT_WARN, crit = DEFAULT_CRIT): MeterState {
  if (pct >= crit) return 'crit'
  if (pct >= warn) return 'warn'
  return 'good'
}

const FILL: Record<MeterState, string> = {
  good: 'bg-ink-success',
  warn: 'bg-ink-warning',
  crit: 'bg-ink-danger',
  paused: 'bg-ink-tertiary',
}

const TEXT: Record<MeterState, string> = {
  good: 'text-ink-secondary',
  warn: 'text-ink-warning',
  crit: 'text-ink-danger',
  paused: 'text-ink-tertiary',
}

/**
 * 表格内的指标格。
 *
 * 左侧数值定宽(right-aligned),右侧细条填满剩余空间 ——
 * 这样同一列的多行数值天然对齐,视线可以快速纵向扫读。
 */
export function MeterCell({
  value,
  warn = DEFAULT_WARN,
  crit = DEFAULT_CRIT,
  suffix = '%',
  decimals,
  dimmed = false,
}: {
  value: number | null | undefined
  warn?: number
  crit?: number
  suffix?: string
  decimals?: number
  dimmed?: boolean
}) {
  if (value === null || value === undefined || Number.isNaN(value)) {
    return <span className="text-[12px] text-ink-tertiary">—</span>
  }

  const pct = Math.max(0, Math.min(100, value))
  const state = dimmed ? 'paused' : meterState(pct, warn, crit)

  // 小数值多留一位,避免 2.8% 显示成 3%
  const digits = decimals ?? (pct >= 10 ? 1 : 1)

  return (
    <div className="flex w-full min-w-0 items-center gap-2 tabular-nums tracking-tight">
      <span className={`min-w-[3.2em] shrink-0 text-right text-[12px] ${TEXT[state]}`}>
        {pct.toFixed(digits)}
        {suffix}
      </span>
      <span className="grid h-[1em] min-w-8 flex-1 overflow-hidden rounded-sm bg-overlay-medium">
        <span
          className={`h-full rounded-sm transition-[width] duration-500 ease-out ${FILL[state]}`}
          style={{ width: `${pct}%` }}
        />
      </span>
    </div>
  )
}

/**
 * 紧凑的数值单元格(不带宽条)。
 * 用于流量、负载这类不适合百分比表达的值。
 */
export function ValueCell({
  value,
  unit = '',
  decimals = 2,
  muted = false,
}: {
  value: number | null | undefined
  unit?: string
  decimals?: number
  muted?: boolean
}) {
  if (value === null || value === undefined) {
    return <span className="text-[12px] text-ink-tertiary">—</span>
  }
  return (
    <span className={`tabular-nums text-[12px] ${muted ? 'text-ink-tertiary' : 'text-ink-secondary'}`}>
      {value.toFixed(decimals)}
      {unit ? <span className="ml-0.5 text-ink-tertiary">{unit}</span> : null}
    </span>
  )
}

/** 状态圆点。用于表格首列表示机器在线状态。 */
export function StatusDot({ state, pulse = true }: { state: MeterState; pulse?: boolean }) {
  const color = FILL[state]

  if (state !== 'good' || !pulse) {
    return <span className={`inline-block size-2 shrink-0 rounded-full ${color}`} />
  }

  return (
    <span className="relative inline-flex size-2 shrink-0">
      <span className={`absolute inline-flex size-full animate-ping rounded-full ${color} opacity-60`} />
      <span className={`relative inline-flex size-2 rounded-full ${color}`} />
    </span>
  )
}

/** 带图标的列头。Beszel 的每列都配一个图标,便于快速识别。 */
export function ColumnHeader({
  icon: Icon,
  children,
  align = 'left',
}: {
  icon?: LucideIcon
  children: React.ReactNode
  align?: 'left' | 'right'
}) {
  return (
    <span className={`flex items-center gap-1.5 ${align === 'right' ? 'justify-end' : ''}`}>
      {Icon ? <Icon size={13} className="shrink-0 opacity-70" /> : null}
      {children}
    </span>
  )
}
