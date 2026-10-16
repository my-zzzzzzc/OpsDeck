import type { ComponentType } from 'react'

import {
  IconActivity,
  IconAlert,
  IconBell,
  IconBoxes,
  IconCalendar,
  IconChat,
  IconContainer,
  IconFolderGit,
  IconGauge,
  IconGear,
  IconHammer,
  IconRoute,
  IconRocket,
  IconScroll,
  IconServer,
  IconSparkles,
  IconSwarm,
  IconSync,
  IconTerminal,
  IconUsers,
  IconZap,
} from './icons'

/*
 * 导航注册表。
 *
 * 导航结构只在这一个文件里定义,侧边栏、命令面板、页头三处都从这里读 ——
 * 之前这三处各写一份,加一个页签要改三个地方,漏一个就会出现
 * 「侧边栏有、搜不到」这种不一致。
 *
 * 分组照 Komodo 的 sidebar.tsx:顶部一组不分组,「资源」「通知」用带标题的
 * 分隔线,底部一组只画一条素线。导航项超过 5 个就该从顶栏挪进侧边栏,
 * 腾出来的顶栏中间位置留给全局搜索。
 */

export type Tab =
  | 'dashboard'
  | 'containers'
  | 'terminals'
  | 'stats'
  | 'servers'
  | 'swarm'
  | 'stacks'
  | 'deployments'
  | 'builds'
  | 'repos'
  | 'procedures'
  | 'actions'
  | 'syncs'
  | 'alerts'
  | 'updates'
  | 'schedules'
  | 'settings'
  | 'chat'
  | 'dify'
  | 'users'
  | 'audit'

export interface NavItem {
  key: Tab
  label: string
  description: string
  Icon: ComponentType<{ size?: number }>
  /** 仅管理员可见。非管理员直接不出现在导航与搜索里,而不是灰掉。 */
  adminOnly?: boolean
  /**
   * 功能是否已落地。
   *
   * false 的页签**保留在导航里**、点进去是一张说明性的占位页 ——
   * 先把信息架构定下来,功能逐个补。比「先藏起来,做完再放上去」好:
   * 用户一眼能看到系统打算长成什么样,也不会以为是自己找不到入口。
   */
  ready: boolean
}

export interface NavGroup {
  key: string
  /** 有标题 → 渲染「── 标题 ──」样式的分隔线 */
  label?: string
  /** 无标题但需要在上方画一条素线 */
  divider?: boolean
  items: NavItem[]
}

export const NAV_GROUPS: NavGroup[] = [
  {
    key: 'main',
    items: [
      {
        key: 'dashboard',
        label: '仪表板',
        description: '服务器、容器与告警的实时状态',
        Icon: IconGauge,
        ready: true,
      },
      {
        key: 'containers',
        label: '容器',
        description: '容器实例、镜像与运行状态',
        Icon: IconContainer,
        ready: false,
      },
      {
        key: 'terminals',
        label: '终端',
        description: '面向主机的交互式远程终端',
        Icon: IconTerminal,
        ready: false,
      },
      {
        key: 'stats',
        label: '统计数据',
        description: '资源指标的历史曲线与横向对比',
        Icon: IconActivity,
        ready: false,
      },
    ],
  },
  {
    key: 'resources',
    label: '资源',
    items: [
      {
        key: 'servers',
        label: '服务器',
        description: '主机接入、资源指标与远程终端',
        Icon: IconServer,
        ready: true,
      },
      {
        key: 'swarm',
        label: '蜂群',
        description: '集群节点、服务与调度编排',
        Icon: IconSwarm,
        ready: false,
      },
      {
        key: 'stacks',
        label: '堆栈',
        description: '一组服务的编排与整体起停',
        Icon: IconBoxes,
        ready: false,
      },
      {
        key: 'deployments',
        label: '部署',
        description: '部署单元、端口与白名单操作',
        Icon: IconRocket,
        ready: true,
      },
      {
        key: 'builds',
        label: '构建',
        description: '镜像构建任务与构建历史',
        Icon: IconHammer,
        ready: false,
      },
      {
        key: 'repos',
        label: '仓库',
        description: '代码仓库接入与拉取记录',
        Icon: IconFolderGit,
        ready: false,
      },
      {
        key: 'procedures',
        label: '程序',
        description: '多步骤运维流程的定义与执行',
        Icon: IconRoute,
        ready: false,
      },
      {
        key: 'actions',
        label: '行动',
        description: '可复用的单步运维操作',
        Icon: IconZap,
        ready: false,
      },
      {
        key: 'syncs',
        label: '同步',
        description: '配置在多环境之间的同步',
        Icon: IconSync,
        ready: false,
      },
    ],
  },
  {
    key: 'notifications',
    label: '通知',
    items: [
      {
        key: 'alerts',
        label: '警报',
        description: '告警规则与通知渠道',
        Icon: IconAlert,
        ready: false,
      },
      {
        key: 'updates',
        label: '更新',
        description: '版本更新与升级记录',
        Icon: IconBell,
        ready: false,
      },
    ],
  },
  {
    key: 'system',
    divider: true,
    items: [
      {
        key: 'schedules',
        label: '日程安排',
        description: '定时任务与维护窗口',
        Icon: IconCalendar,
        ready: false,
      },
      {
        key: 'settings',
        label: '设置',
        description: '系统偏好、凭据与集成',
        Icon: IconGear,
        ready: false,
      },
    ],
  },
  {
    key: 'admin',
    label: '管理',
    items: [
      {
        key: 'chat',
        label: '助手',
        description: '基于 Dify 应用的运维问答',
        Icon: IconChat,
        ready: true,
      },
      {
        key: 'dify',
        label: 'Dify',
        description: '应用接入与连通性检查',
        Icon: IconSparkles,
        ready: true,
        adminOnly: true,
      },
      {
        key: 'users',
        label: '用户管理',
        description: '账号、角色与权限',
        Icon: IconUsers,
        ready: true,
        adminOnly: true,
      },
      {
        key: 'audit',
        label: '审计日志',
        description: '关键操作的留痕与追溯',
        Icon: IconScroll,
        ready: true,
        adminOnly: true,
      },
    ],
  },
]

/** 扁平化的页签清单,按导航顺序。 */
export const NAV_ITEMS: NavItem[] = NAV_GROUPS.flatMap((g) => g.items)

/** 由注册表派生。页头与命令面板都从这里取,避免和导航各写一份而走样。 */
export const TAB_META = Object.fromEntries(NAV_ITEMS.map((i) => [i.key, i])) as Record<Tab, NavItem>
