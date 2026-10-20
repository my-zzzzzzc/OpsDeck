export interface Server {
  id: string
  name: string
  hostname: string | null
  ip: string | null
  ssh_port: number
  /** SSH 登录用户名。默认 root;只允许 ubuntu 登录的镜像需改这里。 */
  ssh_user: string
  /** 专用私钥在 OpsDeck 容器内的路径。null 表示用默认密钥。 */
  ssh_key_path: string | null
  os_info: string | null
  cpu_cores: number | null
  mem_total_mb: number | null
  note: string | null
  status: 'online' | 'offline' | 'unknown'
  /** 是否开放 Web 终端。默认关闭,需逐台显式开启。 */
  terminal_enabled: boolean
  last_seen_at: string | null
  created_at: string
  updated_at: string
}

export interface Project {
  id: string
  server_id: string
  name: string
  kind: 'docker-compose' | 'docker' | 'systemd' | 'binary'
  work_dir: string | null
  compose_file: string | null
  ports: Array<{ host?: number; container?: number; proto?: string }> | null
  url: string | null
  restart_cmd: string | null
  upgrade_cmd: string | null
  depends_on: string[] | null
  tags: string[] | null
  note: string | null
  created_at: string
  updated_at: string
}

export interface Overview {
  servers_total: number
  servers_online: number
  servers_offline: number
  projects_total: number
}

export interface Metric {
  id: number
  server_id: string
  captured_at: string
  cpu_percent: number | null
  mem_used_mb: number | null
  mem_total_mb: number | null
  swap_used_mb: number | null
  swap_total_mb: number | null
  disk_used_gb: number | null
  disk_total_gb: number | null
  load_1: number | null
  load_5: number | null
  load_15: number | null
}

export interface Instance {
  id: number
  project_id: string
  name: string
  image: string | null
  state: string | null
  health: string | null
  mem_used_mb: number | null
  mem_limit_mb: number | null
  updated_at: string
}

/**
 * 容器实例(带所属项目与服务器)。
 *
 * 容器看板要跨机器汇总,每个容器必须能说清"属于哪个项目、跑在哪台机器上"。
 * 后端用 join 一次查出来,前端不用再拿 project_id 去翻表。
 */
export interface InstanceDetail extends Instance {
  project_name: string | null
  server_id: string | null
  server_name: string | null
}

export interface EventItem {
  id: number
  server_id: string | null
  project_id: string | null
  level: 'info' | 'warning' | 'critical'
  kind: string
  title: string
  detail: string | null
  acknowledged: boolean
  created_at: string
}

/** 事件类型的中文展示名。 */
export const EVENT_KIND_LABEL: Record<string, string> = {
  offline: '离线',
  exit: '容器退出',
  mem: '内存',
  swap: 'Swap',
  disk: '磁盘',
  cpu: 'CPU',
  deploy: '部署',
}

const BASE = '/api'

const TOKEN_KEY = 'opsdeck_token'

/** 令牌读写。放在 localStorage 便于刷新后保持登录。 */
export const auth = {
  getToken: () => localStorage.getItem(TOKEN_KEY),
  setToken: (t: string) => localStorage.setItem(TOKEN_KEY, t),
  clear: () => localStorage.removeItem(TOKEN_KEY),
}

/** 未登录时通知应用层跳转登录页。 */
let onUnauthorized: (() => void) | null = null
export const setUnauthorizedHandler = (fn: () => void) => {
  onUnauthorized = fn
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const token = auth.getToken()
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (token) headers.Authorization = `Bearer ${token}`

  const resp = await fetch(`${BASE}${path}`, { ...init, headers: { ...headers, ...init?.headers } })

  if (resp.status === 401) {
    // 令牌失效:清掉本地状态并通知上层跳登录
    auth.clear()
    onUnauthorized?.()
    throw new Error('登录已过期,请重新登录')
  }

  if (!resp.ok) {
    const detail = await resp.json().catch(() => ({ detail: resp.statusText }))
    const msg = Array.isArray(detail.detail)
      ? detail.detail.map((d: { msg: string }) => d.msg).join('; ')
      : (detail.detail ?? `请求失败: ${resp.status}`)
    throw new Error(msg)
  }

  if (resp.status === 204) return undefined as T
  return resp.json() as Promise<T>
}

export interface User {
  id: string
  username: string
  email: string | null
  display_name: string | null
  role: 'admin' | 'operator' | 'viewer'
  is_active: boolean
  last_login_at: string | null
  created_at: string
}

export interface AuditLog {
  id: number
  user_id: string | null
  username: string | null
  action: string
  target_type: string | null
  target_id: string | null
  target_name: string | null
  detail: string | null
  ip: string | null
  success: boolean
  created_at: string
}

export interface DifyApp {
  id: string
  name: string
  mode: 'chat' | 'agent' | 'completion' | 'workflow'
  description: string | null
  is_default: boolean
  is_active: boolean
  created_at: string
  /** 服务端返回的掩码 Key,形如 app-abcd****wxyz —— 明文永不下发 */
  api_key_masked?: string
}

export interface ActionCatalogItem {
  key: string
  label: string
  danger: 'none' | 'low' | 'medium' | 'high'
  confirm_required: boolean
  read_only: boolean
  enabled: boolean
  description: string
}

