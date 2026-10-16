/*
 * 健康度模型。
 *
 * 单独成模块的原因:阈值(≥85 红 / ≥70 琥珀 / 其余绿)原先在 App.tsx 与
 * ServersPanel.tsx 各写了一份,注释里只能写"改阈值时两处都要改"——
 * 那种约定迟早会漏。现在这里是唯一的一处定义,其它地方一律 import。
 *
 * 配色类名留在这里而不是各写各的,是因为同一个状态在页面上会出现三次
 * (状态点、数值、整行底色),三处颜色必须同源,否则用户得重新学一遍
 * "这个黄和那个黄是不是一回事"。
 */

/** 健康度三级。与 Twenty 的语义色一一对应。 */
export type Health = 'ok' | 'warn' | 'bad'

export const HEALTH_LABEL: Record<Health, string> = { ok: '正常', warn: '降级', bad: '异常' }

export const HEALTH = {
  ok: { dot: 'bg-ink-success', text: 'text-ink-secondary', bar: 'bg-ink-success', row: '' },
  warn: { dot: 'bg-ink-warning', text: 'text-ink-warning', bar: 'bg-ink-warning', row: 'bg-tint-orange' },
  bad: { dot: 'bg-ink-danger', text: 'text-ink-danger', bar: 'bg-ink-danger', row: 'bg-tint-danger' },
} as const

/** 严重度排序:数值越小越严重。用于排序与"取最严重的一项"。 */
export const HEALTH_RANK: Record<Health, number> = { bad: 0, warn: 1, ok: 2 }

/**
 * 百分比 → 健康度。
 *
 * 85 / 70 这两个数是整个应用里唯一的一份阈值定义。
 * 磁盘和 CPU 用同一套:运维要记的是"过 85 就要动手",不是每个指标一套刻度。
 */
export function levelOf(pct: number): Health {
  if (pct >= 85) return 'bad'
  if (pct >= 70) return 'warn'
  return 'ok'
}

/** 已用 / 总量 → 百分比。缺任一侧返回 null,由调用方渲染成「—」。 */
export function ratio(used?: number | null, total?: number | null): number | null {
  if (!total || total <= 0) return null
  return ((used ?? 0) / total) * 100
}

/** 忽略空值的均值。全空返回 null —— 与"平均值是 0"是两回事。 */
export function mean(values: Array<number | null>): number | null {
  const kept = values.filter((v): v is number => v !== null && Number.isFinite(v))
  if (kept.length === 0) return null
  return kept.reduce((a, b) => a + b, 0) / kept.length
}

/**
 * 水位 → 指标数值的语义色键。
 *
 * 正常水位不上色 —— 只有需要被处理的读数才给颜色。
 * 一屏四个数字全绿,等于告诉读者"绿色不用看",颜色就白给了。
 */
export function toneOfLevel(level: Health): 'neutral' | 'ok' | 'warn' | 'bad' {
  return level === 'ok' ? 'neutral' : level
}
