import { useCallback, useEffect, useState } from 'react'

import { api, auth, setUnauthorizedHandler, type User } from './api'
import { App } from './App'
import { LoginPage } from './LoginPage'

/** 应用根组件:负责登录态判定与切换。 */
export function Root() {
  const [user, setUser] = useState<User | null>(null)
  const [checking, setChecking] = useState(true)

  const loadMe = useCallback(async () => {
    if (!auth.getToken()) {
      setUser(null)
      setChecking(false)
      return
    }
    try {
      setUser(await api.me())
    } catch {
      setUser(null)
    } finally {
      setChecking(false)
    }
  }, [])

  useEffect(() => {
    // 令牌过期时由 api 层回调,直接登出
    setUnauthorizedHandler(() => setUser(null))
    void loadMe()
  }, [loadMe])

  if (checking) return <div className="center">加载中…</div>
  if (!user) return <LoginPage onSuccess={() => void loadMe()} />

  return (
    <App
      user={user}
      onLogout={() => {
        auth.clear()
        setUser(null)
      }}
    />
  )
}
