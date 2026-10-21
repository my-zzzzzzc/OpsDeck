import {
  Activity,
  AlertTriangle,
  Boxes,
  ChevronRight,
  ExternalLink,
  FolderOpen,
  Loader2,
  Lock,
  Play,
  RefreshCw,
  Rocket,
  RotateCcw,
  ScrollText,
  Server as ServerIcon,
  Square,
  SquareTerminal,
  X,
  type LucideIcon,
} from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'

import {
  api,
  DANGER_LABEL,
  type ActionCatalogItem,
  type ActionLogItem,
  type Project,
  type User,
} from '../api'
import { cn } from '../cn'
import { useHeaderMeta } from '../header-meta'
import { Badge, Card, Empty, GhostButton, PrimaryButton, Skeleton } from '../ui'
import { AdoptProjectDialog } from './AdoptProjectDialog'
import { DeployDialog } from './DeployDialog'
import { ProjectWorkspaceDialog } from './ProjectWorkspaceDialog'

/*
 * 「项目」页。
 *
 * 一行一个项目的长表格在窄屏只能挤出「项目 + 操作」两列,
 * 中间大片留白,信息全堆在左侧。改成自适应卡片网格:
 * 每张卡是一个项目,卡片内按「身份 → 服务器/目录 → 状态 → 操作」分层,
 * 宽度够时自动铺成两到三列,既不拉通整行,也能横向比较状态。
 *
 * 颜色只用来强调需要处理的状态(失败、可更新),其余保持中性 ——
 * 满屏彩点等于没有重点。
 */

const DEPLOY_STATUS: Record<string, { label: string; dot: string; text: string }> = {
  success: { label: '成功', dot: 'bg-ink-success', text: 'text-ink-secondary' },
  failed: { label: '失败', dot: 'bg-ink-danger', text: 'text-ink-danger' },
  running: { label: '进行中', dot: 'bg-ink-warning', text: 'text-ink-warning' },
  rejected: { label: '已拒绝', dot: 'bg-ink-tertiary', text: 'text-ink-tertiary' },
}

const UPDATE_STATUS: Record<string, { label: string; dot: string; text: string }> = {
  update_available: { label: '可更新', dot: 'bg-ink-warning', text: 'text-ink-warning' },
  up_to_date: { label: '已是最新', dot: 'bg-ink-success', text: 'text-ink-secondary' },
  check_failed: { label: '检查失败', dot: 'bg-ink-danger', text: 'text-ink-danger' },
  unknown: { label: '待检查', dot: 'bg-ink-tertiary', text: 'text-ink-tertiary' },
  manual: { label: '不检测', dot: 'bg-ink-tertiary', text: 'text-ink-tertiary' },
}

const UPDATE_SOURCE: Record<string, string> = {
  git: 'Git',
  release: 'Release',
  registry: '镜像',
  manual: '手动',
}

const ACTION_ICON: Record<string, LucideIcon> = {
  status: SquareTerminal,
  logs: ScrollText,
  restart: RotateCcw,
  stop: Square,
  start: Play,
  deploy: Rocket,
  update: RefreshCw,
}

/** 项目网格的列宽规则。加载骨架与真实卡片共用,避免切换时跳版。 */
const PROJECT_GRID =
  'grid grid-cols-[repeat(auto-fill,minmax(min(100%,300px),1fr))] gap-3'

const UNMANAGED_TABS = [
  { key: 'discovered', label: '待接管' },
  { key: 'ignored', label: '已忽略' },
] as const

type UnmanagedTab = (typeof UNMANAGED_TABS)[number]['key']

/** 操作历史一次只取最近这些条,按钮计数超过它时显示「N+」。 */
const HISTORY_LIMIT = 20

/** 项目卡骨架:尺寸贴近真实卡片,数据到达后不会整页跳动。 */
function ProjectCardSkeleton() {
  return (
    <Card padded={false} className="flex flex-col overflow-hidden">
      <div className="p-3">
        <Skeleton className="h-4 w-24" />
        <Skeleton className="mt-2 h-3 w-32" />
        <Skeleton className="mt-2.5 h-3 w-44" />
        <div className="mt-3 grid grid-cols-2 gap-3 border-t border-line pt-2.5">
          <div className="space-y-1.5">
            <Skeleton className="h-2.5 w-14" />
            <Skeleton className="h-2.5 w-20" />
          </div>
          <div className="space-y-1.5">
            <Skeleton className="h-2.5 w-14" />
            <Skeleton className="h-2.5 w-16" />
          </div>
        </div>
      </div>
      <div className="mt-auto flex items-center justify-between border-t border-line bg-secondary/40 px-2 py-2">
        <Skeleton className="h-5 w-16" />
        <Skeleton className="h-5 w-24" />
      </div>
    </Card>
  )
}

