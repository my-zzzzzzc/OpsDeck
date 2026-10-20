import { ArrowDownToLine, Pause, Play, Trash2 } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'

import { auth, type InstanceDetail } from '../api'
import { cn } from '../cn'
import { GhostButton } from '../ui'

/*
 * 容器日志面板。
 *
 * 日志嵌在容器详情主区中，列表保持在左侧，排查时无需打开抽屉或离开当前页面。
 *
 * 两条数据通道:
 *   打开时   —— REST 拉一段历史(since),把首屏铺满
 *   之后     —— WebSocket 接 `docker logs --follow` 实时追加
 *
 * 三个必须处理的细节:
 *
 * 1. **自动滚动只在用户已经在底部时才生效**。
 *    用户往上翻看历史时,新日志继续把视口往下拽,会让人没法读 ——
 *    所以滚动位置决定要不要跟。
 *
 * 2. **行数上限**。`--follow` 是无限流,长时间挂着能吃掉几百 MB 内存,
 *    浏览器会卡死。这里硬性截断到 2000 行,并明确告诉用户"已省略 N 行",
 *    而不是静默丢弃。
 *
 * 3. **token 走子协议而不是 URL**。URL 会进访问日志、浏览器历史、
 *    以及任何中间代理的日志。
 */

const MAX_LINES = 2000

const RANGES = [
  { key: '15m', label: '最近 15 分钟' },
  { key: '1h', label: '最近 1 小时' },
  { key: '6h', label: '最近 6 小时' },
  { key: '24h', label: '最近 24 小时' },
] as const

type RangeKey = (typeof RANGES)[number]['key']

/** 单行日志的分级着色。只认最常见的几个词,不做完整词法分析。 */
function lineTone(line: string): string {
  const upper = line.toUpperCase()
  if (upper.includes('ERROR') || upper.includes('FATAL') || upper.includes('TRACEBACK')) {
    return 'text-ink-danger'
  }
  if (upper.includes('WARN')) return 'text-ink-warning'
  return 'text-ink-secondary'
}

