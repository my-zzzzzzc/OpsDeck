import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react'

/*
 * 主题。
 *
 * 之前项目**没有应用内主题开关** —— index.html 里的内联脚本只跟随
 * prefers-color-scheme,用户想手动切深浅色是做不到的。这里补上,
 * 交互照 Beszel 的 mode-toggle.tsx:浅色 → 深色 → 跟随系统 三态轮换。
 *
 * 切主题必须同时改三样东西,少一样都不生效:
 *   1. html[data-theme]  —— index.css 里 color-scheme 与 --chart-* 的选择器
 *   2. .light / .dark 类 —— **Twenty 令牌是按类作用域的**,
 *      只改属性不改类,页面颜色纹丝不动(这个坑很隐蔽,表现为"点了没反应")
 *   3. color-scheme      —— 让滚动条、原生下拉这些浏览器控件跟着走
 */

export type Theme = 'light' | 'dark' | 'system'

const STORAGE_KEY = 'opsdeck_theme'

/** 把主题落到 DOM 上。system 走系统偏好。 */
function apply(theme: Theme) {
  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches
  const dark = theme === 'dark' || (theme === 'system' && prefersDark)
  const root = document.documentElement
  root.setAttribute('data-theme', dark ? 'dark' : 'light')
  root.classList.toggle('dark', dark)
  root.classList.toggle('light', !dark)
}

function readStored(): Theme {
  const v = localStorage.getItem(STORAGE_KEY)
  return v === 'light' || v === 'dark' || v === 'system' ? v : 'system'
}

const ThemeContext = createContext<{ theme: Theme; setTheme: (t: Theme) => void }>({
  theme: 'system',
  setTheme: () => {},
})

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<Theme>(readStored)

  const setTheme = useCallback((t: Theme) => {
    setThemeState(t)
    localStorage.setItem(STORAGE_KEY, t)
    apply(t)
  }, [])

  useEffect(() => {
    apply(theme)
    // 只有跟随系统时才需要监听系统偏好变化
    if (theme !== 'system') return
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const onChange = () => apply('system')
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [theme])

  return <ThemeContext.Provider value={{ theme, setTheme }}>{children}</ThemeContext.Provider>
}

export const useTheme = () => useContext(ThemeContext)

/** 三态轮换顺序。与 Beszel 的 themes 数组一致。 */
export const THEME_ORDER: Theme[] = ['light', 'dark', 'system']
