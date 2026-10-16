import type { ReactNode, SVGProps } from 'react'

/*
 * 图标集。
 *
 * 为什么自己画而不用图标库:
 *   - 项目只用到十几个图标,引入 lucide-react 会多出一个运行时依赖与一份 chunk;
 *   - 描边宽度、端点、视觉重量需要和 Twenty 的 13px 正文统一,自绘才好控制。
 *
 * 规格:24 网格、1.6 描边、圆角端点、currentColor 着色,颜色一律由外层文字色决定。
 */

type IconProps = {
  size?: number
  className?: string
  children?: ReactNode
} & Omit<SVGProps<SVGSVGElement>, 'children'>

function Icon({ size = 16, className = '', children, ...rest }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      {children}
    </svg>
  )
}

/* ---- 导航 ---- */

export const IconGauge = (p: IconProps) => (
  <Icon {...p}>
    <path d="M12 14a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z" />
    <path d="m13.4 12.6 3.6-3.6" />
    <path d="M3.5 18a9 9 0 1 1 17 0" />
  </Icon>
)

export const IconServer = (p: IconProps) => (
  <Icon {...p}>
    <rect x="3" y="4" width="18" height="7" rx="2" />
    <rect x="3" y="13" width="18" height="7" rx="2" />
    <path d="M7 7.5h.01M7 16.5h.01" />
  </Icon>
)

export const IconBoxes = (p: IconProps) => (
  <Icon {...p}>
    <path d="M12 3 4 7l8 4 8-4-8-4Z" />
    <path d="m4 12 8 4 8-4" />
    <path d="m4 17 8 4 8-4" />
  </Icon>
)

export const IconContainer = (p: IconProps) => (
  <Icon {...p}>
    <path d="M12 3 4.5 7.2v9.6L12 21l7.5-4.2V7.2L12 3Z" />
    <path d="M4.5 7.2 12 11.4l7.5-4.2M12 11.4V21" />
  </Icon>
)

export const IconChat = (p: IconProps) => (
  <Icon {...p}>
    <path d="M20 15a3 3 0 0 1-3 3H8l-4 3V6a3 3 0 0 1 3-3h10a3 3 0 0 1 3 3v9Z" />
    <path d="M9 9h6M9 12.5h4" />
  </Icon>
)

export const IconSparkles = (p: IconProps) => (
  <Icon {...p}>
    <path d="M12 3.5 13.6 8 18 9.5 13.6 11 12 15.5 10.4 11 6 9.5 10.4 8 12 3.5Z" />
    <path d="M18.5 15.5 19.2 17.3 21 18l-1.8.7-.7 1.8-.7-1.8L16 18l1.8-.7.7-1.8Z" />
  </Icon>
)

export const IconUsers = (p: IconProps) => (
  <Icon {...p}>
    <path d="M15.5 20v-1.5a3.5 3.5 0 0 0-3.5-3.5H7a3.5 3.5 0 0 0-3.5 3.5V20" />
    <circle cx="9.5" cy="8" r="3.2" />
    <path d="M20.5 20v-1.5a3.5 3.5 0 0 0-2.6-3.4M15.5 5.2a3.2 3.2 0 0 1 0 5.6" />
  </Icon>
)

export const IconScroll = (p: IconProps) => (
  <Icon {...p}>
    <path d="M6 4.5A1.5 1.5 0 0 1 7.5 3h9A1.5 1.5 0 0 1 18 4.5v15a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 6 19.5v-15Z" />
    <path d="M9 7.5h6M9 11h6M9 14.5h3.5" />
  </Icon>
)

/*
 * ---- 资源类图标 ----
 *
 * 这一组对应侧边栏「资源」分组。约定:一个图标只画一个主形体,
 * 细节超过三条就删 —— 15px 下多出来的线会糊成一团,反而认不出是什么。
 */

/** 蜂群:中心节点 + 三个卫星节点。 */
export const IconSwarm = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="12" cy="12" r="2.4" />
    <circle cx="12" cy="4.6" r="1.9" />
    <circle cx="5.6" cy="17.2" r="1.9" />
    <circle cx="18.4" cy="17.2" r="1.9" />
    <path d="M12 6.5v3.1M10.3 13.7 7.2 15.6M13.7 13.7l3.1 1.9" />
  </Icon>
)

/** 部署:火箭。 */
export const IconRocket = (p: IconProps) => (
  <Icon {...p}>
    <path d="M5 15.5c-1.4 1.2-1.9 4.5-1.9 4.5s3.3-.5 4.5-1.9c.7-.8.7-2-.1-2.8a2 2 0 0 0-2.5.2Z" />
    <path d="M12.5 14.5 9.5 11.5a20 20 0 0 1 1.9-3.6A12 12 0 0 1 20.5 3c0 2.6-.7 7.1-5.6 10.4a21 21 0 0 1-2.4 1.1Z" />
    <path d="M9.5 11.5H5.2s.5-2.8 1.9-3.7c1.5-1 4.6 0 4.6 0M12.5 14.5v4.3s2.8-.5 3.7-1.9c1-1.5 0-4.6 0-4.6" />
  </Icon>
)

