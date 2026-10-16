import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { api, auth, type DifyApp } from '../api'
import { streamChat, type ChatUsage } from '../chat-stream'
import { Card, Empty, GhostButton } from '../ui'

/** 一条消息。role 决定气泡样式与对齐。 */
interface Message {
  id: string
  role: 'user' | 'assistant'
  content: string
  /** 流式进行中:用于显示光标与禁用输入 */
  streaming?: boolean
  usage?: ChatUsage
}

/**
 * 聊天界面。
 *
 * 支持:
 *   - 在多个 Dify 应用之间切换(每个应用是独立助手,上下文互不干扰)
 *   - 流式逐字输出
 *   - 中断正在进行的回复
 *   - 会话隔离:切换应用即开新会话
 */
export function ChatPanel() {
  const [apps, setApps] = useState<DifyApp[]>([])
  const [activeAppId, setActiveAppId] = useState<string | null>(null)
  const [messages, setMessages] = useState<Message[]>([])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // 每个应用各自维护会话 ID,切换回来还能延续上下文
  const conversations = useRef<Map<string, string>>(new Map())
  const abortRef = useRef<AbortController | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)

  const activeApp = useMemo(() => apps.find((a) => a.id === activeAppId) ?? null, [apps, activeAppId])

  useEffect(() => {
    api
      .difyApps()
      .then((list) => {
        const enabled = list.filter((a) => a.is_active)
        setApps(enabled)
        // 优先选中默认应用
        const preferred = enabled.find((a) => a.is_default) ?? enabled[0]
        setActiveAppId(preferred?.id ?? null)
      })
      .catch((e: Error) => setError(e.message))
  }, [])

  // 切换应用:清空当前消息(各应用上下文独立)
  useEffect(() => {
    setMessages([])
    setError(null)
  }, [activeAppId])

  // 新消息到达时滚到底部
  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages])

  const send = useCallback(async () => {
    const query = input.trim()
    if (!query || !activeApp || busy) return

    const token = auth.getToken()
    if (!token) {
      setError('登录已过期,请重新登录')
      return
    }

    setInput('')
    setError(null)
    setBusy(true)

    const userMsg: Message = { id: `u-${Date.now()}`, role: 'user', content: query }
    const replyId = `a-${Date.now()}`
    setMessages((prev) => [...prev, userMsg, { id: replyId, role: 'assistant', content: '', streaming: true }])

    const controller = new AbortController()
    abortRef.current = controller

    await streamChat(
      {
        appId: activeApp.id,
        query,
        conversationId: conversations.current.get(activeApp.id) ?? '',
        token,
        signal: controller.signal,
      },
      {
        onDelta: (text) => {
          setMessages((prev) =>
            prev.map((m) => (m.id === replyId ? { ...m, content: m.content + text } : m)),
          )
        },
        onDone: ({ conversationId, usage }) => {
          if (conversationId) conversations.current.set(activeApp.id, conversationId)
          setMessages((prev) =>
            prev.map((m) => (m.id === replyId ? { ...m, streaming: false, usage } : m)),
          )
          setBusy(false)
        },
        onError: (message) => {
          setError(message)
          // 出错的占位消息直接移除,避免留下空气泡
          setMessages((prev) => prev.filter((m) => m.id !== replyId))
          setBusy(false)
        },
      },
    )

    abortRef.current = null
  }, [input, activeApp, busy])

  const stop = () => {
    abortRef.current?.abort()
    abortRef.current = null
    setBusy(false)
    setMessages((prev) => prev.map((m) => (m.streaming ? { ...m, streaming: false } : m)))
  }

  if (apps.length === 0) {
    return (
      <Card>
        <Empty>
          还没有登记可用的 Dify 应用。请先在「Dify」页登记应用并填入 API Key ——
          每个应用对应一个独立助手(如升级助手、巡检助手)。
        </Empty>
      </Card>
    )
  }

  return (
    <div className="flex h-[calc(100vh-8rem)] flex-col gap-3">
      {/* 助手切换 */}
      <div className="flex items-center gap-2 overflow-x-auto">
        {apps.map((a) => (
          <button
            key={a.id}
            type="button"
            onClick={() => setActiveAppId(a.id)}
            className={`flex shrink-0 cursor-pointer items-center gap-2 rounded-md border px-2.5 py-1.5 text-[13px] transition-all duration-150 ${
              a.id === activeAppId
                ? 'border-accent bg-tint-blue font-medium text-accent'
                : 'border-line bg-primary text-ink-secondary hover:bg-overlay-light'
            }`}
          >
            {a.name}
            <span className="text-[10px] text-ink-tertiary">{MODE_LABEL[a.mode] ?? a.mode}</span>
          </button>
        ))}
      </div>

      {/* 消息区 */}
      <Card padded={false} className="flex min-h-0 flex-1 flex-col">
        <div className="flex items-center gap-2 border-b border-line px-3 py-2">
          <span className="text-[13px] font-medium">{activeApp?.name}</span>
          {activeApp?.description ? (
            <span className="text-[11px] text-ink-tertiary">{activeApp.description}</span>
          ) : null}
          <span className="ml-auto flex items-center gap-2">
            {messages.length > 0 ? (
              <GhostButton
                onClick={() => {
                  setMessages([])
                  if (activeApp) conversations.current.delete(activeApp.id)
                }}
              >
                清空
              </GhostButton>
            ) : null}
          </span>
        </div>

        <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto p-4">
          {messages.length === 0 ? (
            <div className="flex h-full items-center justify-center">
              <div className="text-center">
                <p className="text-[13px] text-ink-tertiary">
                  与「{activeApp?.name}」开始对话
                </p>
                <p className="mt-1 text-[11px] text-ink-tertiary">
                  回复由 Dify 生成,涉及运维操作时请自行确认再执行
                </p>
              </div>
            </div>
          ) : (
            <div className="flex flex-col gap-4">
              {messages.map((m) => (
                <MessageBubble key={m.id} message={m} />
              ))}
            </div>
          )}
        </div>

        {error ? (
          <div className="border-t border-line bg-tint-danger px-3 py-2 text-[12px] text-ink-danger">
            {error}
          </div>
        ) : null}

        {/* 输入区 */}
        <div className="border-t border-line p-3">
          <div className="flex items-end gap-2">
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                // Enter 发送,Shift+Enter 换行
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  void send()
                }
              }}
              rows={2}
              placeholder="输入消息,Enter 发送,Shift+Enter 换行"
              className="max-h-32 min-h-16 flex-1 resize-y rounded-md border border-line bg-primary px-3 py-2 text-[13px]
                text-ink outline-none transition-colors placeholder:text-ink-tertiary focus:border-accent"
            />
            {busy ? (
              <GhostButton onClick={stop}>停止</GhostButton>
            ) : (
              <button
                type="button"
                onClick={() => void send()}
                disabled={!input.trim()}
                className="h-16 shrink-0 cursor-pointer rounded-md bg-accent px-4 text-[13px] font-medium text-on-accent
                  transition-all duration-150 hover:bg-accent-hover active:scale-[0.98]
                  disabled:cursor-not-allowed disabled:opacity-40"
              >
                发送
              </button>
            )}
          </div>
        </div>
      </Card>
    </div>
  )
}

