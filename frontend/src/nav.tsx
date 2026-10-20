import type { ComponentType } from 'react'

import {
  IconAlert,
  IconBell,
  IconChat,
  IconContainer,
  IconGauge,
  IconRocket,
  IconScroll,
  IconServer,
  IconSparkles,
  IconUsers,
} from './icons'

/*
 * 导航注册表。
 *
 * 导航结构只在这一个文件里定义,侧边栏、命令面板、页头三处都从这里读 ——
 * 之前这三处各写一份,加一个页签要改三个地方,漏一个就会出现
 * 「侧边栏有、搜不到」这种不一致。
 *
 * 分组照 Komodo 的 sidebar.tsx:顶部一组不分组,「资源」「运维」用带标题的
 * 分隔线,管理类入口归在最后一组。导航项超过 5 个就该从顶栏挪进侧边栏,
 * 腾出来的顶栏中间位置留给全局搜索。
 */

export type Tab =
  | 'dashboard'
  | 'containers'
  | 'servers'
  | 'deployments'
  | 'alerts'
  | 'updates'
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
   * false 的页签点进去是一张说明性的占位页。只在功能已经排上日程、
   * 入口本身能说明产品方向时使用;没有明确落地计划的入口不要放进导航。
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
        ready: true,
      },
      {
        key: 'chat',
        label: 'AI 助手',
        description: '基于 Dify 应用的 AI 运维问答',
        Icon: IconChat,
        ready: true,
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
        key: 'deployments',
        label: '项目',
        description: '项目资产、部署状态与运维操作',
        Icon: IconRocket,
        ready: true,
      },
    ],
  },
  {
    key: 'ops',
    label: '运维',
    items: [
      {
        key: 'alerts',
        label: '告警',
        description: '告警规则与通知渠道',
        Icon: IconAlert,
        ready: false,
      },
      {
        key: 'updates',
        label: '版本更新',
        description: '上游版本检测与升级记录',
        Icon: IconBell,
        ready: true,
      },
    ],
  },
  {
    key: 'admin',
    label: '管理',
    items: [
      {
        key: 'dify',
        label: 'Dify 接入',
        description: 'Dify 应用接入与连通性检查',
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