export function ContainerLogPanel({ container }: { container: InstanceDetail }) {
  const [lines, setLines] = useState<string[]>([])
  const [dropped, setDropped] = useState(0)
  const [range, setRange] = useState<RangeKey>('15m')
  const [following, setFollowing] = useState(true)
  const [status, setStatus] = useState<'connecting' | 'live' | 'error' | 'closed'>('connecting')
  const [message, setMessage] = useState<string | null>(null)

  const bodyRef = useRef<HTMLDivElement>(null)
  const wsRef = useRef<WebSocket | null>(null)

  /** 视口是否停在底部。决定新行进来时要不要滚动。 */
  const atBottom = useCallback(() => {
    const el = bodyRef.current
    if (!el) return true
    return el.scrollHeight - el.scrollTop - el.clientHeight < 40
  }, [])

  const scrollToBottom = useCallback(() => {
    const el = bodyRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [])

  /** 追加一批行,并维护行数上限。 */
  const append = useCallback((incoming: string[]) => {
    if (incoming.length === 0) return
    setLines((prev) => {
      const next = prev.concat(incoming)
      if (next.length > MAX_LINES) {
        const cut = next.length - MAX_LINES
        setDropped((d) => d + cut)
        return next.slice(cut)
      }
      return next
    })
  }, [])

  // 打开:先拉一段历史
  useEffect(() => {
    let cancelled = false
    setLines([])
    setDropped(0)
    setMessage(null)

    ;(async () => {
      try {
        const res = await fetch(`/api/containers/${container.id}/logs?since=${range}&tail=200`, {
          headers: { Authorization: `Bearer ${auth.getToken() ?? ''}` },
        })
        if (!res.ok) {
          const detail = await res.json().catch(() => ({ detail: `HTTP ${res.status}` }))
          throw new Error(detail.detail ?? `HTTP ${res.status}`)
        }
        const data = (await res.json()) as { lines: string[] }
        if (cancelled) return
        append(data.lines)
        // 首屏铺完后直接到底部
        requestAnimationFrame(() => scrollToBottom())
      } catch (err) {
        if (!cancelled) setMessage((err as Error).message)
      }
    })()

    return () => {
      cancelled = true
    }
  }, [container.id, range, append, scrollToBottom])

  // 实时流
  useEffect(() => {
    setStatus('connecting')
    const token = auth.getToken() ?? ''
    const proto = window.location.protocol === 'https:' ? 'wss' : 'ws'
    const url = `${proto}://${window.location.host}/ws/containers/${container.id}/logs`

    // 子协议携带 token:['bearer', token]
    const ws = new WebSocket(url, ['bearer', token])
    wsRef.current = ws

    ws.onopen = () => setStatus('live')
    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data as string) as { type: string; text?: string; message?: string }
        if (msg.type === 'line' && msg.text !== undefined) {
          const stick = atBottom()
          append([msg.text])
          if (stick && following) requestAnimationFrame(() => scrollToBottom())
        } else if (msg.type === 'error') {
          setStatus('error')
          setMessage(msg.message ?? '日志流异常')
        }
      } catch {
        /* 非 JSON 帧忽略 */
      }
    }
    ws.onerror = () => setStatus('error')
    ws.onclose = (ev) => {
      // 4403 = 无权限;其余按断开处理
      if (ev.code === 4403) {
        setStatus('error')
        setMessage(ev.reason || '只有管理员可以查看容器日志')
      } else if (ev.code !== 1000) {
        setStatus('closed')
      }
    }

    return () => {
      wsRef.current = null
      ws.onclose = null
      ws.close()
    }
  }, [container.id, range, atBottom, scrollToBottom, following, append])

  const statusView = {
    connecting: { dot: 'bg-ink-warning', text: '连接中…' },
    live: { dot: 'bg-ink-success', text: '实时' },
    error: { dot: 'bg-ink-danger', text: '错误' },
    closed: { dot: 'bg-ink-tertiary', text: '已断开' },
  }[status]

  return (
    <section aria-label={`${container.name} 的日志`} className="flex min-h-0 flex-1 flex-col border-t border-line">
      {/* 工具行 */}
      <div className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-2">
          <select
            value={range}
            onChange={(e) => setRange(e.target.value as RangeKey)}
            aria-label="时间范围"
            className="h-7 cursor-pointer rounded-md border border-line bg-primary px-2 text-[11.5px] text-ink outline-none focus:border-accent"
          >
            {RANGES.map((r) => (
              <option key={r.key} value={r.key}>
                {r.label}
              </option>
            ))}
          </select>

          <GhostButton
            onClick={() => {
              setFollowing((v) => !v)
              if (!following) requestAnimationFrame(() => scrollToBottom())
            }}
          >
            <span className="flex items-center gap-1">
              {following ? <Pause className="size-3" /> : <Play className="size-3" />}
              {following ? '暂停跟随' : '跟随最新'}
            </span>
          </GhostButton>

          <GhostButton
            onClick={() => {
              scrollToBottom()
              setFollowing(true)
            }}
          >
            <span className="flex items-center gap-1">
              <ArrowDownToLine className="size-3" />
              跳到最新
            </span>
          </GhostButton>

          <GhostButton
            onClick={() => {
              setLines([])
              setDropped(0)
            }}
          >
            <span className="flex items-center gap-1">
              <Trash2 className="size-3" />
              清屏
            </span>
          </GhostButton>

          <span className="ms-auto flex items-center gap-1.5 text-[11px] text-ink-tertiary">
            <span className={cn('size-1.5 rounded-full', statusView.dot)} />
            {statusView.text}
          </span>
      </div>

        {/* 日志正文 */}
      <div
        ref={bodyRef}
        className="min-h-0 flex-1 overflow-auto bg-sunken px-4 py-2.5"
          // 用户手动上滚时暂停跟随,避免和自动滚动打架
          onWheel={(e) => {
            if (e.deltaY < 0 && following) setFollowing(false)
          }}
      >
          {message ? (
            <div className="mb-2 rounded-md bg-tint-danger px-3 py-2 text-[12px] text-ink-danger">
              {message}
            </div>
          ) : null}

          {lines.length === 0 && !message ? (
            <p className="py-8 text-center text-[12px] text-ink-tertiary">
              {status === 'live' ? '该时间范围内没有日志' : '正在读取…'}
            </p>
          ) : (
            <pre className="mono text-[11.5px] leading-[1.65] whitespace-pre-wrap break-all">
              {dropped > 0 ? (
                <span className="text-ink-tertiary">
                  {`…… 已省略较早的 ${dropped} 行(超过 ${MAX_LINES} 行上限)\n`}
                </span>
              ) : null}
              {lines.map((line, i) => (
                <span key={i} className={cn('block', lineTone(line))}>
                  {line}
                </span>
              ))}
            </pre>
          )}
      </div>

        {/* 底部状态 */}
      <div className="flex items-center gap-3 border-t border-line px-4 py-2 text-[11px] text-ink-tertiary">
        <span className="tnum">{lines.length} 行</span>
        {dropped > 0 ? <span className="text-ink-warning">已省略 {dropped} 行</span> : null}
        <span className="ms-auto">
          {container.state === 'running' ? 'docker logs --follow' : '该容器未运行,仅显示历史日志'}
        </span>
      </div>
    </section>
  )
}
