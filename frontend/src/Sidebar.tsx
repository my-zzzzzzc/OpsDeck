import { useEffect } from 'react'

import { NAV_GROUPS, type NavItem, type Tab } from './nav'

/*
 * 分组侧边栏。
 *
 * 照 Komodo 的 sidebar.tsx:导航项超过 5 个就从顶栏挪进来,
 * 腾出来的顶栏中间位置留给全局搜索。
 *
 * 三个刻意的选择:
 *
 * 1. **选中态用底色,不额外加边框。** 只有当前项有实底,其余全是 ghost ——
 *    一列 21 个项,如果每项都描边,侧边栏会变成一张网格。
 *    权重靠「实底 vs 透明」这一层就够了,不需要第二层信号。
 *
 * 2. **分组标题用居中带线的分隔线**,而不是左对齐的小标题。
 *    居中线把「一组」和「上一组」在视觉上断开,左对齐标题做不到这一点 ——
 *    它看起来只是又一个项目。
 *
 * 3. **宽度 200px 固定**,不做拖拽。侧边栏宽度一变,里面的文字换行位置就变,
 *    21 项的换行参差不齐比窄一点更难读。
 *
 *    200px 的来历:最长的一项是「统计数据」(4 字 × 13px ≈ 52px),
 *    连同 15px 图标、10px 间距与 20px 内边距,占用约 97px。
 *    240px 时有近六成宽度常年空着;收到 200px 仍留一倍余量,一个字都不会折行,
 *    内容区在 1512px 视口下则从 1204px 让到 1244px。
 */

const ITEM_CLS =
  'flex w-full items-center gap-2.5 rounded-md px-2.5 py-[7px] text-left text-[13px] transition-colors duration-150 cursor-pointer'

/** 分组之间的分隔。有标题 → 居中带线;无标题 → 一条素线。 */
function GroupDivider({ label }: { label?: string }) {
  if (!label) {
    return <div className="my-2 h-px bg-overlay-medium" />
  }
  return (
    <div className="my-2 flex items-center gap-2 px-1" aria-hidden="true">
      <span className="h-px flex-1 bg-overlay-medium" />
      <span className="text-[11px] whitespace-nowrap text-ink-tertiary">{label}</span>
      <span className="h-px flex-1 bg-overlay-medium" />
    </div>
  )
}

function NavRow({
  item,
  active,
  onSelect,
}: {
  item: NavItem
  active: boolean
  onSelect: (key: Tab) => void
}) {
  const { Icon } = item
  return (
    <button
      type="button"
      onClick={() => onSelect(item.key)}
      aria-current={active ? 'page' : undefined}
      title={item.description}
      className={`${ITEM_CLS} ${
        active
          ? 'bg-secondary font-medium text-ink'
          : 'text-ink-secondary hover:bg-accent-soft hover:text-ink'
      }`}
    >
      <span className={active ? 'shrink-0 text-ink' : 'shrink-0 text-ink-tertiary'}>
        <Icon size={15} />
      </span>
      <span className="truncate">{item.label}</span>
    </button>
  )
}

/** 导航列表本体。桌面列与移动抽屉共用,保证两处不会长歪。 */
function NavList({
  tab,
  setTab,
  canSee,
  onNavigate,
}: {
  tab: Tab
  setTab: (t: Tab) => void
  canSee: (k: Tab) => boolean
  onNavigate?: () => void
}) {
  return (
    <div className="flex flex-col">
      {NAV_GROUPS.map((group) => {
        const items = group.items.filter((i) => canSee(i.key))
        // 整组都不可见(比如非管理员看「管理」组里的三个)时,连分隔线一起省掉
        if (items.length === 0) return null
        return (
          <div key={group.key}>
            {group.label || group.divider ? <GroupDivider label={group.label} /> : null}
            <div className="flex flex-col gap-0.5">
              {items.map((item) => (
                <NavRow
                  key={item.key}
                  item={item}
                  active={tab === item.key}
                  onSelect={(k) => {
                    setTab(k)
                    onNavigate?.()
                  }}
                />
              ))}
            </div>
          </div>
        )
      })}
    </div>
  )
}

/**
 * 桌面侧边栏。
 *
 * `sticky` + 自身滚动:页面内容很长时侧边栏要一直在视野里,
 * 但 21 项在矮屏上放不下,所以给它自己的滚动区,而不是让整页滚。
 */
export function Sidebar({
  tab,
  setTab,
  canSee,
}: {
  tab: Tab
  setTab: (t: Tab) => void
  canSee: (k: Tab) => boolean
}) {
  return (
    <aside className="hidden w-50 shrink-0 lg:block">
      <nav
        aria-label="主导航"
        className="sticky top-4 max-h-[calc(100vh-2rem)] overflow-y-auto pb-4"
      >
        <NavList tab={tab} setTab={setTab} canSee={canSee} />
      </nav>
    </aside>
  )
}

/**
 * 移动端抽屉。
 *
 * 窄屏放不下 200px 的侧边栏,但也不能把导航整个藏起来 ——
 * 顶栏的汉堡按钮唤出这一层。
 */
export function SidebarDrawer({
  open,
  onClose,
  tab,
  setTab,
  canSee,
}: {
  open: boolean
  onClose: () => void
  tab: Tab
  setTab: (t: Tab) => void
  canSee: (k: Tab) => boolean
}) {
  // Esc 关闭。抽屉铺满高度,不关掉就没法回到内容区。
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null

  return (
    <div className="fixed inset-0 z-[70] lg:hidden">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} aria-hidden="true" />
      <nav
        aria-label="主导航"
        className="absolute inset-y-0 start-0 w-64 overflow-y-auto border-e border-line bg-primary p-3 shadow-2xl"
      >
        <NavList tab={tab} setTab={setTab} canSee={canSee} onNavigate={onClose} />
      </nav>
    </div>
  )
}
