import { AlertTriangle, ArrowDownToLine, Pause, Play, Terminal, Trash2 } from 'lucide-react'
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'

import { auth, type InstanceDetail } from '../api'
import { cn } from '../cn'

/*
 * 容器日志面板。
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
  { key: '15m', label: '最近 15 分钟', short: '15m' },
  { key: '1h', label: '最近 1 小时', short: '1h' },
  { key: '6h', label: '最近 6 小时', short: '6h' },
  { key: '24h', label: '最近 24 小时', short: '24h' },
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

function LogAction({ children, onClick, label, pressed }: {
  children: ReactNode
  onClick: () => void
  label: string
  pressed?: boolean
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      aria-pressed={pressed}
      className="flex h-6 cursor-pointer items-center gap-1 rounded-sm px-1.5 text-[10.5px] text-ink-tertiary transition-colors hover:bg-overlay-light hover:text-ink"
    >
      {children}
    </button>
  )
}

export function ContainerLogPanel({ container }: { container: InstanceDetail }) {
  const [lines, setLines] = useState<string[]>([])
  const [dropped, setDropped] = useState(0)
  const [range, setRange] = useState<RangeKey>('15m')
  const [following, setFollowing] = useState(true)
  const [status, setStatus] = useState<'connecting' | 'live' | 'error' | 'closed'>('connecting')
  const [message, setMessage] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)

  const bodyRef = useRef<HTMLDivElement>(null)
  const wsRef = useRef<WebSocket | null>(null)
  const totalRef = useRef(0)
  const followingRef = useRef(true)

  useEffect(() => {
    followingRef.current = following
  }, [following])

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
    totalRef.current += incoming.length
    setLines((prev) => {
      const next = prev.concat(incoming)
      return next.length > MAX_LINES ? next.slice(next.length - MAX_LINES) : next
    })
    setDropped(Math.max(0, totalRef.current - MAX_LINES))
  }, [])

  const resetLines = useCallback(() => {
    totalRef.current = 0
    setLines([])
    setDropped(0)
  }, [])

  // 打开或切换时间范围:先拉一段历史
  useEffect(() => {
    let cancelled = false
    resetLines()
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
        if (followingRef.current) requestAnimationFrame(() => scrollToBottom())
      } catch (err) {
        if (!cancelled) setMessage((err as Error).message)
      }
    })()

    return () => {
      cancelled = true
    }
  }, [container.id, range, attempt, append, resetLines, scrollToBottom])

  // 实时流。与时间范围无关,切换范围时不重连。
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
          if (stick && followingRef.current) requestAnimationFrame(() => scrollToBottom())
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
  }, [container.id, attempt, atBottom, scrollToBottom, append])

  const retry = () => {
    setMessage(null)
    setStatus('connecting')
    setAttempt((value) => value + 1)
  }

  const statusView = {
    connecting: { dot: 'bg-ink-warning', text: '连接中' },
    live: { dot: 'bg-ink-success', text: '实时' },
    error: { dot: 'bg-ink-danger', text: '异常' },
    closed: { dot: 'bg-ink-tertiary', text: '已断开' },
  }[status]

  return (
    <section aria-label={`${container.name} 的日志`} className="flex min-h-[18rem] min-w-0 flex-1 flex-col border-t border-line xl:min-h-0">
      <div className="flex shrink-0 flex-wrap items-center gap-x-2.5 gap-y-2 border-b border-line px-4 py-2">
        <span className="flex items-center gap-1.5 text-[11px] font-medium text-ink-secondary">
          <Terminal className="size-3.5 text-ink-tertiary" />
          日志
        </span>
        <span className="flex items-center gap-1.5 text-[10.5px] text-ink-tertiary">
          <span className={cn('size-1.5 rounded-full', statusView.dot)} />
          {statusView.text}
        </span>

        <div className="ms-auto flex flex-wrap items-center gap-1">
          <div role="group" aria-label="日志时间范围" className="flex items-center gap-0.5 rounded-md bg-sunken p-0.5">
            {RANGES.map((item) => {
              const active = range === item.key
              return (
                <button
                  key={item.key}
                  type="button"
                  onClick={() => setRange(item.key)}
                  title={item.label}
                  aria-pressed={active}
                  className={cn(
                    'h-6 cursor-pointer rounded-sm px-1.5 text-[10.5px] transition-colors',
                    active ? 'bg-overlay-medium font-medium text-ink' : 'text-ink-tertiary hover:text-ink-secondary',
                  )}
                >
                  {item.short}
                </button>
              )
            })}
          </div>

          <span className="mx-0.5 hidden h-4 w-px bg-line sm:block" />

          <LogAction
            label={following ? '暂停跟随' : '继续跟随最新日志'}
            onClick={() => {
              setFollowing((value) => !value)
              if (!following) requestAnimationFrame(() => scrollToBottom())
            }}
            pressed={following}
          >
            {following ? <Pause className="size-3" /> : <Play className="size-3" />}
            <span className="hidden sm:inline">{following ? '跟随' : '已暂停'}</span>
          </LogAction>

          <LogAction
            label="跳到最新"
            onClick={() => {
              scrollToBottom()
              setFollowing(true)
            }}
          >
            <ArrowDownToLine className="size-3" />
          </LogAction>

          <LogAction label="清空日志" onClick={resetLines}>
            <Trash2 className="size-3" />
          </LogAction>
        </div>
      </div>

      <div
        ref={bodyRef}
        className="min-h-0 flex-1 overflow-auto bg-sunken px-4 py-2.5"
        // 用户手动上滚时暂停跟随,避免和自动滚动打架
        onWheel={(event) => {
          if (event.deltaY < 0 && following) setFollowing(false)
        }}
      >
        {message && lines.length === 0 ? (
          <div className="flex h-full min-h-44 flex-col items-center justify-center gap-2 px-6 py-8 text-center">
            <AlertTriangle className="size-5 text-ink-danger" />
            <p className="text-[12px] font-medium text-ink-secondary">日志暂不可用</p>
            <p className="mono max-w-xl text-[11px] leading-relaxed break-words text-ink-tertiary">{message}</p>
            <button
              type="button"
              onClick={retry}
              className="mt-1 h-7 cursor-pointer rounded-sm border border-line bg-primary px-2.5 text-[11px] text-ink-secondary transition-colors hover:bg-overlay-light hover:text-ink"
            >
              重新连接
            </button>
          </div>
        ) : (
          <>
            {message ? (
              <div className="mb-2 rounded-md bg-tint-danger px-3 py-2 text-[11.5px] text-ink-danger">
                {message}
              </div>
            ) : null}

            {lines.length === 0 ? (
              <div className="flex h-full min-h-32 flex-col items-center justify-center gap-2 text-center">
                <Terminal className="size-5 text-ink-tertiary" />
                <p className="text-[12px] text-ink-tertiary">
                  {status === 'live' ? '该时间范围内没有日志' : '正在读取…'}
                </p>
              </div>
            ) : (
              <pre className="mono text-[11.5px] leading-[1.65] whitespace-pre-wrap break-all">
                {dropped > 0 ? (
                  <span className="text-ink-tertiary">
                    {`…… 已省略较早的 ${dropped} 行（超过 ${MAX_LINES} 行上限）\n`}
                  </span>
                ) : null}
                {lines.map((line, index) => (
                  <span key={index} className={cn('block hover:bg-overlay-lighter', lineTone(line))}>
                    {line}
                  </span>
                ))}
              </pre>
            )}
          </>
        )}
      </div>

      <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-t border-line px-4 py-1.5 text-[10.5px] text-ink-tertiary">
        <span className="tabular-nums">{lines.length} 行</span>
        {dropped > 0 ? <span className="text-ink-warning">已省略 {dropped} 行</span> : null}
        <span className="ms-auto">
          {container.state === 'running' ? 'docker logs --follow' : '容器未运行，仅显示历史日志'}
        </span>
      </div>
    </section>
  )
}