export interface ActionLogItem {
  id: number
  project_id: string | null
  project_name: string | null
  action: string
  command: string | null
  status: 'pending' | 'running' | 'success' | 'failed' | 'rejected'
  output: string | null
  exit_code: number | null
  triggered_by: string
  username: string | null
  created_at: string
  finished_at: string | null
}

export const DANGER_LABEL: Record<string, string> = {
  none: '只读',
  low: '低风险',
  medium: '中风险',
  high: '高风险',
}

export interface TerminalStatus {
  available: boolean
  reason: string | null
  has_password: boolean
}

export interface TerminalSessionItem {
  id: string
  server_id: string | null
  server_name: string | null
  username: string | null
  status: string
  close_reason: string | null
  client_ip: string | null
  recording_path: string | null
  bytes_in: number
  bytes_out: number
  started_at: string
  ended_at: string | null
}

export const api = {
  // 认证
  login: (username: string, password: string) =>
    request<{ access_token: string; user: User }>('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    }),
  me: () => request<User>('/auth/me'),
  myPermissions: () => request<{ role: string; permissions: string[] }>('/auth/permissions'),

  // 用户管理
  users: () => request<User[]>('/users'),
  createUser: (body: Record<string, unknown>) =>
    request<User>('/users', { method: 'POST', body: JSON.stringify(body) }),
  updateUser: (id: string, body: Record<string, unknown>) =>
    request<User>(`/users/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
  deleteUser: (id: string) => request<void>(`/users/${id}`, { method: 'DELETE' }),

  // 审计
  auditLogs: (limit = 100) => request<AuditLog[]>(`/audit-logs?limit=${limit}`),

  // 资产与观测
  overview: () => request<Overview>('/overview'),
  servers: () => request<Server[]>('/servers'),
  /** 用当前已保存的凭据实际连一次目标机。 */
  testServerSsh: (id: string) =>
    request<{ ok: boolean; message: string; stage?: string; docker?: boolean }>(
      `/servers/${id}/ssh-test`,
      { method: 'POST' },
    ),
  updateServer: (id: string, body: Record<string, unknown>) =>
    request<Server>(`/servers/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
  projects: (serverId?: string) =>
    request<Project[]>(`/projects${serverId ? `?server_id=${serverId}` : ''}`),
  latestMetrics: () => request<Metric[]>('/metrics/latest'),
  /**
   * 指标历史。
   *
   * `points` 交给服务端做时间等分降采样 —— 看板上的趋势条只需要几十个点,
   * 24 小时约 2900 条原始样本(约 900KB),降到 24 个桶只有 9KB。
   * 空桶会返回一条各指标为 null 的记录,前端据此画出"没采集到"的缺口。
   */
  metricHistory: (serverId: string, hours = 24, points?: number) =>
    request<Metric[]>(
      `/metrics?server_id=${serverId}&hours=${hours}${points ? `&points=${points}` : ''}`,
    ),
  instances: (serverId?: string) =>
    request<Instance[]>(`/instances${serverId ? `?server_id=${serverId}` : ''}`),
  /** 容器实例,带项目名与服务器名,供跨机器汇总的容器看板使用。 */
  instancesDetail: (serverId?: string) =>
    request<InstanceDetail[]>(`/instances/detail${serverId ? `?server_id=${serverId}` : ''}`),
  events: (limit = 50) => request<EventItem[]>(`/events?limit=${limit}`),
  ackEvent: (id: number) => request<EventItem>(`/events/${id}/ack`, { method: 'POST' }),
  /** 一次性把所有未读事件标记为已处理,返回处理条数。 */
  ackAllEvents: () => request<{ acked: number }>('/events/ack-all', { method: 'POST' }),

  // Dify 应用
  difyApps: () => request<DifyApp[]>('/dify/apps'),
  createDifyApp: (body: Record<string, unknown>) =>
    request<DifyApp>('/dify/apps', { method: 'POST', body: JSON.stringify(body) }),
  updateDifyApp: (id: string, body: Record<string, unknown>) =>
    request<DifyApp>(`/dify/apps/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
  deleteDifyApp: (id: string) => request<void>(`/dify/apps/${id}`, { method: 'DELETE' }),
  pingDifyApp: (id: string) =>
    request<{ ok: boolean; message: string }>(`/dify/apps/${id}/ping`, { method: 'POST' }),

  // 白名单操作
  actionCatalog: () => request<ActionCatalogItem[]>('/actions/catalog'),
  executeAction: (body: { project_id: string; action: string; confirm?: boolean }) =>
    request<ActionLogItem>('/actions/execute', { method: 'POST', body: JSON.stringify(body) }),
  actionLogs: (limit = 50) => request<ActionLogItem[]>(`/actions/logs?limit=${limit}`),

  // Web 终端
  terminalStatus: () => request<TerminalStatus>('/terminal/status'),
  authorizeTerminal: (serverId: string) =>
    request<{ ticket: string; expires_in: number; server_name: string }>(
      `/terminal/authorize?server_id=${serverId}`,
      { method: 'POST' },
    ),
  terminalSessions: () => request<TerminalSessionItem[]>('/terminal/sessions'),
  recordingUrl: (sessionId: string) => `/api/terminal/sessions/${sessionId}/recording`,
}
