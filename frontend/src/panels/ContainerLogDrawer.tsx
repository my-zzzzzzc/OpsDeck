import { AlertTriangle, ArrowDownToLine, Pause, Play, RefreshCw, Terminal, Trash2 } from 'lucide-react'
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'

import { auth } from '../api'
import { cn } from '../cn'

/*
 * 日志面板（项目级日志流）。
 *
 * 数据通道:
 *   打开/切换范围 —— 重连 WebSocket，后端用一条 `--since X --follow` 命令
 *                    同时回放历史和实时追加,不会出现重复行或中间缺口。
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

export function LogStreamPanel({ ariaLabel, streamUrl, liveNote, emptyText = '该时间范围内没有日志', className }: {
  ariaLabel: string
  /** 实时流地址，如 /ws/projects/1/logs；本组件会追加 since 查询参数。 */
  streamUrl: string
  /** 底部说明，例如跟随的命令或"容器未运行"。 */
  liveNote: string
  emptyText?: string
  className?: string
}) {
  const [lines, setLines] = useState<string[]>([])
  const [dropped, setDropped] = useState(0)
  const [range, setRange] = useState<RangeKey>('15m')
  const [following, setFollowing] = useState(true)
  const [status, setStatus] = useState<'connecting' | 'live' | 'error' | 'closed'>('connecting')
  const [message, setMessage] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)

  const bodyRef = useRef<HTMLDivElement>(null)
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

  // 一条 WebSocket 同时负责历史回放与实时跟随:切换范围时重连,
  // 避免 REST 快照与实时流之间出现重复或缺口。
  useEffect(() => {
    resetLines()
    setMessage(null)
    setStatus('connecting')
    const token = auth.getToken() ?? ''
    const proto = window.location.protocol === 'https:' ? 'wss' : 'ws'
    const url = `${proto}://${window.location.host}${streamUrl}?since=${range}`

    // 子协议携带 token:['bearer', token]
    const ws = new WebSocket(url, ['bearer', token])

    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data as string) as { type: string; text?: string; message?: string }
        if (msg.type === 'ready') {
          // 后端已经建立 SSH 流并开始回放,这时才算真正就绪。
          setStatus('live')
        } else if (msg.type === 'line' && msg.text !== undefined) {
          const stick = atBottom()
          append([msg.text])
          if (stick && followingRef.current) requestAnimationFrame(() => scrollToBottom())
        } else if (msg.type === 'end') {
          setStatus('closed')
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
        setMessage(ev.reason || '没有权限查看该日志')
      } else if (ev.code === 4401) {
        setStatus('error')
        setMessage(ev.reason || '登录已过期，请重新登录')
      } else if (ev.code === 1011) {
        // 后端报告错误后会用 1011 关闭,错误内容走消息帧,这里别覆盖成"已断开"。
        setStatus('error')
      } else if (ev.code !== 1000) {
        setStatus('closed')
      }
    }

    return () => {
      // StrictMode 下 effect 会立即卸载再挂载。被丢弃的这条连接如果还在握手,
      // 关闭会触发 error 事件,把新连接的状态改写成"异常" —— 先摘掉回调再关。
      ws.onmessage = null
      ws.onerror = null
      ws.onclose = null
      ws.close()
    }
  }, [streamUrl, range, attempt, atBottom, scrollToBottom, append, resetLines])

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

  // 连接级失败(如 WS 到不了后端)没有服务端消息,不能退化成"没有日志",
  // 否则用户会以为项目确实没输出。
  const errorText = lines.length === 0
    ? message ?? (status === 'error' ? '无法连接日志流,请确认服务可用后重试' : null)
    : null

  return (
    <section aria-label={ariaLabel} className={cn('flex min-h-0 min-w-0 flex-1 flex-col', className)}>
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

          {(status === 'closed' || status === 'error') && lines.length > 0 ? (
            <LogAction label="重新连接" onClick={retry}>
              <RefreshCw className="size-3" />
            </LogAction>
          ) : null}
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
        {errorText ? (
          <div className="flex h-full min-h-44 flex-col items-center justify-center gap-2 px-6 py-8 text-center">
            <AlertTriangle className="size-5 text-ink-danger" />
            <p className="text-[12px] font-medium text-ink-secondary">日志暂不可用</p>
            <p className="mono max-w-xl text-[11px] leading-relaxed break-words text-ink-tertiary">{errorText}</p>
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
                  {status === 'connecting' ? '正在读取…' : emptyText}
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
        <span className="ms-auto">{status === 'closed' ? '日志流已结束' : liveNote}</span>
      </div>
    </section>
  )
}
