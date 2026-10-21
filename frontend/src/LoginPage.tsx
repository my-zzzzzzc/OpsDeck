import { useState } from 'react'

import { api, auth } from './api'
import { IconGauge } from './icons'

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
    'w-full rounded-md border border-line bg-background px-3 py-2 text-[13px] text-ink outline-none transition-colors placeholder:text-ink-tertiary focus:border-line-strong'

  return (
    <div className="grid min-h-screen place-items-center p-5">
      <form
        onSubmit={submit}
        className="w-full max-w-[380px] rounded-lg border border-line bg-primary p-8 shadow-xs"
      >
        <div className="mb-7 flex flex-col items-center text-center">
          <span className="mb-3 flex size-10 items-center justify-center rounded-md bg-accent text-on-accent">
            <IconGauge size={20} />
          </span>
          <h1 className="text-[24px] font-semibold tracking-[-0.03em]">OpsDeck</h1>
          <p className="mt-1 text-[13px] text-ink-tertiary">服务器与项目管理台</p>
        </div>

        <label className="mb-3.5 block">
          <span className="mb-1.5 block text-[11.5px] font-medium text-ink-secondary">用户名</span>
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
          <span className="mb-1.5 block text-[11.5px] font-medium text-ink-secondary">密码</span>
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
            className="mb-3 rounded-md bg-tint-danger px-3 py-2 text-[12px] text-ink-danger"
          >
            {error}
          </div>
        ) : null}

        <button
          type="submit"
          disabled={busy}
          className="mt-1 w-full rounded-md bg-accent py-2.5 text-[13px] font-medium text-on-accent transition-colors
            hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-60"
        >
          {busy ? '登录中…' : '登录'}
        </button>
      </form>
    </div>
  )
}
