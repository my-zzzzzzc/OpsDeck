import type { CSSProperties, ReactNode } from 'react'

import { CountUp } from './CountUp'
import { HEALTH, levelOf } from './health'

/*
 * 共享原语。
 *
 * 视觉规格来自 Beszel:1px 半透明描边、0.8rem 卡片圆角、单色主操作、
 * 胶囊形状态徽标。组件里不出现硬编码颜色,明暗两套由语义令牌切换。
 */

/**
 * 指标数值的语义色。
 *
 * 默认中性:只有需要被处理的指标(越过阈值)才给数字上色 ——
 * 满屏彩字等于没有重点,读者会把"红色"当成常态。
 */
export const STAT_TONE = {
  neutral: 'text-ink',
  ok: 'text-ink-success',
  warn: 'text-ink-warning',
  bad: 'text-ink-danger',
  accent: 'text-accent',
} as const

export type StatTone = keyof typeof STAT_TONE

/** 在线状态指示点。在线时带呼吸效果。 */
export function StatusDot({ status }: { status: 'online' | 'offline' | 'unknown' }) {
  const cls =
    status === 'online' ? 'bg-status-ok' : status === 'offline' ? 'bg-status-bad' : 'bg-ink-tertiary'

  const label = status === 'online' ? '在线' : status === 'offline' ? '离线' : '未知'

  if (status !== 'online') {
    return <span className={`size-2 shrink-0 rounded-full ${cls}`} role="img" aria-label={label} />
  }

  return (
    <span className="relative flex size-2 shrink-0" role="img" aria-label={label}>
      <span className={`absolute inline-flex size-full animate-ping rounded-full ${cls} opacity-60`} />
      <span className={`relative inline-flex size-2 rounded-full ${cls}`} />
    </span>
  )
}

/**
 * 状态徽标。
 *
 * Beszel 的徽标是胶囊形、浅色底、无描边;这里保留那套形状,
 * 但把字号压到 10.5px,避免在密集表格里把行高顶起来。
 *
 * 两条硬约束:
 *   - shrink-0:徽标不参与列宽压缩。
 *   - 内层 whitespace-nowrap:徽标文字永远不换行。
 */
export function Badge({
  children,
  tone = 'neutral',
}: {
  children: ReactNode
  tone?: 'ok' | 'warn' | 'bad' | 'neutral' | 'accent'
}) {
  const cls =
    tone === 'ok'
      ? 'bg-tint-success text-ink-success'
      : tone === 'warn'
        ? 'bg-tint-warning text-ink-warning'
        : tone === 'bad'
          ? 'bg-tint-danger text-ink-danger'
          : tone === 'accent'
            ? 'bg-accent text-on-accent'
            : 'border border-line bg-primary text-ink-secondary'

  return (
    <span
      className={`inline-flex h-5 shrink-0 items-center rounded-full px-2 text-[10.5px] font-medium ${cls}`}
    >
      <span className="whitespace-nowrap">{children}</span>
    </span>
  )
}

/**
 * 内容面板。
 *
 * 白色卡片、1px 暖灰描边、12.8px 圆角和极轻的投影,是 Beszel 的主表面。
 * 内边距保持 12px:这张卡片里往往直接放紧凑表格,再放宽会牺牲一屏的行数。
 */
export function Card({
  children,
  className = '',
  padded = true,
  style,
}: {
  children: ReactNode
  className?: string
  padded?: boolean
  style?: CSSProperties
}) {
  return (
    <div
      style={style}
      className={`rounded-lg border border-line bg-primary shadow-xs ${padded ? 'p-3' : ''} ${className}`}
    >
      {children}
    </div>
  )
}

/**
 * 内嵌面。
 *
 * 参考的 Bento 卡片里,外层是一张白卡,里面嵌着几块浅灰的方块 ——
 * 靠"底色深浅"分层,而不是"再套一层描边"。
 *
 * 因此 Tile **永远不带边框**:边框是 Card 的职责,它负责划分"这是一块区域";
 * Tile 只负责表达"这块区域属于上面那张卡"。两个都描边,嵌套就变成了
 * 一层套一层的盒子,视觉噪声比信息还多。
 */
export function Tile({
  children,
  className = '',
  padded = true,
}: {
  children: ReactNode
  className?: string
  padded?: boolean
}) {
  return (
    <div className={`rounded-md bg-sunken ${padded ? 'p-3' : ''} ${className}`}>{children}</div>
  )
}

/**
 * 区块标题。
 *
 * Beszel 的卡片标题是句首大写、短而实,不用全大写小标签。
 * 这里沿用它的语气,只保留 12px 半粗体与足够安静的灰色。
 */