/**
 * 构建:锤子。
 *
 * 斜柄 + 旋转 45° 的锤头。锤头要够长够厚(10×6)才读得出是锤子 ——
 * 一开始画成 9×5.4 时,15px 下只剩一个小方块挂在细线头上,像个图钉。
 * 柄的末端故意伸进锤头里,两者连成一体,不会看起来是两截。
 */
export const IconHammer = (p: IconProps) => (
  <Icon {...p}>
    <path d="M4.6 19.6 13.2 11" />
    <rect
      x="9.6"
      y="5.8"
      width="10"
      height="6"
      rx="1.6"
      strokeWidth={1.7}
      transform="rotate(45 14.6 8.8)"
    />
  </Icon>
)

/** 仓库:文件夹 + 一个分支节点。 */
export const IconFolderGit = (p: IconProps) => (
  <Icon {...p}>
    <path d="M3.6 7.4v9.8a1.8 1.8 0 0 0 1.8 1.8h13.2a1.8 1.8 0 0 0 1.8-1.8V9.2a1.8 1.8 0 0 0-1.8-1.8h-6L10.9 5.6a1.8 1.8 0 0 0-1.3-.6H5.4a1.8 1.8 0 0 0-1.8 1.8Z" />
    <circle cx="11.8" cy="12.4" r="1.3" />
    <circle cx="15.4" cy="12.4" r="1.3" />
    <path d="M11.8 13.7v1.5a1.4 1.4 0 0 0 1.4 1.4h.8a1.4 1.4 0 0 0 1.4-1.4v-1.5" />
  </Icon>
)

/** 程序:一条 S 形路径连接两个端点。 */
export const IconRoute = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="6" cy="18.5" r="2.5" />
    <circle cx="18" cy="5.5" r="2.5" />
    <path d="M15.5 5.5H10a4 4 0 0 0 0 8h4a4 4 0 0 1 0 8h-5.5" />
  </Icon>
)

/** 行动:闪电。 */
export const IconZap = (p: IconProps) => (
  <Icon {...p}>
    <path d="M13.2 2.5 4.8 13.2a.8.8 0 0 0 .6 1.3h5.1l-1.1 7 8.4-10.7a.8.8 0 0 0-.6-1.3h-5.1l1.1-7Z" />
  </Icon>
)

/** 同步:两条反向箭头。 */
export const IconSync = (p: IconProps) => (
  <Icon {...p}>
    <path d="M4.2 9h13.6l-3-3" />
    <path d="M19.8 15H6.2l3 3" />
  </Icon>
)

/** 更新:铃铛。 */
export const IconBell = (p: IconProps) => (
  <Icon {...p}>
    <path d="M18 9.2a6 6 0 1 0-12 0c0 4.6-1.8 6.1-1.8 6.1h15.6S18 13.8 18 9.2Z" />
    <path d="M13.7 18.6a2 2 0 0 1-3.4 0" />
  </Icon>
)

/** 日程安排:日历。 */
export const IconCalendar = (p: IconProps) => (
  <Icon {...p}>
    <rect x="3.5" y="5.5" width="17" height="15" rx="2" />
    <path d="M3.5 10.5h17M8.5 3.5v4M15.5 3.5v4" />
  </Icon>
)

/**
 * 设置:齿轮。
 *
 * 外圈用**粗虚线**当齿,而不是把八个齿一个个画成路径 ——
 * 八条齿的路径在 15px 下会糊成一个黑点,虚线圆反而边界清楚。
 */
export const IconGear = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="12" cy="12" r="7.3" strokeWidth={2.3} strokeDasharray="2.6 3.1" />
    <circle cx="12" cy="12" r="3.1" />
  </Icon>
)

/* ---- 状态与指标 ---- */

export const IconRefresh = (p: IconProps) => (
  <Icon {...p}>
    <path d="M20 11.5A8 8 0 0 0 6.2 6.6L4 8.8" />
    <path d="M4 4.5v4.3h4.3" />
    <path d="M4 12.5a8 8 0 0 0 13.8 4.9L20 15.2" />
    <path d="M20 19.5v-4.3h-4.3" />
  </Icon>
)

export const IconAlert = (p: IconProps) => (
  <Icon {...p}>
    <path d="M10.3 4.3 2.8 17.3A1.9 1.9 0 0 0 4.5 20h15a1.9 1.9 0 0 0 1.7-2.7L13.7 4.3a1.9 1.9 0 0 0-3.4 0Z" />
    <path d="M12 9.5v4M12 16.8h.01" />
  </Icon>
)

