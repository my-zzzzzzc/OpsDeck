import { useCallback, useEffect, useState } from 'react'

import { api, type DifyApp } from '../api'
import { Badge, Card, Empty, GhostButton, SectionTitle } from '../ui'

const MODE_LABEL: Record<string, string> = {
  chat: '聊天助手',
  agent: 'Agent',
  completion: '文本生成',
  workflow: '工作流',
}

/**
 * Dify 应用管理面板。仅管理员可见。
 *
 * API Key 只在创建/更新时提交,服务端只回传掩码值 —— 明文不会再次下发,
 * 因此编辑时留空表示"不修改 Key"。
 */
export function DifyPanel() {
  const [apps, setApps] = useState<DifyApp[]>([])
  const [form, setForm] = useState({ name: '', api_key: '', mode: 'chat', description: '' })
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null)
  const [busy, setBusy] = useState(false)
  const [pingResult, setPingResult] = useState<Record<string, string>>({})

  const reload = useCallback(async () => {
    try {
      setApps(await api.difyApps())
    } catch (err) {
      setMsg({ text: (err as Error).message, ok: false })
    }
  }, [])

  useEffect(() => {
    void reload()
  }, [reload])

  const create = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setMsg(null)
    try {
      await api.createDifyApp(form)
      setForm({ name: '', api_key: '', mode: 'chat', description: '' })
      setMsg({ text: '应用已登记', ok: true })
      await reload()
    } catch (err) {
      setMsg({ text: (err as Error).message, ok: false })
    } finally {
      setBusy(false)
    }
  }

  const ping = async (app: DifyApp) => {
    setPingResult((r) => ({ ...r, [app.id]: '探测中…' }))
    try {
      const res = await api.pingDifyApp(app.id)
      setPingResult((r) => ({ ...r, [app.id]: (res.ok ? '✓ ' : '✗ ') + res.message }))
    } catch (err) {
      setPingResult((r) => ({ ...r, [app.id]: '✗ ' + (err as Error).message }))
    }
  }

  const inputClass =
    'rounded-lg border border-line bg-secondary px-3 py-2 text-[13px] text-ink outline-none transition-colors focus:border-accent'

  return (
    <>
      <section className="mb-5">
        <SectionTitle>接入 Dify 应用</SectionTitle>
        <Card>
          <p className="mb-4 text-[13px] text-ink-tertiary">
            在 Dify 的应用页面进入「访问 API」，生成 API Key 后填入此处。Key 保存在服务端，
            不会下发给前端。用户登记后即可通过 <span className="mono">/api/chat/stream</span> 接入对话。
          </p>
          <form onSubmit={create} className="flex flex-wrap items-center gap-2.5">
            <input
              className={`${inputClass} w-40`}
              placeholder="应用名"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              required
            />
            <input
              className={`${inputClass} w-72`}
              placeholder="API Key（app-...）"
              value={form.api_key}
              onChange={(e) => setForm({ ...form, api_key: e.target.value })}
              required
            />
            <select
              className={inputClass}
              value={form.mode}
              onChange={(e) => setForm({ ...form, mode: e.target.value })}
              aria-label="应用类型"
            >
              <option value="chat">聊天助手</option>
              <option value="agent">Agent</option>
              <option value="completion">文本生成</option>
              <option value="workflow">工作流</option>
            </select>
            <input
              className={`${inputClass} w-56`}
              placeholder="用途说明（可选）"
              value={form.description}
              onChange={(e) => setForm({ ...form, description: e.target.value })}
            />
            <button
              type="submit"
              disabled={busy}
              className="rounded-lg bg-accent px-4 py-2 text-[13px] font-medium text-white transition-colors hover:bg-accent-hover disabled:opacity-60"
            >
              {busy ? '登记中…' : '登记'}
            </button>
          </form>
          {msg ? (
            <p className={`mt-3 text-[13px] ${msg.ok ? 'text-ink-success' : 'text-ink-danger'}`}>{msg.text}</p>
          ) : null}
        </Card>
      </section>

      <section>
        <SectionTitle>已登记应用（{apps.length}）</SectionTitle>
        <Card className="p-0">
          {apps.length === 0 ? (
            <div className="p-5">
              <Empty>还没有登记 Dify 应用。</Empty>
            </div>
          ) : (
            <div className="w-full overflow-x-auto">
              <table className="w-full min-w-[760px] text-[13px]">
                <thead>
                  <tr className="border-b border-line text-left text-xs text-ink-tertiary">
                    <th className="px-5 py-2.5 font-medium whitespace-nowrap">应用名</th>
                    <th className="px-3 py-2.5 font-medium whitespace-nowrap">类型</th>
                    <th className="px-3 py-2.5 font-medium whitespace-nowrap">API Key</th>
                    <th className="px-3 py-2.5 font-medium whitespace-nowrap">状态</th>
                    <th className="px-5 py-2.5 font-medium whitespace-nowrap">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {apps.map((a) => (
                    <tr key={a.id} className="border-b border-line last:border-0">
                      <td className="px-5 py-2.5">
                        <div className="font-medium">{a.name}</div>
                        {a.description ? (
                          <div className="text-xs text-ink-tertiary">{a.description}</div>
                        ) : null}
                      </td>
                      <td className="px-3 py-2.5 whitespace-nowrap">{MODE_LABEL[a.mode] ?? a.mode}</td>
                      <td className="mono px-3 py-2.5 text-xs whitespace-nowrap text-ink-tertiary">
                        {a.api_key_masked ?? '—'}
                      </td>
                      <td className="px-3 py-2.5">
                        <div className="flex flex-wrap gap-1.5">
                          <Badge tone={a.is_active ? 'ok' : 'bad'}>{a.is_active ? '启用' : '停用'}</Badge>
                          {a.is_default ? <Badge tone="warn">默认</Badge> : null}
                        </div>
                        {pingResult[a.id] ? (
                          <div className="mt-1 text-xs text-ink-tertiary">{pingResult[a.id]}</div>
                        ) : null}
                      </td>
                      <td className="px-5 py-2.5">
                        <div className="flex gap-1.5">
                          <GhostButton onClick={() => void ping(a)}>测试</GhostButton>
                          <GhostButton
                            disabled={a.is_default}
                            onClick={async () => {
                              await api.updateDifyApp(a.id, { is_default: true })
                              await reload()
                            }}
                          >
                            设为默认
                          </GhostButton>
                          <GhostButton
                            onClick={async () => {
                              await api.updateDifyApp(a.id, { is_active: !a.is_active })
                              await reload()
                            }}
                          >
                            {a.is_active ? '停用' : '启用'}
                          </GhostButton>
                          <GhostButton
                            onClick={() => {
                              if (!confirm(`确定删除应用 ${a.name}？`)) return
                              void api.deleteDifyApp(a.id).then(reload)
                            }}
                          >
                            删除
                          </GhostButton>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </section>
    </>
  )
}
