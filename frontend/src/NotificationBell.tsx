import { useEffect, useMemo, useRef, useState } from 'react'

import { EVENT_KIND_LABEL, type EventItem, type Server } from './api'
import { IconAlert, IconAlertOctagon, IconBell, IconCheck, IconCheckCircle } from './icons'
import { Badge, Empty } from './ui'

/*
 * 通知中心。
 *
 * 告警原本是看板下方的一张长卡片,只在首页可见 —— 翻到「服务器」页时,
 * 信息就断了。这里把它收进页头的一枚铃铛:入口常驻,明细按需展开。
 *
 * 三个刻意的选择:
 *
 * 1. **浮层而不是跳转。** 原来横幅上的「查看详情」是滚到下方卡片,用户
 *    读完得再滚回来。看告警是"打断",不是"导航" —— 就地展开、就地读完、
 *    就地关掉,才不打断手上的事。
 *
 * 2. **同一类故障折叠成一行。** 4 个容器反复退出会刷出 47 条事件,
 *    逐条列出来就把浮层变成了一张流水账。折叠后一行说明"是什么 + 多少次 +
 *    涉及哪些",这正是"要不要现在动手"所需要的最小信息量。
 *
 * 3. **只列未读,已读收进计数。** 浮层不是归档,读完的条目留在这里
 *    只会让下一次打开时,新的告警被旧的挤到下面。
 */

/** 从事件标题里取出主体(容器名 / 服务器名)。 */
function subjectOf(title: string): string | null {
  const colon = title.lastIndexOf(':')
  if (colon < 0) return null
  // 去掉标题里可能带的数值,如 "生产机-1 (98%)" → "生产机-1"
  return title.slice(colon + 1).trim().replace(/\s*\([^)]*\)\s*$/, '')
}

/** 把事件标题切成「条件 : 主体」。主体加粗,条件保持常规字重。 */
function titleParts(title: string): [string, string | null] {
  const i = title.lastIndexOf(':')
  if (i < 0) return [title, null]
  return [title.slice(0, i).trim(), title.slice(i + 1).trim()]
}

/**
 * 按「类型 + 服务器」折叠事件。
 *
 * 不按标题折叠:同一批容器反复退出、Swap 反复越阈值,本质是同一个问题
 * 在重复发生。逐条罗列只会把真正需要处理的信息淹没。
 */
function groupEvents(events: EventItem[]) {
  const map = new Map<
    string,
    {
      key: string
      label: string
      event: EventItem
      count: number
      unread: number
      members: string[]
    }
  >()

  for (const e of events) {
    const key = `${e.kind}:${e.server_id ?? 'unknown'}`
    const existing = map.get(key)

    if (existing) {
      existing.count += 1
      if (!e.acknowledged) existing.unread += 1
      const subject = subjectOf(e.title)
      if (subject && !existing.members.includes(subject)) existing.members.push(subject)
      // events 按时间倒序返回,首次遇到的就是最新
    } else {
      const subject = subjectOf(e.title)
      map.set(key, {
        key,
        label: EVENT_KIND_LABEL[e.kind] ?? e.kind,
        event: e,
        count: 1,
        unread: e.acknowledged ? 0 : 1,
        members: subject ? [subject] : [],
      })
    }
  }

  return [...map.values()].sort(
    (a, b) => new Date(b.event.created_at).getTime() - new Date(a.event.created_at).getTime(),
  )
}