/** 未托管列表的骨架:与紧凑行同高,压住加载时的空白。 */
function UnmanagedSkeleton() {
  return (
    <div aria-busy="true" aria-label="正在加载未托管项目">
      {[0, 1, 2].map((index) => (
        <div key={index} className="border-b border-line px-3 py-2.5 last:border-0">
          <Skeleton className="h-3 w-28" />
          <Skeleton className="mt-2 h-2.5 w-64 max-w-full" />
        </div>
      ))}
    </div>
  )
}

function UnmanagedRow({
  project,
  serverName,
  busy,
  isAdmin,
  onAdopt,
  onIgnore,
  onRestore,
}: {
  project: Project
  serverName: string | null
  busy: boolean
  isAdmin: boolean
  onAdopt: () => void
  onIgnore: () => void
  onRestore: () => void
}) {
  const location = project.work_dir
    ? `${project.work_dir}${project.compose_file ? ` / ${project.compose_file}` : ''}`
    : null
  const composeName =
    project.compose_project && project.compose_project !== project.name ? project.compose_project : null

  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-line px-3 py-2.5 last:border-0">
      <div className="min-w-0 flex-1 basis-64">
        <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <span className="truncate text-[12.5px] font-medium text-ink" title={project.name}>
            {project.name}
          </span>
          {composeName ? (
            <span className="min-w-0 truncate text-[10px] text-ink-tertiary" title={`Compose 项目:${composeName}`}>
              Compose · {composeName}
            </span>
          ) : null}
        </div>
        <div className="mt-1 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-[10.5px] text-ink-tertiary">
          <span className="flex min-w-0 items-center gap-1">
            <ServerIcon className="size-3 shrink-0" />
            <span className="truncate" title={serverName ?? undefined}>
              {serverName ?? '—'}
            </span>
          </span>
          {location ? (
            <span className="mono min-w-0 max-w-full truncate" title={location}>
              {location}
            </span>
          ) : null}
          {project.container_count != null ? (
            <span className="tnum">{project.container_count} 个容器</span>
          ) : null}
          {project.last_seen_at ? <span>最近采集 {formatWhen(project.last_seen_at)}</span> : null}
        </div>
      </div>

      {isAdmin ? (
        <div className="flex shrink-0 items-center gap-1.5">
          {project.lifecycle === 'discovered' ? (
            <>
              <GhostButton onClick={onAdopt} disabled={busy} title="接管后纳入管理与更新">
                接管
              </GhostButton>
              <GhostButton onClick={onIgnore} disabled={busy} title="停止采集并移出待接管列表">
                {busy ? <Loader2 className="size-3 animate-spin" /> : null}
                忽略
              </GhostButton>
            </>
          ) : (
            <GhostButton onClick={onRestore} disabled={busy} title="恢复到待接管列表">
              {busy ? (
                <Loader2 className="size-3 animate-spin" />
              ) : (
                <RotateCcw className="size-3" />
              )}
              恢复
            </GhostButton>
          )}
        </div>
      ) : (
        <span className="flex shrink-0 items-center gap-1 text-[10.5px] text-ink-tertiary">
          <Lock className="size-3" />
          只读
        </span>
      )}
    </li>
  )
}

/** 历史里不只有白名单操作,部署与更新也写同一张表。 */
const LOG_ACTION_LABEL: Record<string, string> = {
  deploy: '部署',
  update: '更新',
}

const LOG_STATUS: Record<string, { label: string; dot: string; text: string }> = {
  success: { label: '成功', dot: 'bg-ink-success', text: 'text-ink-success' },
  failed: { label: '失败', dot: 'bg-ink-danger', text: 'text-ink-danger' },
  rejected: { label: '已拒绝', dot: 'bg-ink-warning', text: 'text-ink-warning' },
  running: { label: '执行中', dot: 'bg-accent', text: 'text-ink-secondary' },
  pending: { label: '等待中', dot: 'bg-ink-tertiary', text: 'text-ink-tertiary' },
}

