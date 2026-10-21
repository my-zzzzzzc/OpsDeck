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
  server_name: string | null
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
  last_deploy_at: string | null
  last_deploy_status: 'running' | 'success' | 'failed' | 'rejected' | null
  last_deploy_username: string | null
  update_source: 'git' | 'release' | 'registry' | 'manual' | null
  update_status: 'unknown' | 'up_to_date' | 'update_available' | 'check_failed' | 'manual' | null
  update_branch: string | null
  /** 托管状态。discovered/ignored 是只读资产，不参与部署、更新、操作与告警。 */
  lifecycle: ProjectLifecycle
  /** Compose 项目标签，稳定的自动发现匹配键。 */
  compose_project: string | null
  last_seen_at: string | null
  container_count: number | null
  created_at: string
  updated_at: string
}

export type ProjectLifecycle = 'managed' | 'discovered' | 'ignored'

/** 接管请求。只登记，不执行任何远端命令。 */
export interface AdoptProjectPayload {
  name?: string
  work_dir: string
  compose_file: string
  url?: string | null
  note?: string | null
}

export interface ProjectConfig {
  kind: Project['kind']
  compose_file: string | null
  compose_content: string | null
  env_content: string | null
  editable: boolean
  message: string | null
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

/** 容器指标快照。速率单位为字节/秒，CPU 为整机占比。 */
export interface ContainerMetricPoint {
  id: number
  instance_id: number
  captured_at: string
  cpu_percent: number | null
  mem_used_mb: number | null
  net_rx_bps: number | null
  net_tx_bps: number | null
  block_read_bps: number | null
  block_write_bps: number | null
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
  /** 镜像 registry digest；本地构建的镜像没有该值。 */
  image_digest: string | null
  /** 最近一次健康检查输出，仅不健康时展示。 */
  health_detail: string | null
  /** Docker Compose 一次性任务标签（docker compose run）。 */
  one_off: boolean
  /** 当前采集器可能尚未上报，缺失时前端展示为「—」。 */
  started_at: string | null
  exit_code: number | null
  /** 崩溃排障：重启次数、OOM 终止标记、最近一次退出时间。 */
  restart_count: number | null
  oom_killed: boolean | null
  finished_at: string | null
  ports: Array<{ host?: number; container?: number; proto?: string }> | null
  mounts: Array<{
    type: string
    name?: string
    source: string
    destination: string
    readonly: boolean
  }> | null
  env_keys: string[] | null
  restart_policy: string | null
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

  let resp: Response
  try {
    resp = await fetch(`${BASE}${path}`, { ...init, headers: { ...headers, ...init?.headers } })
  } catch {
    // fetch 只在网络层失败时抛异常;浏览器原文是 "Failed to fetch",不该直接给用户看
    throw new Error('无法连接服务器,请检查后端服务与数据库连接')
  }

  if (resp.status === 401) {
    // 令牌失效:清掉本地状态并通知上层跳登录
    auth.clear()
    onUnauthorized?.()
    throw new Error('登录已过期,请重新登录')
  }

