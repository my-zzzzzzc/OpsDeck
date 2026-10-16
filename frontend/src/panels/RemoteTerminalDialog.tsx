import { useCallback, useEffect, useRef, useState } from 'react'

import { api, type Server, type TerminalSessionItem } from '../api'
import { Badge, GhostButton, PrimaryButton } from '../ui'

type ConnState = 'locked' | 'authorizing' | 'connecting' | 'connected' | 'closed' | 'error'

/**
 * 远程连接对话框。
 *
 * 安全动线:必须先输入终端密码换取一次性 ticket,再建立 WebSocket。
 * ticket 通过子协议传递(不出现在 URL 中),且绑定用户、服务器与客户端 IP。
 *
 * 组件同时是 xterm 实例与 WebSocket 的唯一属主,关闭时统一释放。
 */
export function RemoteTerminalDialog({ server, onClose }: { server: Server; onClose: () => void }) {
  const hostRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<import('@xterm/xterm').Terminal | null>(null)
  const fitRef = useRef<import('@xterm/addon-fit').FitAddon | null>(null)
  const wsRef = useRef<WebSocket | null>(null)
  const keepAliveRef = useRef<number | null>(null)

  const [state, setState] = useState<ConnState>('locked')
  const [message, setMessage] = useState<string | null>(null)
  const [sessions, setSessions] = useState<TerminalSessionItem[]>([])

  useEffect(() => {
    api
      .terminalSessions()
      .then((list) => setSessions(list.filter((s) => s.server_id === server.id).slice(0, 5)))
      .catch(() => undefined)
  }, [server.id])

  /** 释放全部资源。 */
  const teardown = useCallback(() => {
    if (keepAliveRef.current !== null) {
      window.clearInterval(keepAliveRef.current)
      keepAliveRef.current = null
    }
    if (wsRef.current) {
      wsRef.current.onclose = null
      wsRef.current.close()
      wsRef.current = null
    }
    if (termRef.current) {
      termRef.current.dispose()
      termRef.current = null
    }
    fitRef.current = null
  }, [])

  useEffect(() => teardown, [teardown])

  // Esc 关闭
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const connect = async () => {
    setMessage(null)
    setState('authorizing')

    let ticket: string
    try {
      const res = await api.authorizeTerminal(server.id)
      ticket = res.ticket
    } catch (err) {
      setState('error')
      setMessage((err as Error).message)
      return
    }

    const host = hostRef.current
    if (!host) return

    teardown()
    host.innerHTML = ''

    // 动态导入 xterm:只在真正打开终端时加载这 340KB
    const [{ Terminal }, { FitAddon }] = await Promise.all([
      import('@xterm/xterm'),
      import('@xterm/addon-fit'),
    ])

    const term = new Terminal({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
      scrollback: 5000,
      theme: { background: '#16161a', foreground: '#e6e8ee', cursor: '#6694ff' },
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(host)
    fit.fit()
    termRef.current = term
    fitRef.current = fit

    term.writeln(`\x1b[90m正在连接 ${server.name} (${server.ip ?? server.hostname})…\x1b[0m`)

    const proto = location.protocol === 'https:' ? 'wss' : 'ws'
    const ws = new WebSocket(`${proto}://${location.host}/ws/terminal/${server.id}`, ['bearer', ticket])
    ws.binaryType = 'arraybuffer'
    wsRef.current = ws

    setState('connecting')

    ws.onopen = () => {
      setState('connected')
      ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }))
    }

    ws.onmessage = (event) => {
      if (typeof event.data === 'string') {
        try {
          const frame = JSON.parse(event.data)
          if (frame.type === 'error') term.writeln(`\r\n\x1b[31m${frame.message}\x1b[0m`)
          return
        } catch {
          term.write(event.data)
          return
        }
      }
      term.write(new Uint8Array(event.data as ArrayBuffer))
    }

    ws.onclose = (e) => {
      if (keepAliveRef.current !== null) {
        window.clearInterval(keepAliveRef.current)
        keepAliveRef.current = null
      }
      term.writeln(`\r\n\x1b[90m── 连接已关闭${e.reason ? `:${e.reason}` : ''} ──\x1b[0m`)
      setState('closed')
      // 刷新会话记录,让用户看到刚结束的这次
      api.terminalSessions().then((l) => setSessions(l.filter((s) => s.server_id === server.id).slice(0, 5))).catch(() => undefined)
    }

    ws.onerror = () => {
      setState('error')
      setMessage('WebSocket 连接失败')
    }

    term.onData((data) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'input', data }))
    })

    // 尺寸同步防抖:拖拽窗口时不做无谓的重排
    let resizeTimer: number | null = null
    term.onResize(() => {
      if (resizeTimer !== null) window.clearTimeout(resizeTimer)
      resizeTimer = window.setTimeout(() => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }))
        }
      }, 150)
    })

    const observer = new ResizeObserver(() => {
      try {
        fit.fit()
      } catch {
        /* 布局未完成时忽略 */
      }
    })
    observer.observe(host)

    // 保活,防止中间代理因空闲断开
    keepAliveRef.current = window.setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'ping' }))
    }, 30000)

    term.focus()
  }

  const isBusy = state === 'connecting' || state === 'authorizing'
  const isActive = state === 'connected' || isBusy

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={onClose}
      role="presentation"
    >
      <div
        className="flex max-h-[92vh] w-full max-w-5xl flex-col overflow-hidden rounded-2xl border border-line bg-primary"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={`${server.name} 远程终端`}
      >
        {/* 标题栏 */}
        <div className="flex flex-wrap items-center gap-2.5 border-b border-line px-5 py-3">
          <strong className="text-[15px]">{server.name}</strong>
          <span className="mono text-xs text-ink-tertiary">
            root@{server.ip ?? server.hostname}:{server.ssh_port}
          </span>
          <Badge
            tone={
              state === 'connected'
                ? 'ok'
                : state === 'error'
                  ? 'bad'
                  : isActive
                    ? 'warn'
                    : 'neutral'
            }
          >
            {{
              locked: '未连接',
              authorizing: '验证中',
              connecting: '连接中',
              connected: '已连接',
              closed: '已断开',
              error: '错误',
            }[state]}
          </Badge>

          <div className="ml-auto flex items-center gap-2">
            {isActive ? (
              <GhostButton onClick={() => wsRef.current?.close(1000, '用户断开')}>断开</GhostButton>
            ) : null}
            <GhostButton onClick={onClose}>关闭</GhostButton>
          </div>
        </div>

        {/* 未连接:确认后即连接 */}
        {!isActive ? (
          <div className="border-b border-line px-5 py-4">
            <div className="flex flex-wrap items-center gap-3">
              <div className="min-w-0 flex-1">
                <p className="text-[13px] text-ink">
                  即将以 <span className="mono">root</span> 连接到{' '}
                  <span className="font-medium">{server.name}</span>
                </p>
                <p className="mt-1 text-[11px] text-ink-tertiary">
                  终端操作会被完整录制,并写入审计日志
                </p>
              </div>

              <div className="flex items-center gap-2">
                {state === 'closed' || state === 'error' ? (
                  <GhostButton onClick={() => void connect()}>重新连接</GhostButton>
                ) : null}
                <PrimaryButton
                  onClick={() => void connect()}
                  disabled={isBusy}
                >
                  {isBusy ? '连接中…' : '连接'}
                </PrimaryButton>
              </div>
            </div>

            {message ? (
              <p className={`mt-3 text-[13px] ${state === 'error' ? 'text-ink-danger' : 'text-ink-success'}`}>
                {message}
              </p>
            ) : null}

            {sessions.length > 0 ? (
              <div className="mt-3 border-t border-line pt-3">
                <div className="mb-1.5 text-xs text-ink-tertiary">最近会话</div>
                <ul className="flex flex-col gap-1">
                  {sessions.map((s) => (
                    <li key={s.id} className="tnum flex items-center gap-3 text-xs text-ink-tertiary">
                      <span>{new Date(s.started_at).toLocaleString('zh-CN')}</span>
                      <span>{s.username}</span>
                      <span>{s.close_reason ?? s.status}</span>
                      <span>
                        ↑{(s.bytes_in / 1024).toFixed(1)}K ↓{(s.bytes_out / 1024).toFixed(1)}K
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </div>
        ) : null}

        {/* 终端挂载点 */}
        <div
          ref={hostRef}
          className="min-h-[220px] flex-1 bg-[#16161a] px-2 py-2"
          style={{ display: isActive ? 'block' : 'none', height: isActive ? '62vh' : 0 }}
        />
      </div>
    </div>
  )
}
