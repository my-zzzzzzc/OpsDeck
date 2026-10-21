/** 容器运行配置的只读展示。采集器只上报键名、挂载路径与重启策略。 */

export interface RuntimePort {
  host?: number
  container?: number
  proto?: string
}

/** 宿主端口省略时只显示容器端口,不写「? → 80」。 */
export function portLabel(port: RuntimePort): string {
  const proto = port.proto ? `/${port.proto}` : ''
  const container = port.container ?? '?'
  return port.host != null ? `${port.host} → ${container}${proto}` : `${container}${proto}`
}

export function restartPolicyLabel(policy: string): string {
  if (policy === 'no') return '不重启'
  if (policy === 'always') return '总是重启'
  if (policy === 'unless-stopped') return '非手动停止时重启'
  if (policy === 'on-failure') return '失败时重启'
  if (policy.startsWith('on-failure:')) {
    return `失败时重启 ${policy.slice('on-failure:'.length)} 次`
  }
  return policy
}
