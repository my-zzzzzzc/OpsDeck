import type { NavItem, Tab } from '../nav'
import { Badge, Card, GhostButton } from '../ui'

/*
 * 占位页。
 *
 * 导航里保留了还没落地的页签(目前是「告警」)。点进去必须有个交代,
 * 否则用户会以为是加载失败或者自己点错了。
 *
 * 关键是**不能长得像错误状态**:不用红色、不用感叹号、不写「出错了」。
 * 它应该读起来像「这个房间已经盖好了,家具还没搬进来」——
 * 图标、标题、一句说明,再加一个回去的出口。
 *
 * 标题和说明直接从导航注册表取,不另写一份 ——
 * 占位页上的描述和侧边栏悬浮提示永远是同一句。
 */
export function BlankPanel({ item, onBack }: { item: NavItem; onBack: (t: Tab) => void }) {
  const { Icon } = item
  return (
    <Card className="flex flex-col items-center justify-center gap-4 px-6 py-20 text-center">
      <span className="flex size-12 items-center justify-center rounded-lg bg-sunken text-ink-tertiary">
        <Icon size={22} />
      </span>

      <div className="flex flex-col items-center gap-1.5">
        <div className="flex items-center gap-2">
          <h2 className="text-[15px] font-medium tracking-tight text-ink">{item.label}</h2>
          <Badge tone="neutral">开发中</Badge>
        </div>
        <p className="max-w-md text-[12.5px] leading-relaxed text-ink-tertiary">
          {item.description}
        </p>
      </div>

      <p className="max-w-md text-[12.5px] leading-relaxed text-ink-tertiary">
        这个页面已经在导航里占好位置,功能还没开发。先把信息架构定下来,再逐个补齐。
      </p>

      <GhostButton onClick={() => onBack('dashboard')}>回到仪表板</GhostButton>
    </Card>
  )
}