  if (!resp.ok) {
    const body = await resp.json().catch(() => null)
    const detail = body?.detail
    const msg = Array.isArray(detail)
      ? detail.map((d: { msg: string }) => d.msg).join('; ')
      : typeof detail === 'string' && detail
        ? detail
        : `请求失败(${resp.status})`
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

export type UpdateSource = 'git' | 'registry' | 'release' | 'manual'
export type UpdateStatus = 'unknown' | 'up_to_date' | 'update_available' | 'check_failed' | 'manual'

export interface UpdateConfig {
  id: string
  project_id: string
  source_type: UpdateSource
  confirmed: boolean
  auto_detected: boolean
  repo_url: string | null
  branch: string | null
  image_ref: string | null
  upstream_repo: string | null
  current_version: string | null
  latest_version: string | null
  status: UpdateStatus
  detail: string | null
  release_url: string | null
  extra: Record<string, unknown> | null
  last_checked_at: string | null
  last_success_at: string | null
}

/** 更新页的一行:项目 + 所属服务器 + 已采集镜像 + 更新配置。 */
export interface UpdateProject {
  project_id: string
  project_name: string
  server_id: string
  server_name: string | null
  kind: string
  work_dir: string | null
  images: string[]
  config: UpdateConfig | null
}

/** 自动识别结果。只是建议,必须由人确认后才保存。 */
export interface UpdateSuggestion {
  source_type: UpdateSource
  repo_url: string | null
  branch: string | null
  image_ref: string | null
  upstream_repo: string | null
  current_version: string | null
  reason: string
  images: string[]
}

export interface UpdateApplyResult {
  ok: boolean
  message: string
  output: string | null
  command: string | null
  config: UpdateConfig | null
}

/* ---------------------------------------------------------------- 部署 */

export type DeploySource = 'existing' | 'git'

export interface DeployPreflightPayload {
  server_id: string
  name: string
  source: DeploySource
  work_dir: string
  compose_file?: string | null
  repo_url?: string | null
  branch?: string | null
}

export interface DeployPayload extends DeployPreflightPayload {
  url?: string | null
  note?: string | null
}

export interface DeployCheck {
  key: string
  label: string
  ok: boolean
  detail: string
}

export interface DeployPreflight {
  ok: boolean
  checks: DeployCheck[]
  command: string
  work_dir: string
}

export interface DeployResult {
  ok: boolean
  message: string
  command: string
  output: string | null
  /** 命令成功但登记失败时为 null。 */
  project: Project | null
  /** Git 来源部署成功后自动创建的更新配置。 */
  config: UpdateConfig | null
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
  projects: (serverId?: string, lifecycle: ProjectLifecycle = 'managed') => {
    const params = new URLSearchParams({ lifecycle })
    if (serverId) params.set('server_id', serverId)
    return request<Project[]>(`/projects?${params.toString()}`)
  },
  /** 接管未托管项目：只登记资产，不执行任何远端命令。 */
  adoptProject: (id: string, body: AdoptProjectPayload) =>
    request<Project>(`/projects/${id}/adopt`, { method: 'POST', body: JSON.stringify(body) }),
  ignoreProject: (id: string) =>
    request<Project>(`/projects/${id}/ignore`, { method: 'POST' }),
  restoreProject: (id: string) =>
    request<Project>(`/projects/${id}/restore`, { method: 'POST' }),

  // 部署
  deployPreflight: (body: DeployPreflightPayload) =>
    request<DeployPreflight>('/deployments/preflight', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  deployProject: (body: DeployPayload) =>
    request<DeployResult>('/deployments', {
      method: 'POST',
      body: JSON.stringify({ ...body, confirm: true }),
    }),

  // 项目工作区配置
  projectConfig: (id: string) => request<ProjectConfig>(`/projects/${id}/config`),
  updateProjectConfig: (id: string, body: { compose_content?: string; env_content?: string }) =>
    request<ProjectConfig>(`/projects/${id}/config`, { method: 'PUT', body: JSON.stringify(body) }),

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
  /** 单个容器的资源趋势;空桶由后端返回 null,前端画成缺口。 */
  containerMetrics: (instanceId: number, hours = 1, points = 60) =>
    request<ContainerMetricPoint[]>(`/instances/${instanceId}/metrics?hours=${hours}&points=${points}`),
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
  actionLogs: (limit = 50, projectId?: string) => request<ActionLogItem[]>(`/actions/logs?limit=${limit}${projectId ? `&project_id=${projectId}` : ''}`),
  // 单容器操作：只影响这一个容器
  containerAction: (instanceId: number, action: string, confirm = false) =>
    request<ActionLogItem>(`/containers/${instanceId}/actions`, {
      method: 'POST',
      body: JSON.stringify({ action, confirm }),
    }),

  // 更新
  updates: () => request<UpdateProject[]>('/updates'),
  updateHistory: (limit = 30) => request<ActionLogItem[]>(`/updates/history?limit=${limit}`),
  detectUpdate: (projectId: string) =>
    request<UpdateSuggestion>(`/updates/${projectId}/detect`, { method: 'POST' }),
  saveUpdateConfig: (projectId: string, body: Record<string, unknown>) =>
    request<UpdateConfig>(`/updates/${projectId}`, { method: 'PUT', body: JSON.stringify(body) }),
  checkUpdate: (projectId: string) =>
    request<UpdateConfig>(`/updates/${projectId}/check`, { method: 'POST' }),
  applyUpdate: (projectId: string) =>
    request<UpdateApplyResult>(`/updates/${projectId}/apply`, {
      method: 'POST',
      body: JSON.stringify({ confirm: true }),
    }),

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