export function SectionTitle({
  children,
  aside,
  icon,
  action,
}: {
  children: ReactNode
  aside?: ReactNode
  icon?: ReactNode
  action?: ReactNode
}) {
  return (
    <div className="mb-2.5 flex h-7 items-center gap-2">
      {icon ? <span className="shrink-0 text-ink-tertiary">{icon}</span> : null}
      <h2 className="text-[12.5px] font-semibold text-ink">{children}</h2>
      {aside}
      {action ? <div className="ml-auto flex items-center gap-1">{action}</div> : null}
    </div>
  )
}

/**
 * 页面头部。
 *
 * 三件事:告诉用户"这是哪一页"、"数据有多新"、"能做什么"。
 * 缺少其中任何一件,看板就会显得像一个没有门牌的房间。
 *
 * `badge` 是紧贴标题的一枚小标(首页用来说明数据是实时轮询的)。
 * 它必须和 h1 同排而不是落到 description 里 —— 它修饰的是"这一页",
 * 不是"这一页的说明"。
 */
export function PageHeader({
  title,
  description,
  badge,
  meta,
  actions,
}: {
  title: ReactNode
  description?: ReactNode
  badge?: ReactNode
  meta?: ReactNode
  actions?: ReactNode
}) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <h1 className="text-[22px] leading-7 font-semibold tracking-[-0.025em] text-ink">{title}</h1>
          {badge}
        </div>
        {description ? (
          <p className="mt-1 text-[13px] text-ink-tertiary">{description}</p>
        ) : null}
      </div>
      {meta || actions ? (
        <div className="flex shrink-0 items-center gap-2">
          {meta}
          {actions}
        </div>
      ) : null}
    </div>
  )
}

/** 方形图标按钮。用于刷新这类"只占一个图标"的操作。 */
export function IconButton({
  children,
  onClick,
  label,
  disabled,
  spinning = false,
}: {
  children: ReactNode
  onClick?: () => void
  label: string
  disabled?: boolean
  spinning?: boolean
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
      className="flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-md border border-line bg-primary text-ink-tertiary transition-colors hover:bg-accent-soft hover:text-ink disabled:cursor-not-allowed disabled:opacity-40"
    >
      <span className={spinning ? 'animate-spin' : ''}>{children}</span>
    </button>
  )
}

/**
 * 指标方块。
 *
 * 参考设计里出现次数最多的一块:"平均延迟 / 128 ms"、"活跃 Key / 7" ——
 * 上面一行小字说明"这是什么",下面一行大字回答"多少"。
 *
 * 顺序不能反。先给数字,读者得先猜这个数字是什么;先给标签,数字才有意义。
 * 这也是它和普通"统计卡"的区别:统计卡把图标、标签、数值、说明四样东西
 * 平铺开来,一屏放五张就变成五块同样重量的色块;指标方块只留"标签 + 数值",
 * 重量自然降下来,可以成组出现而不互相抢。
 *
 * 数值为 null 时显示「—」而不是 0。缺失和零是两回事 ——
 * 把"没采集到"画成 0,会让一台失联的机器看起来最健康。
 */
export function Stat({
  label,
  value,
  unit,
  decimals = 0,
  hint,
  tone = 'neutral',
  bar,
  className = '',
}: {
  label: ReactNode
  value: number | null
  unit?: ReactNode
  decimals?: number
  hint?: ReactNode
  tone?: StatTone
  /** 传入则画出水位条,并按统一阈值(≥85 红 / ≥70 琥珀)上色。 */
  bar?: number | null
  className?: string
}) {
  const has = value !== null && Number.isFinite(value)
  const barHas = bar !== null && bar !== undefined && Number.isFinite(bar)
  const pct = barHas ? Math.max(0, Math.min(100, bar)) : 0

  return (
    <Tile className={`flex flex-col ${className}`}>
      <span className="truncate text-[11.5px] text-ink-tertiary">{label}</span>

      <span className="mt-1.5 flex items-baseline gap-1">
        {has ? (
          <CountUp
            to={value}
            decimals={decimals}
            duration={1.1}
            className={`text-[24px] leading-none font-semibold ${STAT_TONE[tone]}`}
          />
        ) : (
          <span className="text-[24px] leading-none font-semibold text-ink-tertiary">—</span>
        )}
        {unit ? <span className="truncate text-[12px] text-ink-tertiary">{unit}</span> : null}
      </span>

      {/*
        mt-auto:同一行的方块被 grid 拉成等高后,把「说明 + 水位条」这一组压到同一条基线上。
        条不对齐的话,四块并排看着像四张不同的卡,而不是一组读数。
        说明放在条的上方而不是下方 —— 它是条的量纲(「3.0 / 3.6 GB」),
        脱离条之后就只是一个飘在中间的数字。
      */}
      {hint || barHas ? (
        <div className="mt-auto flex flex-col gap-2 pt-2.5">
          {hint ? <span className="truncate text-[11px] text-ink-tertiary">{hint}</span> : null}
          {barHas ? (
            <span className="block h-[5px] overflow-hidden rounded-full bg-overlay-medium">
              <span
                className={`block h-full rounded-full transition-[width] duration-500 ease-out ${
                  HEALTH[levelOf(pct)].bar
                }`}
                style={{ width: `${pct}%` }}
              />
            </span>
          ) : null}
        </div>
      ) : null}
    </Tile>
  )
}