const MODE_LABEL: Record<string, string> = {
  chat: '助手',
  agent: 'Agent',
  completion: '生成',
  workflow: '工作流',
}

/** 单条消息。助手内容按纯文本渲染并保留换行。 */
function MessageBubble({ message }: { message: Message }) {
  const isUser = message.role === 'user'

  return (
    <div className={`flex gap-2.5 ${isUser ? 'justify-end' : ''}`}>
      {!isUser ? (
        <div className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full bg-tint-blue text-[11px] font-semibold text-accent">
          AI
        </div>
      ) : null}

      <div className={`max-w-[76%] ${isUser ? 'order-first' : ''}`}>
        <div
          className={`rounded-lg px-3 py-2 text-[13px] leading-relaxed whitespace-pre-wrap ${
            isUser ? 'bg-accent text-on-accent' : 'bg-overlay-lighter text-ink'
          }`}
        >
          {message.content}
          {message.streaming ? (
            <span className="ml-0.5 inline-block h-3.5 w-1.5 animate-pulse rounded-sm bg-ink-tertiary align-middle" />
          ) : null}
        </div>

        {message.usage?.totalTokens ? (
          <div className="mt-1 text-right text-[10px] text-ink-tertiary">
            {message.usage.totalTokens} tokens
          </div>
        ) : null}
      </div>
    </div>
  )
}