export const IconAlertOctagon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M8.4 3h7.2L21 8.4v7.2L15.6 21H8.4L3 15.6V8.4L8.4 3Z" />
    <path d="M12 8v4.5M12 16.3h.01" />
  </Icon>
)

export const IconInfo = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M12 11v5M12 8h.01" />
  </Icon>
)

export const IconClock = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M12 7.5V12l3 1.8" />
  </Icon>
)

export const IconCheck = (p: IconProps) => (
  <Icon {...p}>
    <path d="m5 12.5 4.5 4.5L19 7" />
  </Icon>
)

export const IconCheckCircle = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="m8.5 12.2 2.5 2.5 4.5-4.9" />
  </Icon>
)

export const IconCpu = (p: IconProps) => (
  <Icon {...p}>
    <rect x="6" y="6" width="12" height="12" rx="2" />
    <rect x="9.5" y="9.5" width="5" height="5" rx="1" />
    <path d="M9 3v3M15 3v3M9 18v3M15 18v3M3 9h3M3 15h3M18 9h3M18 15h3" />
  </Icon>
)

export const IconMemory = (p: IconProps) => (
  <Icon {...p}>
    <path d="M4 9.5h16v9a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 18.5v-9Z" />
    <path d="M7.5 9.5V6.5A1.5 1.5 0 0 1 9 5h6a1.5 1.5 0 0 1 1.5 1.5v3" />
    <path d="M8 13.5h3M8 16.5h6" />
  </Icon>
)

export const IconDisk = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="12" cy="12" r="8.5" />
    <circle cx="12" cy="12" r="2.6" />
    <path d="m14 10 4-4" />
  </Icon>
)

export const IconSwap = (p: IconProps) => (
  <Icon {...p}>
    <path d="M4 8h13l-3-3" />
    <path d="M20 16H7l3 3" />
  </Icon>
)

export const IconActivity = (p: IconProps) => (
  <Icon {...p}>
    <path d="M3 12h3.5l2.5-6 3.5 12 2.5-6H21" />
  </Icon>
)

export const IconTerminal = (p: IconProps) => (
  <Icon {...p}>
    <rect x="3" y="4.5" width="18" height="15" rx="2" />
    <path d="m7.5 10 2 2-2 2M12.5 14h4" />
  </Icon>
)

export const IconArrowUpRight = (p: IconProps) => (
  <Icon {...p}>
    <path d="M8 16 16 8M9.5 8H16v6.5" />
  </Icon>
)

export const IconChevronRight = (p: IconProps) => (
  <Icon {...p}>
    <path d="m10 6 6 6-6 6" />
  </Icon>
)

export const IconLogout = (p: IconProps) => (
  <Icon {...p}>
    <path d="M9.5 20H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h3.5" />
    <path d="M15 8.5 18.5 12 15 15.5M18.5 12H9.5" />
  </Icon>
)

export const IconShield = (p: IconProps) => (
  <Icon {...p}>
    <path d="M12 3.5 5 6.2v5.4c0 4 2.9 7.3 7 8.9 4.1-1.6 7-4.9 7-8.9V6.2L12 3.5Z" />
    <path d="m9.2 12 2 2 3.6-3.8" />
  </Icon>
)

/* ---- 顶栏 ---- */

export const IconSearch = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="11" cy="11" r="7.5" />
    <path d="m20.5 20.5-4.2-4.2" />
  </Icon>
)

export const IconMenu = (p: IconProps) => (
  <Icon {...p}>
    <path d="M4 7h16M4 12h16M4 17h16" />
  </Icon>
)

/** 浅色。主题切换用。 */
export const IconSun = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="12" cy="12" r="4" />
    <path d="M12 2v2.5M12 19.5V22M4.2 4.2l1.8 1.8M18 18l1.8 1.8M2 12h2.5M19.5 12H22M4.2 19.8 6 18M18 6l1.8-1.8" />
  </Icon>
)

/** 深色。主题切换用。 */
export const IconMoon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M12 3a6.4 6.4 0 0 0 9 9 9 9 0 1 1-9-9Z" />
  </Icon>
)

/** 跟随系统。主题切换用。 */
export const IconSunMoon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M12 8.5a2.9 2.9 0 0 0 4 4 4.1 4.1 0 1 1-4-4Z" />
    <path d="M12 2v2M12 20v2M4.9 4.9 6.3 6.3M17.7 17.7l1.4 1.4M2 12h2M20 12h2M6.3 17.7 4.9 19.1M19.1 4.9l-1.4 1.4" />
  </Icon>
)
