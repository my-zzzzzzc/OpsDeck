import { useCallback, useEffect, useState } from 'react'

import { api, type User } from '../api'
import { useHeaderMeta } from '../header-meta'
import { Badge, Card, Empty, GhostButton, SectionTitle } from '../ui'

const ROLE_LABEL: Record<string, string> = { admin: '管理员', operator: '运维', viewer: '只读' }

/**
 * 用户管理面板。仅管理员可见。
 * 表单与列表同属该面板的会话状态,因此由本组件持有。
 */
export function UsersPanel({ currentUser }: { currentUser: User }) {
  const [users, setUsers] = useState<User[]>([])
  const [form, setForm] = useState({ username: '', password: '', role: 'viewer', display_name: '' })
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null)
  const [busy, setBusy] = useState(false)

  const reload = useCallback(async () => {
    try {
      setUsers(await api.users())
    } catch (err) {
      setMsg({ text: (err as Error).message, ok: false })
    }
  }, [])

  useEffect(() => {
    void reload()
  }, [reload])

  // 数量交给页头,内容区不再重复「用户管理」这个页面名
  useHeaderMeta(users.length > 0 ? `${users.length} 个账号` : null)

  const create = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setMsg(null)
    try {
      await api.createUser(form)
      setForm({ username: '', password: '', role: 'viewer', display_name: '' })
      setMsg({ text: '用户已创建', ok: true })
      await reload()
    } catch (err) {
      setMsg({ text: (err as Error).message, ok: false })
    } finally {
      setBusy(false)
    }
  }

  const mutate = async (fn: () => Promise<unknown>, okText?: string) => {
    try {
      await fn()
      if (okText) setMsg({ text: okText, ok: true })
      await reload()
    } catch (err) {
      setMsg({ text: (err as Error).message, ok: false })
    }
  }

  const inputClass =
    'rounded-lg border border-line bg-secondary px-3 py-2 text-[13px] text-ink outline-none transition-colors focus:border-accent'

  return (
    <>
      <section className="mb-5">
        <SectionTitle>新建用户</SectionTitle>
        <Card>
          <form onSubmit={create} className="flex flex-wrap items-center gap-2.5">
            <input
              className={`${inputClass} w-40`}
              placeholder="用户名"
              value={form.username}
              onChange={(e) => setForm({ ...form, username: e.target.value })}
              required
              minLength={3}
            />
            <input
              className={`${inputClass} w-64`}
              type="password"
              placeholder="密码（至少 8 位，含字母与数字）"
              value={form.password}
              onChange={(e) => setForm({ ...form, password: e.target.value })}
              required
              minLength={8}
            />
            <input
              className={`${inputClass} w-40`}
              placeholder="显示名（可选）"
              value={form.display_name}
              onChange={(e) => setForm({ ...form, display_name: e.target.value })}
            />
            <select
              className={inputClass}
              value={form.role}
              onChange={(e) => setForm({ ...form, role: e.target.value })}
              aria-label="角色"
            >
              <option value="viewer">只读</option>
              <option value="operator">运维</option>
              <option value="admin">管理员</option>
            </select>
            <button
              type="submit"
              disabled={busy}
              className="rounded-lg bg-accent px-4 py-2 text-[13px] font-medium text-on-accent transition-colors
                hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-60"
            >
              {busy ? '创建中…' : '创建'}
            </button>
          </form>

          {msg ? (
            <p className={`mt-3 text-[13px] ${msg.ok ? 'text-ink-success' : 'text-ink-danger'}`}>
              {msg.text}
            </p>
          ) : null}
        </Card>
      </section>

      <section>
        <Card className="p-0">
          {users.length === 0 ? (
            <div className="p-5">
              <Empty>暂无用户。</Empty>
            </div>
          ) : (
            <div className="w-full overflow-x-auto">
              <table className="w-full min-w-[760px] text-[13px]">
                <thead>
                  <tr className="border-b border-line text-left text-xs text-ink-tertiary">
                    <th className="px-5 py-2.5 font-medium whitespace-nowrap">用户名</th>
                    <th className="px-3 py-2.5 font-medium whitespace-nowrap">显示名</th>
                    <th className="px-3 py-2.5 font-medium whitespace-nowrap">角色</th>
                    <th className="px-3 py-2.5 font-medium whitespace-nowrap">状态</th>
                    <th className="px-3 py-2.5 font-medium whitespace-nowrap">最后登录</th>
                    <th className="px-5 py-2.5 font-medium whitespace-nowrap">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {users.map((u) => {
                    const isSelf = u.id === currentUser.id
                    return (
                      <tr key={u.id} className="border-b border-line last:border-0">
                        <td className="mono px-5 py-2.5 whitespace-nowrap">
                          {u.username}
                          {isSelf ? <span className="text-ink-tertiary"> （我）</span> : null}
                        </td>
                        <td className="px-3 py-2.5">{u.display_name ?? '—'}</td>
                        <td className="px-3 py-2.5">
                          <select
                            className="rounded-md border border-line bg-secondary px-2 py-1 text-xs outline-none focus:border-accent disabled:opacity-40"
                            value={u.role}
                            disabled={isSelf}
                            aria-label={`${u.username} 的角色`}
                            onChange={(e) =>
                              void mutate(
                                () => api.updateUser(u.id, { role: e.target.value }),
                                `${u.username} 角色已改为 ${ROLE_LABEL[e.target.value]}`,
                              )
                            }
                          >
                            <option value="viewer">只读</option>
                            <option value="operator">运维</option>
                            <option value="admin">管理员</option>
                          </select>
                        </td>
                        <td className="px-3 py-2.5">
                          <Badge tone={u.is_active ? 'ok' : 'bad'}>
                            {u.is_active ? '启用' : '停用'}
                          </Badge>
                        </td>
                        <td className="tnum px-3 py-2.5 text-xs whitespace-nowrap text-ink-tertiary">
                          {u.last_login_at
                            ? new Date(u.last_login_at).toLocaleString('zh-CN')
                            : '从未'}
                        </td>
                        <td className="px-5 py-2.5">
                          <div className="flex gap-1.5">
                            <GhostButton
                              disabled={isSelf}
                              onClick={() => void mutate(() => api.updateUser(u.id, { is_active: !u.is_active }))}
                            >
                              {u.is_active ? '停用' : '启用'}
                            </GhostButton>
                            <GhostButton
                              disabled={isSelf}
                              onClick={() => {
                                if (!confirm(`确定删除用户 ${u.username}？此操作不可撤销。`)) return
                                void mutate(() => api.deleteUser(u.id), `已删除 ${u.username}`)
                              }}
                            >
                              删除
                            </GhostButton>
                          </div>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </section>
    </>
  )
}
