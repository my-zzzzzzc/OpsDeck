import { useState } from 'react'

import { api, auth } from './api'

/** 登录页。成功后写入令牌并通知上层切换视图。 */
export function LoginPage({ onSuccess }: { onSuccess: () => void }) {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const result = await api.login(username, password)
      auth.setToken(result.access_token)
      onSuccess()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const inputClass =
    'w-full rounded-lg border border-line bg-secondary px-3 py-2 text-sm text-ink outline-none transition-colors focus:border-accent'

  return (
    <div className="grid min-h-screen place-items-center p-5">
      <form
        onSubmit={submit}
        className="w-full max-w-[360px] rounded-2xl border border-line bg-primary p-8 shadow-sm"
      >
        <h1 className="text-center text-[22px] font-semibold tracking-tight">OpsDeck</h1>
        <p className="mb-6 text-center text-[13px] text-ink-tertiary">服务器与项目管理台</p>

        <label className="mb-3.5 block">
          <span className="mb-1.5 block text-xs text-ink-tertiary">用户名</span>
          <input
            className={inputClass}
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoComplete="username"
            autoFocus
            required
          />
        </label>

        <label className="mb-3.5 block">
          <span className="mb-1.5 block text-xs text-ink-tertiary">密码</span>
          <input
            className={inputClass}
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            required
          />
        </label>

        {error ? (
          <div
            role="alert"
            className="mb-3 rounded-lg bg-tint-danger px-3 py-2 text-[13px] text-ink-danger"
          >
            {error}
          </div>
        ) : null}

        <button
          type="submit"
          disabled={busy}
          className="mt-1 w-full rounded-lg bg-accent py-2.5 text-sm font-medium text-white transition-colors
            hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-60"
        >
          {busy ? '登录中…' : '登录'}
        </button>
      </form>
    </div>
  )
}