/** 相对时间。运维关心"多久以前",而不是"几点几分"。 */
function relative(iso: string): string {
  const minutes = Math.floor(Math.max(0, Date.now() - new Date(iso).getTime()) / 60_000)
  if (minutes < 1) return '刚刚'
  if (minutes < 60) return `${minutes} 分钟前`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} 小时前`
  return `${Math.floor(hours / 24)} 天前`
}

function absolute(iso: string): string {
  return new Date(iso).toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

export function NotificationBell({
  events,
  servers,
  unacked,
  critical,
  onAck,
}: {
  events: EventItem[]
  servers: Server[]
  unacked: EventItem[]
  critical: number
  onAck: (id: number) => void | Promise<void>
}) {
  const [open, setOpen] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null)

  // 点外部 / Esc 关闭。仪表盘是常驻页面,浮层不关掉会一直挡着内容。
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [open])

  const groups = useMemo(() => groupEvents(events), [events])
  const unreadGroups = useMemo(() => groups.filter((g) => g.unread > 0), [groups])
  const readGroups = useMemo(() => groups.filter((g) => g.unread === 0), [groups])

  const hasIssue = unacked.length > 0
  const isBad = critical > 0
  const serverName = (id: string | null) => servers.find((s) => s.id === id)?.name ?? null

  return (
    <div ref={wrapRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-label={hasIssue ? `${unacked.length} 条未读告警` : '通知,无未读'}
        aria-expanded={open}
        title={hasIssue ? `${unacked.length} 条未读告警` : '通知'}
        className={`relative flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-md border-[0.5px] transition-colors ${
          hasIssue
            ? isBad
              ? 'border-line-danger bg-tint-danger text-ink-danger'
              : 'border-line-strong bg-tint-orange text-ink-warning'
            : 'border-line bg-primary text-ink-tertiary hover:bg-overlay-light hover:text-ink'
        }`}
      >
        <IconBell size={14} />
        {/*
          角标只报数量,颜色只区分"严重 / 注意"。
          没读的时候整个铃铛回到中性态 —— 一个常亮的红点等于没有红点。
        */}
        {hasIssue ? (
          <span
            className={`absolute -end-1 -top-1 flex h-3.5 min-w-3.5 items-center justify-center rounded-full px-1 text-[9px] leading-none font-semibold text-on-accent ${
              isBad ? 'bg-ink-danger' : 'bg-ink-warning'
            }`}
          >
            {unacked.length > 99 ? '99+' : unacked.length}
          </span>
        ) : null}
      </button>

      {open ? (
        <div
          role="dialog"
          aria-label="通知"
          className="absolute end-0 top-full z-50 mt-2 flex max-h-[min(560px,70vh)] w-[min(420px,calc(100vw-2rem))] flex-col overflow-hidden rounded-lg border-[0.5px] border-line bg-primary shadow-2xl"
        >
          {/* 头:一句话给结论,再给明细 */}
          <div className="flex shrink-0 items-center gap-2 border-b border-line px-3 py-2.5">
            <span className={hasIssue ? (isBad ? 'text-ink-danger' : 'text-ink-warning') : 'text-ink-success'}>
              {hasIssue ? isBad ? <IconAlertOctagon size={14} /> : <IconAlert size={14} /> : <IconCheckCircle size={14} />}
            </span>
            <span className="text-[13px] font-medium text-ink">
              {hasIssue ? `${unacked.length} 条未读告警` : '没有未读告警'}
            </span>
            {critical > 0 ? <Badge tone="bad">{critical} 严重</Badge> : null}
            <span className="ms-auto text-[11px] text-ink-tertiary">共 {events.length} 条</span>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto">
            {unreadGroups.length === 0 ? (
              <div className="px-4 py-10 text-center">
                <Empty>暂无未读告警。一切正常。</Empty>
              </div>
            ) : (
              unreadGroups.map((g) => {
                const [head, tail] = titleParts(g.event.title)
                const name = serverName(g.event.server_id)
                const bad = g.event.level === 'critical'

                return (
                  <div
                    key={g.key}
                    className={`group flex items-start gap-2.5 border-b border-l-2 border-line px-3 py-2.5 last:border-b-0 hover:bg-overlay-lighter ${
                      bad ? 'border-l-ink-danger' : 'border-l-ink-warning'
                    }`}
                  >
                    <span className={`mt-[3px] shrink-0 ${bad ? 'text-ink-danger' : 'text-ink-warning'}`}>
                      {bad ? <IconAlertOctagon size={13} /> : <IconAlert size={13} />}
                    </span>

                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="shrink-0 text-[11px] text-ink-tertiary">{g.label}</span>
                        <span className="truncate text-[13px] font-medium text-ink">
                          {head}
                          {tail ? (
                            <>
                              {': '}
                              <b className="font-semibold">{tail}</b>
                            </>
                          ) : name ? (
                            <>
                              {' '}
                              <b className="font-semibold">{name}</b>
                            </>
                          ) : null}
                        </span>
                        {g.count > 1 ? <Badge tone="neutral">×{g.count}</Badge> : null}
                      </div>

                      <div className="mt-0.5 flex items-center gap-1.5 text-[11px] text-ink-tertiary">
                        <span title={absolute(g.event.created_at)}>{relative(g.event.created_at)}</span>
                        {g.members.length > 1 ? (
                          <>
                            <span>·</span>
                            <span className="mono truncate">
                              涉及 {g.members.slice(0, 2).join('、')}
                              {g.members.length > 2 ? ` 等 ${g.members.length} 个` : ''}
                            </span>
                          </>
                        ) : g.event.detail ? (
                          <>
                            <span>·</span>
                            <span className="truncate" title={g.event.detail}>
                              {g.event.detail}
                            </span>
                          </>
                        ) : null}
                      </div>
                    </div>

                    <button
                      type="button"
                      onClick={() => void onAck(g.event.id)}
                      title="标记这一组为已读"
                      className="mt-0.5 flex shrink-0 cursor-pointer items-center gap-1 rounded-sm px-1.5 py-0.5 text-[11px] text-ink-tertiary transition-colors hover:bg-tint-blue hover:text-accent"
                    >
                      <IconCheck size={12} />
                      已读
                    </button>
                  </div>
                )
              })
            )}
          </div>

          {/* 脚:交代"已读的去哪了",否则用户会以为记录丢了 */}
          {readGroups.length > 0 ? (
            <div className="shrink-0 border-t border-line px-3 py-2 text-[11px] text-ink-tertiary">
              另有 {readGroups.length} 类已读告警已收起
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
