import { motion, type Transition, type Variants } from 'motion/react'
import type { CSSProperties, ReactNode } from 'react'

/*
 * 动效原语。
 *
 * 原则(与 Dify UI 的克制风格一致):
 *   - 动效服务于"状态变化可被感知",不是装饰。
 *   - 入场轻、位移小(≤8px)、时长 0.2-0.4s,避免拖慢操作节奏。
 *   - 尊重系统的"减少动态效果"偏好,不做无法关闭的动画。
 */

/** 统一缓动。与 Dify 的交互节奏一致:起步快、收尾稳。 */
export const EASE: Transition = {
  duration: 0.32,
  ease: [0.16, 1, 0.3, 1],
}

const FAST: Transition = { duration: 0.18, ease: [0.16, 1, 0.3, 1] }

/** 列表容器:子项依次入场。 */
export const listContainer: Variants = {
  hidden: {},
  show: {
    transition: { staggerChildren: 0.04, delayChildren: 0.02 },
  },
}

/** 列表项:淡入 + 轻微上移。 */
export const listItem: Variants = {
  hidden: { opacity: 0, y: 8 },
  show: { opacity: 1, y: 0, transition: EASE },
}

/** 页面区块入场。 */
export function FadeIn({
  children,
  delay = 0,
  className = '',
}: {
  children: ReactNode
  delay?: number
  className?: string
}) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ ...EASE, delay }}
      className={className}
    >
      {children}
    </motion.div>
  )
}

/**
 * 依次入场的列表。
 * 用于事件、容器、服务器这类"多条同类项"——逐条出现能帮助眼睛定位。
 */
export function StaggerList({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <motion.div variants={listContainer} initial="hidden" animate="show" className={className}>
      {children}
    </motion.div>
  )
}

/** 列表中的一项,配合 StaggerList 使用。 */
export function StaggerItem({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <motion.div variants={listItem} className={className}>
      {children}
    </motion.div>
  )
}

/**
 * 可交互卡片:悬停轻微抬起。
 *
 * 这是"页面是活的"最直接的信号 —— 用户能立刻看出哪里可以点。
 */
export function MotionCard({
  children,
  className = '',
  onClick,
  interactive = true,
}: {
  children: ReactNode
  className?: string
  onClick?: () => void
  interactive?: boolean
}) {
  return (
    <motion.div
      onClick={onClick}
      whileHover={interactive ? { y: -2, boxShadow: '0 8px 20px -8px rgb(16 24 40 / 0.18)' } : undefined}
      whileTap={interactive && onClick ? { scale: 0.995 } : undefined}
      transition={FAST}
      className={className}
    >
      {children}
    </motion.div>
  )
}

/**
 * 数值滚动。
 *
 * 指标变化时数字平滑过渡,而不是硬切 —— 运维盯着看板时,
 * 这个过渡能让"刚涨上去了"这件事被注意到。
 */
export function AnimatedNumber({
  value,
  decimals = 0,
  suffix = '',
}: {
  value: number
  decimals?: number
  suffix?: string
}) {
  return (
    <span className="tnum">
      <motion.span
        key={value}
        initial={{ opacity: 0, y: -6 }}
        animate={{ opacity: 1, y: 0 }}
        transition={FAST}
        className="inline-block"
      >
        {value.toFixed(decimals)}
      </motion.span>
      {suffix}
    </span>
  )
}

/**
 * 呼吸灯。用于"在线""进行中"这类持续状态。
 *
 * 只在真正需要引人注意时用(如未读告警),避免整页都在闪。
 */
export function Pulse({ children, color = 'bg-ink-success' }: { children: ReactNode; color?: string }) {
  return (
    <span className="relative inline-flex items-center gap-2">
      <span className="relative flex size-2">
        <motion.span
          className={`absolute inline-flex size-full rounded-full ${color}`}
          animate={{ scale: [1, 2.2, 1], opacity: [0.6, 0, 0.6] }}
          transition={{ duration: 2.4, repeat: Infinity, ease: 'easeOut' }}
        />
        <span className={`relative inline-flex size-2 rounded-full ${color}`} />
      </span>
      {children}
    </span>
  )
}

/** 进度条:数值变化时宽度平滑过渡,而非跳变。 */
export function AnimatedBar({ percent, tone }: { percent: number; tone: string }) {
  return (
    <div className="h-1.5 overflow-hidden rounded-full bg-overlay-medium">
      <motion.div
        className={`h-full rounded-full ${tone}`}
        initial={{ width: 0 }}
        animate={{ width: `${Math.min(100, percent)}%` }}
        transition={{ ...EASE, duration: 0.6 }}
      />
    </div>
  )
}

export { motion }


/**
 * 骨架屏。
 *
 * 加载态用骨架而非"加载中…"文字:提前占位能避免内容出现时的布局跳动,
 * 也让等待过程看起来是有进展的。
 */
export function Skeleton({ className = '', style }: { className?: string; style?: CSSProperties }) {
  return (
    <motion.div
      style={style}
      className={`rounded-md bg-overlay-medium ${className}`}
      animate={{ opacity: [0.5, 1, 0.5] }}
      transition={{ duration: 1.6, repeat: Infinity, ease: 'easeInOut' }}
    />
  )
}

/** 卡片骨架。 */
export function CardSkeleton({ lines = 3 }: { lines?: number }) {
  return (
    <div className="rounded-lg border border-line bg-primary p-4">
      <Skeleton className="mb-3 h-4 w-1/3" />
      {Array.from({ length: lines }).map((_, i) => (
        <Skeleton key={i} className="mb-2 h-3 w-full last:mb-0" style={{ width: `${90 - i * 12}%` }} />
      ))}
    </div>
  )
}

/** 页面级加载骨架。占位结构与看板一致,避免数据到位时布局跳动。 */
export function PageSkeleton() {
  return (
    <div className="flex flex-col gap-5">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        {Array.from({ length: 5 }).map((_, i) => (
          <Skeleton key={i} className="h-[92px]" />
        ))}
      </div>
      <div className="grid gap-5 lg:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)]">
        <CardSkeleton lines={5} />
        <div className="flex flex-col gap-5">
          <CardSkeleton lines={3} />
          <CardSkeleton lines={4} />
        </div>
      </div>
    </div>
  )
}