/** 空状态。 */
export function Empty({ children }: { children: ReactNode }) {
  return <p className="text-[13px] text-ink-tertiary">{children}</p>
}

/**
 * 「已用 / 总量 单位」形式的量纲文本。
 *
 * 百分比回答"紧不紧",绝对值回答"还剩多少" —— 两个都需要:
 * 内存 83% 在 4GB 的机器上是快满了,在 64GB 的机器上只是用了点。
 *
 * 任一侧缺失就整条不返回:写出「3.1 / — GB」比不写更费解。
 */
export function usageHint(
  used: number | null,
  total: number | null,
  scale: number,
  unit: string,
): string | undefined {
  if (used === null || total === null) return undefined
  return `${(used / scale).toFixed(1)} / ${(total / scale).toFixed(1)} ${unit}`
}

/*
 * 读数条的列数。
 *
 * Tailwind 的类名是静态扫描出来的,`lg:grid-cols-${n}` 这种拼接不会生成样式,
 * 所以这里必须把每种列数写成完整的字面量。
 */
const STRIP_COLS = {
  2: 'grid-cols-2',
  3: 'grid-cols-2 sm:grid-cols-3',
  4: 'grid-cols-2 sm:grid-cols-4',
} as const

/**
 * 读数条:外层一张白卡,里面一排等宽指标方块。
 *
 * 列表页顶部回答"一共多少、什么状态"用的。
 * 直接甩一张表,读者得自己数;先给一行结论,再往下才是明细。
 *
 * 外层必须是 Card 而不是直接把 Tile 铺在页面上:页面底色本身已经是浅灰,
 * 灰色方块直接放上去会变成"没有归属的灰块"。白卡提供父级,
 * 方块才读得出"这几块属于同一组"。
 */
export function StatStrip({
  cols = 4,
  className = '',
  children,
}: {
  cols?: keyof typeof STRIP_COLS
  className?: string
  children: ReactNode
}) {
  return (
    <Card padded={false} className={`overflow-hidden ${className}`}>
      <div className={`grid gap-3 p-3 ${STRIP_COLS[cols]}`}>{children}</div>
    </Card>
  )
}

/**
 * 次要按钮。对应 Beszel 的 outline / secondary 按钮:
 * 白底、1px 描边,hover 时才浮出浅色表面。
 */
export function GhostButton({
  children,
  onClick,
  disabled,
  title,
}: {
  children: ReactNode
  onClick?: () => void
  disabled?: boolean
  title?: string
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={title}
      title={title}
      className="inline-flex h-7 min-w-0 cursor-pointer items-center justify-center gap-1 rounded-md border border-line bg-primary px-2.5 text-[11.5px] font-medium whitespace-nowrap text-ink-secondary transition-colors hover:bg-accent-soft hover:text-ink disabled:pointer-events-none disabled:opacity-50"
    >
      {children}
    </button>
  )
}

/** 主按钮。Beszel 的主操作是单色反转,不用品牌蓝。 */
export function PrimaryButton({
  children,
  onClick,
  disabled,
  type = 'button',
}: {
  children: ReactNode
  onClick?: () => void
  disabled?: boolean
  type?: 'button' | 'submit'
}) {
  return (
    <button
      type={type}
      disabled={disabled}
      onClick={onClick}
      className="inline-flex h-8 min-w-0 cursor-pointer items-center justify-center gap-1.5 rounded-md bg-accent px-3 text-[12px] font-medium whitespace-nowrap text-on-accent transition-colors hover:bg-accent-hover disabled:pointer-events-none disabled:opacity-50"
    >
      {children}
    </button>
  )
}

/** 骨架块。包一层以统一圆角与动效节奏。 */
export function Skeleton({ className = '' }: { className?: string }) {
  return <div className={`animate-pulse rounded-md bg-overlay-medium ${className}`} />
}
