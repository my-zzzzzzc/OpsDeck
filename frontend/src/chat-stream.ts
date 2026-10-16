/**
 * Dify 流式对话的客户端。
 *
 * Dify 以 SSE 返回事件流,事件类型:
 *   - message          逐字增量(delta)
 *   - message_end      本轮结束,带 conversation_id 与用量
 *   - error            出错
 *   - workflow_started / node_finished 等工作流事件(此处忽略)
 *
 * 关键点:必须用 fetch + ReadableStream 逐块解析,不能用 EventSource
 * (EventSource 只支持 GET,而 Dify 需要 POST 传 query)。
 */

export interface ChatUsage {
  promptTokens?: number
  completionTokens?: number
  totalTokens?: number
}

export interface StreamHandlers {
  /** 收到增量文本。 */
  onDelta: (text: string) => void
  /** 本轮结束。conversationId 用于下一轮保持上下文。 */
  onDone: (info: { conversationId: string; usage?: ChatUsage }) => void
  /** 出错。 */
  onError: (message: string) => void
}

export interface StreamOptions {
  appId: string
  query: string
  conversationId: string
  token: string
  signal?: AbortSignal
}

/** 发起一次流式对话,返回可用于中断的控制器。 */
export async function streamChat(options: StreamOptions, handlers: StreamHandlers): Promise<void> {
  const { appId, query, conversationId, token, signal } = options

  let response: Response
  try {
    response = await fetch('/api/chat/stream', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ app_id: appId, query, conversation_id: conversationId, inputs: {} }),
      signal,
    })
  } catch (err) {
    // 主动中断不算错误
    if ((err as Error).name === 'AbortError') return
    handlers.onError(`无法连接服务:${(err as Error).message}`)
    return
  }

  if (!response.ok) {
    const detail = await response.json().catch(() => ({ detail: response.statusText }))
    handlers.onError(detail.detail ?? `请求失败:${response.status}`)
    return
  }

  if (!response.body) {
    handlers.onError('服务未返回数据流')
    return
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let conversationIdOut = conversationId

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      buffer += decoder.decode(value, { stream: true })

      // SSE 以空行分隔事件;最后一段可能不完整,留到下次拼接
      const parts = buffer.split('\n\n')
      buffer = parts.pop() ?? ''

      for (const part of parts) {
        const line = part.split('\n').find((l) => l.startsWith('data:'))
        if (!line) continue

        const raw = line.slice(5).trim()
        if (!raw || raw === '[DONE]') continue

        let event: Record<string, unknown>
        try {
          event = JSON.parse(raw)
        } catch {
          continue
        }

        switch (event.event) {
          case 'message': {
            // Dify 的增量字段是 answer
            const text = typeof event.answer === 'string' ? event.answer : ''
            if (text) handlers.onDelta(text)
            break
          }
          case 'message_end': {
            if (typeof event.conversation_id === 'string') conversationIdOut = event.conversation_id
            const usage = event.metadata as { usage?: ChatUsage } | undefined
            handlers.onDone({ conversationId: conversationIdOut, usage: usage?.usage })
            return
          }
          case 'error': {
            handlers.onError(typeof event.message === 'string' ? event.message : '对话失败')
            return
          }
          default:
            // workflow 事件等无关类型直接跳过
            break
        }
      }
    }

    // 流结束但没收到 message_end(如被服务端截断)
    handlers.onDone({ conversationId: conversationIdOut })
  } catch (err) {
    if ((err as Error).name === 'AbortError') return
    handlers.onError(`读取响应失败:${(err as Error).message}`)
  } finally {
    reader.releaseLock()
  }
}
