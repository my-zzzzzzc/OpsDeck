import { AlertTriangle, CheckCheck, ChevronDown, ChevronUp, X } from 'lucide-react'
import { useState } from 'react'

import type { EventItem, Server } from './api'
import { EVENT_KIND_LABEL } from './api'
import { cn } from './cn'

/*
 * 首页的未读告警条。
 *
 * 为什么要它:告警数据在应用层(useAlerts)是全局的,页头铃铛有角标,
 * 但角标只回答"有几条",不回答"是什么"。用户点进通知面板要一次跳转,
 * 而首页恰恰是处理告警最自然的位置 —— 所以把最上面的几条直接铺在这里。
 *
 * 三个设计决策:
 *
 * 1. **默认只展开最新 3 条**,更多收进"展开"。
 *    告警积压到几十条时,一屏铺满红字等于没有重点 —— 顶部几条是最新的,
 *    也是排查时最先要看的。
 *
 * 2. **同标题合并计数**。远程在修好之前会每 30 分钟重复一条相同的
 *    "容器已退出",铺出来就是十条同样的句子。合并成「×5」既诚实
 *    (数字看得见)又不刷屏。
 *
 * 3. **「全部已读」按钮只在该页出现**。批量 ack 是写操作,
 *    放在全局铃铛上误触代价高;放在告警条里,上下文明确、可反悔(可重开),
 *    是更安全的位置。
 */

/** 一条告警在条内的展示高度(折叠态下列表部分的最大高度)。 */
const LIST_MAX_H = 132

function levelTone(level: EventItem['level']): { dot: string; text: string; bg: string } {
  if (level === 'critical') return { dot: 'bg-ink-danger', text: 'text-ink-danger', bg: 'bg-tint-danger' }
  if (level === 'warning') return { dot: 'bg-ink-warning', text: 'text-ink-warning', bg: 'bg-tint-orange' }
  return { dot: 'bg-ink-tertiary', text: 'text-ink-secondary', bg: 'bg-overlay-light' }
}

export function AlertBanner({
  events,
  servers,
  onAck,
  onAckAll,
}: {
  events: EventItem[]
  servers: Server[]
  onAck: (id: number) => void
  onAckAll: () => Promise<void>
}) {
  const [expanded, setExpanded] = useState(false)
  const [busy, setBusy] = useState(false)

  if (events.length === 0) return null

  const serverNames = new Map(servers.map((s) => [s.id, s.name]))

  // 同标题合并:远程重复上报的同一故障,呈现为一条 + 计数
  const merged = new Map<string, { event: EventItem; count: number; ids: number[] }>()
  for (const e of events) {
    const g = merged.get(e.title)
    if (g) {
      g.count += 1
      g.ids.push(e.id)
    } else {
      merged.set(e.title, { event: e, count: 1, ids: [e.id] })
    }
  }
  const groups = [...merged.values()]

  const ackGroup = async (ids: number[]) => {
    for (const id of ids) onAck(id)
  }

  return (
    <div className={cn('rounded-lg border-[0.5px] border-line-warning/60 bg-tint-orange px-3.5 py-2.5')}>
      <div className="flex items-center gap-2">
        <AlertTriangle className="size-4 shrink-0 text-ink-warning" />
        <span className="shrink-0 text-[12.5px] font-semibold text-ink">
          {events.length} 条未读告警
        </span>
        {groups.length < events.length ? (
          <span className="shrink-0 text-[11px] text-ink-tertiary">
            {groups.length} 类问题
          </span>
        ) : null}

        <div className="ms-auto flex shrink-0 items-center gap-1">
          {groups.length > 3 ? (
            <button
              type="button"
              onClick={() => setExpanded((v) => !v)}
              className="flex cursor-pointer items-center gap-0.5 rounded-sm px-2 py-1 text-[11.5px] text-ink-secondary transition-colors hover:bg-overlay-light hover:text-ink"
            >
              {expanded ? '收起' : `展开全部 ${groups.length} 类`}
              {expanded ? <ChevronUp className="size-3" /> : <ChevronDown className="size-3" />}
            </button>
          ) : null}
          <button
            type="button"
            disabled={busy}
            onClick={async () => {
              setBusy(true)
              try {
                await onAckAll()
              } finally {
                setBusy(false)
              }
            }}
            className="flex cursor-pointer items-center gap-1 rounded-sm px-2 py-1 text-[11.5px] font-medium text-ink-warning transition-colors hover:bg-overlay-light disabled:cursor-not-allowed disabled:opacity-60"
          >
            <CheckCheck className="size-3.5" />
            全部已读
          </button>
        </div>
      </div>

      {/* 告警列表:折叠态限高滚动,展开态全量 */}
      <div
        className="mt-1.5 overflow-y-auto"
        style={{ maxHeight: expanded ? undefined : LIST_MAX_H }}
      >
        <div className="divide-y divide-line/60">
          {groups.slice(0, expanded ? undefined : 8).map(({ event: e, count, ids }) => {
            const tone = levelTone(e.level)
            return (
              <div key={e.title} className="group flex items-center gap-2 py-1.5">
                <span className={cn('size-1.5 shrink-0 rounded-full', tone.dot)} />
                <span className={cn('shrink-0 text-[10.5px] font-medium', tone.text)}>
                  {EVENT_KIND_LABEL[e.kind] ?? e.kind}
                </span>
                <span className="min-w-0 flex-1 truncate text-[12px] text-ink" title={e.detail ?? e.title}>
                  {e.title}
                </span>
                {count > 1 ? (
                  <span className="shrink-0 rounded-xs bg-overlay-light px-1.5 text-[10.5px] text-ink-tertiary">
                    ×{count}
                  </span>
                ) : null}
                <span className="shrink-0 text-[10.5px] tabular-nums text-ink-tertiary">
                  {e.server_id ? (serverNames.get(e.server_id) ?? '') : ''}
                </span>
                <button
                  type="button"
                  onClick={() => void ackGroup(ids)}
                  aria-label="标记已读"
                  className="shrink-0 cursor-pointer rounded-sm p-1 text-ink-tertiary opacity-0 transition-opacity hover:bg-overlay-light hover:text-ink group-hover:opacity-100"
                >
                  <X className="size-3" />
                </button>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