function formatWhen(iso: string) {
  const date = new Date(iso)
  if (date.toDateString() === new Date().toDateString()) {
    return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
  }
  return date.toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function formatClock(iso: string) {
  return new Date(iso).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
}

/** 历史按本地日期分组,时间列只留 HH:mm,避免每行重复日期。 */
function dayLabel(iso: string) {
  const date = new Date(iso)
  const now = new Date()
  const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
  const days = Math.round((startOfDay(now) - startOfDay(date)) / 86_400_000)
  if (days === 0) return '今天'
  if (days === 1) return '昨天'
  return date.getFullYear() === now.getFullYear()
    ? date.toLocaleDateString('zh-CN', { month: 'long', day: 'numeric' })
    : date.toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric' })
}

function groupLogsByDay(logs: ActionLogItem[]) {
  const groups = new Map<string, ActionLogItem[]>()
  for (const log of logs) {
    const label = dayLabel(log.created_at)
    const bucket = groups.get(label)
    if (bucket) bucket.push(log)
    else groups.set(label, [log])
  }
  return [...groups.entries()].map(([label, items]) => ({ label, items }))
}

/** 站点链接只显示 host + path,完整地址留在 title 里。 */
function shortUrl(url: string) {
  try {
    const parsed = new URL(url)
    return `${parsed.host}${parsed.pathname === '/' ? '' : parsed.pathname}`
  } catch {
    return url
  }
}

/** 操作历史弹窗:把原来常驻页尾的列表收进来,项目网格保持首屏主体。 */
function HistoryDialog({
  logs,
  actionLabels,
  loaded,
  loading,
  error,
  onClose,
  onRetry,
}: {
  logs: ActionLogItem[]
  actionLabels: Record<string, string>
  loaded: boolean
  loading: boolean
  error: string | null
  onClose: () => void
  onRetry: () => void
}) {
  const groups = groupLogsByDay(logs)
  const pending = !loaded || (loading && logs.length === 0)

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="操作历史"
        className="flex max-h-[90vh] w-full max-w-[780px] flex-col overflow-hidden rounded-lg border border-line bg-primary shadow-xl"
      >
        <div className="flex items-center gap-2 border-b border-line px-4 py-3">
          <ScrollText className="size-4 text-accent" />
          <h2 className="text-[14px] font-semibold text-ink">操作历史</h2>
          <span className="tnum text-[11.5px] text-ink-tertiary">
            {pending
              ? '加载中'
              : error
                ? '加载失败'
                : `${logs.length}${logs.length >= HISTORY_LIMIT ? '+' : ''} 条`}
          </span>
          <button
            type="button"
            onClick={onClose}
            aria-label="关闭"
            className="ms-auto cursor-pointer rounded-sm p-1 text-ink-tertiary transition-colors hover:bg-overlay-light hover:text-ink"
          >
            <X className="size-4" />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {pending ? (
            <div aria-busy="true" aria-label="正在加载操作历史">
              <div className="flex items-center gap-2 border-b border-line bg-secondary/40 px-4 py-2">
                <Skeleton className="h-2.5 w-12" />
              </div>
              {[0, 1, 2].map((i) => (
                <div
                  key={i}
                  className="flex items-center gap-3 border-b border-line px-4 py-2.5 last:border-0"
                >
                  <Skeleton className="h-2.5 w-8" />
                  <Skeleton className="h-2.5 w-10" />
                  <Skeleton className="h-2.5 flex-1" />
                  <Skeleton className="h-2.5 w-14" />
                </div>
              ))}
            </div>
          ) : error ? (
            <div className="p-6 text-center">
              <p className="text-[12px] text-ink-danger">操作历史加载失败</p>
              <p className="mt-1 break-words text-[11.5px] text-ink-tertiary">{error}</p>
              <div className="mt-3 flex justify-center">
                <GhostButton onClick={onRetry}>重试</GhostButton>
              </div>
            </div>
          ) : logs.length === 0 ? (
            <div className="p-6 text-center">
              <Empty>还没有执行过操作。</Empty>
            </div>
          ) : (
            <div>
              {groups.map((group) => (
                <div key={group.label}>
                  <div className="sticky top-0 z-10 flex items-center gap-2 border-b border-line bg-secondary px-4 py-1.5">
                    <span className="text-[10.5px] font-medium tracking-wide text-ink-tertiary">
                      {group.label}
                    </span>
                    <span className="h-px flex-1 bg-line" aria-hidden="true" />
                    <span className="tnum text-[10px] text-ink-tertiary">
                      {group.items.length} 条
                    </span>
                  </div>
                  <ul>
                    {group.items.map((log) => {
                      const status = LOG_STATUS[log.status] ?? {
                        label: log.status,
                        dot: 'bg-ink-tertiary',
                        text: 'text-ink-tertiary',
                      }
                      const Icon = ACTION_ICON[log.action] ?? Activity
                      const hasDetail = Boolean(log.command || log.output)

                      return (
                        <li key={log.id} className="border-b border-line last:border-0">
                          <details className="group">
                            <summary
                              className={cn(
                                'flex list-none flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5 [&::-webkit-details-marker]:hidden',
                                hasDetail
                                  ? 'cursor-pointer hover:bg-overlay-lighter'
                                  : 'cursor-default',
                              )}
                            >
                              <span
                                className="tnum w-9 shrink-0 text-[11px] text-ink-tertiary"
                                title={new Date(log.created_at).toLocaleString('zh-CN')}
                              >
                                {formatClock(log.created_at)}
                              </span>
                              <span
                                className={cn(
                                  'flex w-[52px] shrink-0 items-center gap-1.5 text-[11px]',
                                  status.text,
                                )}
                              >
                                <span className={cn('size-1.5 shrink-0 rounded-full', status.dot)} />
                                {status.label}
                              </span>
                              <div className="flex min-w-0 flex-1 items-center gap-2.5">
                                <span className="truncate text-[12.5px] font-medium text-ink">
                                  {log.project_name ?? '—'}
                                </span>
                                <span className="flex shrink-0 items-center gap-1 text-[11px] text-ink-tertiary">
                                  <Icon className="size-3" />
                                  {actionLabels[log.action] ??
                                    LOG_ACTION_LABEL[log.action] ??
                                    log.action}
                                </span>
                              </div>
                              <span className="ms-auto flex shrink-0 items-center gap-2 text-[11px] text-ink-tertiary">
                                <span className="max-w-24 truncate" title={log.username ?? undefined}>
                                  {log.username ?? '—'}
                                </span>
                                {hasDetail ? (
                                  <ChevronRight className="size-3.5 transition-transform group-open:rotate-90" />
                                ) : null}
                              </span>
                            </summary>
                            {hasDetail ? (
                              <div className="mx-4 mb-3 overflow-hidden rounded-md border border-line bg-secondary/40">
                                {log.command ? (
                                  <div
                                    className={cn('px-3 py-2', log.output && 'border-b border-line')}
                                  >
                                    <div className="text-[10px] font-medium tracking-wider text-ink-tertiary">
                                      命令
                                    </div>
                                    <div className="mono mt-0.5 text-[11px] break-all text-ink-secondary">
                                      {log.command}
                                    </div>
                                  </div>
                                ) : null}
                                {log.output ? (
                                  <div className="px-3 py-2">
                                    <div className="text-[10px] font-medium tracking-wider text-ink-tertiary">
                                      输出
                                    </div>
                                    <pre className="mono mt-1 max-h-48 overflow-auto text-[11px] leading-relaxed whitespace-pre-wrap text-ink-secondary">
                                      {log.output}
                                    </pre>
                                  </div>
                                ) : null}
                              </div>
                            ) : null}
                          </details>
                        </li>
                      )
                    })}
                  </ul>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

/**
 * 项目管理面板:展示项目资产,并对每个项目执行白名单操作。
 *
 * 安全边界由后端 `/actions/catalog` 定义 —— 本组件只渲染 enabled 的操作,
 * 但真正的拦截在后端,前端禁用仅是体验优化。
 */
export function ProjectsPanel({
  user,
  catalog,
}: {
  user: User
  catalog: ActionCatalogItem[]
}) {
  const [projects, setProjects] = useState<Project[]>([])
  const [logs, setLogs] = useState<ActionLogItem[]>([])
  const [serverNames, setServerNames] = useState<Record<string, string>>({})
  const [running, setRunning] = useState<string | null>(null)
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null)
  const [deployOpen, setDeployOpen] = useState(false)
  const [workspace, setWorkspace] = useState<Project | null>(null)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [loading, setLoading] = useState(true)
  const [loaded, setLoaded] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [logsError, setLogsError] = useState<string | null>(null)

  // 未托管项目独立加载:它失败不该把已接管项目网格一起打成空态。
  const [unmanaged, setUnmanaged] = useState<Record<UnmanagedTab, Project[]>>({
    discovered: [],
    ignored: [],
  })
  const [unmanagedTab, setUnmanagedTab] = useState<UnmanagedTab>('discovered')
  const [unmanagedLoading, setUnmanagedLoading] = useState(true)
  const [unmanagedLoaded, setUnmanagedLoaded] = useState(false)
  const [unmanagedError, setUnmanagedError] = useState<string | null>(null)
  const [unmanagedBusy, setUnmanagedBusy] = useState<string | null>(null)
  const [unmanagedMsg, setUnmanagedMsg] = useState<{ text: string; ok: boolean } | null>(null)
  const [adopting, setAdopting] = useState<Project | null>(null)

  // 部署需要 manage 权限,仅管理员可见;viewer / operator 仍可执行白名单操作
  const isAdmin = user.role === 'admin'
  const canOperate = isAdmin || user.role === 'operator'

  const reload = useCallback(async () => {
    setLoading(true)
    setLoadError(null)
    setLogsError(null)
    try {
      // 三条请求各自降级:历史拉不到不该把项目列表一起打成空态,
      // 反过来说,项目列表失败也不能伪装成「还没有登记项目」。
      const [projectsResult, logsResult, serversResult] = await Promise.allSettled([
        api.projects(),
        api.actionLogs(HISTORY_LIMIT),
        api.servers(),
      ])

      if (projectsResult.status === 'fulfilled') setProjects(projectsResult.value)
      else setLoadError((projectsResult.reason as Error).message)

      if (logsResult.status === 'fulfilled') setLogs(logsResult.value)
      else setLogsError((logsResult.reason as Error).message)

      if (serversResult.status === 'fulfilled') {
        setServerNames(
          Object.fromEntries(serversResult.value.map((server) => [server.id, server.name])),
        )
      }
    } finally {
      setLoading(false)
      setLoaded(true)
    }
  }, [])

  const reloadUnmanaged = useCallback(async () => {
    setUnmanagedLoading(true)
    setUnmanagedError(null)
    try {
      const [discovered, ignored] = await Promise.allSettled([
        api.projects(undefined, 'discovered'),
        api.projects(undefined, 'ignored'),
      ])
      if (discovered.status === 'fulfilled') {
        setUnmanaged((previous) => ({ ...previous, discovered: discovered.value }))
      }
      if (ignored.status === 'fulfilled') {
        setUnmanaged((previous) => ({ ...previous, ignored: ignored.value }))
      }
      const problems = [discovered, ignored].flatMap((result) =>
        result.status === 'rejected' ? [(result.reason as Error).message] : [],
      )
      if (problems.length > 0) setUnmanagedError(problems.join(';'))
    } finally {
      setUnmanagedLoading(false)
      setUnmanagedLoaded(true)
    }
  }, [])

  const refreshAll = useCallback(async () => {
    await Promise.all([reload(), reloadUnmanaged()])
  }, [reload, reloadUnmanaged])

  useEffect(() => {
    void reload()
    void reloadUnmanaged()
  }, [reload, reloadUnmanaged])

  const ignoreProject = async (project: Project) => {
    const ok = confirm(
      `忽略「${project.name}」？\n\n忽略后不会自动重新出现,恢复前不再采集它的容器;已有的容器快照会被删除。`,
    )
    if (!ok) return

    setUnmanagedBusy(project.id)
    setUnmanagedMsg(null)
    try {
      await api.ignoreProject(project.id)
      setUnmanagedMsg({ text: `已忽略「${project.name}」,可在「已忽略」中恢复。`, ok: true })
      await refreshAll()
    } catch (err) {
      setUnmanagedMsg({ text: `忽略失败：${(err as Error).message}`, ok: false })
    } finally {
      setUnmanagedBusy(null)
    }
  }

  const restoreProject = async (project: Project) => {
    setUnmanagedBusy(project.id)
    setUnmanagedMsg(null)
    try {
      await api.restoreProject(project.id)
      setUnmanagedTab('discovered')
      setUnmanagedMsg({ text: `已恢复「${project.name}」,下一轮采集会重新读取容器。`, ok: true })
      await refreshAll()
    } catch (err) {
      setUnmanagedMsg({ text: `恢复失败：${(err as Error).message}`, ok: false })
    } finally {
      setUnmanagedBusy(null)
    }
  }

  const run = async (project: Project, action: ActionCatalogItem) => {
    if (action.confirm_required) {
      const ok = confirm(
        `确认执行「${action.label}」？\n\n项目：${project.name}\n风险：${DANGER_LABEL[action.danger]}\n\n${action.description}`,
      )
      if (!ok) return
    }

    setRunning(`${project.id}:${action.key}`)
    setMsg(null)
    try {
      const log = await api.executeAction({
        project_id: project.id,
        action: action.key,
        confirm: action.confirm_required,
      })
      const status = LOG_STATUS[log.status]?.label ?? log.status
      setMsg({ text: `${action.label}执行完成（${status}）`, ok: log.status === 'success' })
      await reload()
    } catch (err) {
      setMsg({ text: `执行失败：${(err as Error).message}`, ok: false })
    } finally {
      setRunning(null)
    }
  }

  // 日志收进项目工作区,不再占用卡片底栏的操作位
  const actions = catalog.filter((action) => action.enabled && action.key !== 'logs')
  const readActions = actions.filter((action) => action.read_only)
  const writeActions = actions.filter((action) => !action.read_only)
  const actionLabels = Object.fromEntries(catalog.map((action) => [action.key, action.label]))
  // 最近 20 条之外的历史只能进详情看,计数到此为止,显示成 20+
  const historyCount =
    loaded && !logsError && logs.length > 0
      ? `${logs.length}${logs.length >= HISTORY_LIMIT ? '+' : ''}`
      : null
  const closeHistory = useCallback(() => setHistoryOpen(false), [])

  const renderAction = (project: Project, action: ActionCatalogItem) => {
    const busy = running === `${project.id}:${action.key}`
    const Icon = ACTION_ICON[action.key] ?? Activity
    const dangerous =
      !action.read_only && (action.danger === 'medium' || action.danger === 'high')

    return (
      <button
        key={action.key}
        type="button"
        disabled={busy}
        onClick={() => void run(project, action)}
        title={`${action.label}：${action.description}`}
        aria-label={`${project.name} ${action.label}`}
        className={cn(
          'flex size-7 cursor-pointer items-center justify-center rounded-md transition-colors disabled:cursor-wait disabled:opacity-40',
          dangerous
            ? 'text-ink-secondary hover:bg-tint-danger hover:text-ink-danger'
            : 'text-ink-secondary hover:bg-overlay-light hover:text-ink',
        )}
      >
        {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Icon className="size-3.5" />}
      </button>
    )
  }

  // 数量交给页头,内容区不再重复「项目」这个页面名
  useHeaderMeta(projects.length > 0 ? `${projects.length} 个` : null)

  const unmanagedRows = unmanaged[unmanagedTab]

  return (
    <>
      <div className="mb-3 flex items-center justify-end gap-1.5">
        <GhostButton onClick={() => setHistoryOpen(true)} title="操作历史">
          <span className="flex items-center gap-1.5">
            <ScrollText className="size-3" />
            操作历史
            {historyCount ? (
              <span className="tnum text-[10px] text-ink-tertiary">{historyCount}</span>
            ) : null}
          </span>
        </GhostButton>
        <GhostButton onClick={() => void refreshAll()} disabled={loading}>
          <span className="flex items-center gap-1.5">
            <RefreshCw className={cn('size-3', (loading || unmanagedLoading) && 'animate-spin')} />
            {loading ? '加载中' : '刷新'}
          </span>
        </GhostButton>
        {isAdmin ? (
          <PrimaryButton onClick={() => setDeployOpen(true)}>
            <span className="flex items-center gap-1.5">
              <Rocket className="size-3" />
              新建部署
            </span>
          </PrimaryButton>
        ) : null}
      </div>

      <section className="mb-5">
        {!loaded ? (
          <div className={PROJECT_GRID} aria-busy="true" aria-label="正在加载项目">
            <ProjectCardSkeleton />
            <ProjectCardSkeleton />
            <ProjectCardSkeleton />
          </div>
        ) : loadError ? (
          <Card className="py-12 text-center">
            <AlertTriangle className="mx-auto mb-2 size-6 text-ink-danger" />
            <p className="text-[13px] text-ink-secondary">项目列表加载失败</p>
            <p className="mx-auto mt-1 max-w-md break-words text-[11.5px] text-ink-tertiary">
              {loadError}
            </p>
            <div className="mt-4 flex justify-center">
              <GhostButton onClick={() => void reload()}>重试</GhostButton>
            </div>
          </Card>
        ) : projects.length === 0 ? (
          <Card padded={false} className="flex flex-wrap items-center gap-3 px-4 py-5">
            <Rocket className="size-5 shrink-0 text-ink-tertiary" />
            <div className="min-w-0 flex-1">
              <p className="text-[12.5px] text-ink-secondary">还没有已接管的项目</p>
              <p className="mt-0.5 text-[11px] text-ink-tertiary">
                采集器发现的 Compose 栈可在下方「未托管项目」中接管,也可以直接从 Git 新建部署。
              </p>
            </div>
            {isAdmin ? (
              <PrimaryButton onClick={() => setDeployOpen(true)}>新建部署</PrimaryButton>
            ) : null}
          </Card>
        ) : (
          <div className={PROJECT_GRID}>
            {projects.map((project) => {
              const serverName = project.server_name ?? serverNames[project.server_id]
              const deploy = project.last_deploy_status
                ? DEPLOY_STATUS[project.last_deploy_status]
                : null
              const update = project.update_source
                ? (UPDATE_STATUS[project.update_status ?? ''] ?? UPDATE_STATUS.unknown)
                : null
              const tags = project.tags ?? []

              return (
                <Card
                  key={project.id}
                  padded={false}
                  className="flex flex-col overflow-hidden transition-colors hover:border-line-strong"
                >
                  <div className="min-w-0 p-3">
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                      <h3
                        className="min-w-0 max-w-full truncate text-[13.5px] leading-5 font-semibold text-ink"
                        title={project.name}
                      >
                        {project.name}
                      </h3>
                      {tags.slice(0, 2).map((tag) => (
                        <Badge key={tag} tone="neutral">
                          {tag}
                        </Badge>
                      ))}
                      {tags.length > 2 ? (
                        <span
                          className="shrink-0 text-[10.5px] text-ink-tertiary"
                          title={tags.slice(2).join('、')}
                        >
                          +{tags.length - 2}
                        </span>
                      ) : null}
                    </div>

                    {project.url ? (
                      <a
                        href={project.url}
                        target="_blank"
                        rel="noreferrer"
                        className="mt-0.5 flex h-[17px] min-w-0 items-center gap-1 text-[11.5px] text-accent hover:underline"
                      >
                        <span className="truncate" title={project.url}>
                          {shortUrl(project.url)}
                        </span>
                        <ExternalLink className="size-3 shrink-0" />
                      </a>
                    ) : (
                      <span className="mt-0.5 flex h-[17px] items-center text-[11.5px] text-ink-tertiary">
                        未配置访问地址
                      </span>
                    )}

                    <div className="mt-2 flex min-w-0 items-center gap-1.5 text-[11px]">
                      <ServerIcon className="size-3 shrink-0 text-ink-tertiary" />
                      <span
                        className="max-w-[45%] shrink-0 truncate text-ink-secondary"
                        title={serverName ?? undefined}
                      >
                        {serverName ?? '—'}
                      </span>
                      {project.work_dir ? (
                        <span
                          className="mono min-w-0 flex-1 truncate text-[10.5px] text-ink-tertiary"
                          title={`${project.work_dir}${project.compose_file ? ` / ${project.compose_file}` : ''}`}
                        >
                          {project.work_dir}
                          {project.compose_file ? ` / ${project.compose_file}` : ''}
                        </span>
                      ) : null}
                    </div>

                    <div className="mt-2.5 grid grid-cols-2 border-t border-line pt-2.5">
                      <div className="min-w-0 pe-3">
                        <div className="flex items-center gap-1.5 text-[10.5px] text-ink-tertiary">
                          <span className="shrink-0">部署</span>
                          {deploy ? (
                            <>
                              <span className={cn('size-1.5 shrink-0 rounded-full', deploy.dot)} />
                              <span className={cn('truncate', deploy.text)}>{deploy.label}</span>
                            </>
                          ) : (
                            <span>—</span>
                          )}
                        </div>
                        <div
                          className="mt-0.5 h-4 truncate text-[10.5px] text-ink-tertiary"
                          title={
                            project.last_deploy_at
                              ? new Date(project.last_deploy_at).toLocaleString('zh-CN')
                              : undefined
                          }
                        >
                          {project.last_deploy_at ? (
                            <>
                              {formatWhen(project.last_deploy_at)}
                              {project.last_deploy_username
                                ? ` · ${project.last_deploy_username}`
                                : ''}
                            </>
                          ) : null}
                        </div>
                      </div>

                      <div className="min-w-0 border-s border-line ps-3">
                        <div className="flex items-center gap-1.5 text-[10.5px] text-ink-tertiary">
                          <span className="shrink-0">更新</span>
                          {update ? (
                            <>
                              <span className={cn('size-1.5 shrink-0 rounded-full', update.dot)} />
                              <span className={cn('truncate', update.text)}>{update.label}</span>
                            </>
                          ) : (
                            <span title="在「版本更新」页配置更新来源">未接入</span>
                          )}
                        </div>
                        <div className="mt-0.5 h-4 truncate text-[10.5px] text-ink-tertiary">
                          {project.update_source ? (
                            <>
                              {UPDATE_SOURCE[project.update_source] ?? project.update_source}
                              {project.update_branch ? ` · ${project.update_branch}` : ''}
                            </>
                          ) : null}
                        </div>
                      </div>
                    </div>
                  </div>

                  <div className="mt-auto flex items-center gap-0.5 border-t border-line bg-secondary/40 px-1.5 py-1">
                    <button
                      type="button"
                      onClick={() => setWorkspace(project)}
                      title="打开项目工作区"
                      aria-label={`${project.name} 打开项目`}
                      className="flex size-7 cursor-pointer items-center justify-center rounded-md text-ink-secondary transition-colors hover:bg-overlay-light hover:text-ink"
                    >
                      <FolderOpen className="size-3.5" />
                    </button>
                    {canOperate ? (
                      <>
                        {readActions.map((action) => renderAction(project, action))}
                        <span className="flex-1" />
                        {readActions.length > 0 && writeActions.length > 0 ? (
                          <span className="mx-0.5 h-4 w-px shrink-0 bg-line" aria-hidden="true" />
                        ) : null}
                        {writeActions.map((action) => renderAction(project, action))}
                      </>
                    ) : (
                      <div className="flex w-full items-center justify-end gap-1 px-1 py-0.5 text-[11px] text-ink-tertiary">
                        <Lock className="size-3" />
                        只读
                      </div>
                    )}
                  </div>
                </Card>
              )
            })}
          </div>
        )}
      </section>

      {msg ? (
        <div
          role="status"
          className={cn(
            'mb-5 rounded-md border px-3 py-2 text-[12px]',
            msg.ok
              ? 'border-line bg-tint-success text-ink-success'
              : 'border-line-danger bg-tint-danger text-ink-danger',
          )}
        >
          {msg.text}
        </div>
      ) : null}

      <section className="mb-5" aria-labelledby="unmanaged-heading">
        <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-2">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <h2 id="unmanaged-heading" className="text-[12.5px] font-semibold text-ink">
                未托管项目
              </h2>
              <span className="text-[10.5px] text-ink-tertiary">采集自动发现 · 只读</span>
              {unmanagedLoading ? (
                <Loader2 className="size-3 animate-spin text-ink-tertiary" aria-label="正在刷新未托管项目" />
              ) : null}
            </div>
            <p className="mt-0.5 text-[11px] text-ink-tertiary">
              接管只登记资产,不重启容器;接管后才会参与部署、更新、操作和告警。
            </p>
          </div>
          <div
            className="flex flex-wrap items-center gap-1"
            role="group"
            aria-label="未托管项目筛选"
          >
            {UNMANAGED_TABS.map((tab) => {
              const active = unmanagedTab === tab.key
              return (
                <button
                  key={tab.key}
                  type="button"
                  onClick={() => setUnmanagedTab(tab.key)}
                  aria-pressed={active}
                  className={cn(
                    'flex h-7 cursor-pointer items-center gap-1.5 rounded-md border px-2.5 text-[11px] transition-colors',
                    active
                      ? 'border-line-strong bg-overlay-light font-medium text-ink'
                      : 'border-line bg-primary text-ink-secondary hover:bg-overlay-lighter',
                  )}
                >
                  {tab.label}
                  <span className="tnum text-[10px] text-ink-tertiary">
                    {unmanagedLoaded ? unmanaged[tab.key].length : '…'}
                  </span>
                </button>
              )
            })}
          </div>
        </div>

        {unmanagedMsg ? (
          <div
            role="status"
            className={cn(
              'mb-2 rounded-md border px-3 py-1.5 text-[11px]',
              unmanagedMsg.ok
                ? 'border-line bg-tint-success text-ink-success'
                : 'border-line-danger bg-tint-danger text-ink-danger',
            )}
          >
            {unmanagedMsg.text}
          </div>
        ) : null}

        <Card padded={false} className="overflow-hidden">
          {!unmanagedLoaded ? (
            <UnmanagedSkeleton />
          ) : unmanagedError ? (
            <div className="flex flex-wrap items-center gap-2 px-3 py-3">
              <p className="min-w-0 flex-1 text-[11.5px] break-words text-ink-danger">
                未托管项目加载失败：{unmanagedError}
              </p>
              <GhostButton onClick={() => void reloadUnmanaged()}>重试</GhostButton>
            </div>
          ) : unmanagedRows.length === 0 ? (
            <div className="flex items-center gap-2.5 px-4 py-5">
              <Boxes className="size-4 shrink-0 text-ink-tertiary" />
              <div className="min-w-0">
                <p className="text-[12px] text-ink-secondary">
                  {unmanagedTab === 'discovered' ? '暂无待接管的 Compose 项目' : '暂无已忽略的项目'}
                </p>
                <p className="mt-0.5 text-[10.5px] text-ink-tertiary">
                  {unmanagedTab === 'discovered'
                    ? '在服务器上部署新的 Compose 栈后,会自动出现在这里。'
                    : '忽略的项目会保留在此,随时可以恢复。'}
                </p>
              </div>
            </div>
          ) : (
            <ul>
              {unmanagedRows.map((project) => (
                <UnmanagedRow
                  key={project.id}
                  project={project}
                  serverName={project.server_name ?? serverNames[project.server_id] ?? null}
                  busy={unmanagedBusy === project.id}
                  isAdmin={isAdmin}
                  onAdopt={() => setAdopting(project)}
                  onIgnore={() => void ignoreProject(project)}
                  onRestore={() => void restoreProject(project)}
                />
              ))}
            </ul>
          )}
        </Card>
      </section>

      {workspace ? (
        <ProjectWorkspaceDialog
          project={workspace}
          user={user}
          catalog={catalog}
          onClose={() => setWorkspace(null)}
        />
      ) : null}

      {adopting ? (
        <AdoptProjectDialog
          project={adopting}
          onClose={() => setAdopting(null)}
          onAdopted={async (adopted) => {
            setUnmanagedMsg({ text: `已接管「${adopted.name}」,现在可部署、更新与操作。`, ok: true })
            await refreshAll()
          }}
        />
      ) : null}

      {historyOpen ? (
        <HistoryDialog
          logs={logs}
          actionLabels={actionLabels}
          loaded={loaded}
          loading={loading}
          error={logsError}
          onClose={closeHistory}
          onRetry={() => void reload()}
        />
      ) : null}

      {deployOpen ? (
        <DeployDialog onClose={() => setDeployOpen(false)} onDeployed={refreshAll} />
      ) : null}
    </>
  )
}
