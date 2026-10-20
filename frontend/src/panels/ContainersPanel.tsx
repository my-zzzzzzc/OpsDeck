import { Boxes, ChevronRight, CircleSlash, Search, Server as ServerIcon, X } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { api, DANGER_LABEL, type ActionCatalogItem, type InstanceDetail, type Project, type Server, type User } from '../api'
import { cn } from '../cn'
import { PageSkeleton } from '../motion'
import { Badge, Card } from '../ui'
import { ContainerLogPanel } from './ContainerLogDrawer'
import { ProjectLogDialog } from './ProjectLogDialog'

type Bucket = 'running' | 'unhealthy' | 'stopped' | 'done'

function isOneShot(name: string): boolean {
  return ['init', 'migrat', 'setup', 'provision'].some((marker) => name.toLowerCase().includes(marker))
}

function bucketOf(container: InstanceDetail): Bucket {
  if ((container.state ?? '').toLowerCase() !== 'running') return isOneShot(container.name) ? 'done' : 'stopped'
  return (container.health ?? '').toLowerCase() === 'unhealthy' ? 'unhealthy' : 'running'
}

const LABEL: Record<Bucket, string> = {
  running: '运行中',
  unhealthy: '不健康',
  stopped: '已停止',
  done: '已完成',
}

const TONE: Record<Bucket, { dot: string; badge: 'ok' | 'warn' | 'bad' | 'neutral'; line: string }> = {
  running: { dot: 'bg-ink-success', badge: 'ok', line: 'border-transparent' },
  unhealthy: { dot: 'bg-ink-warning', badge: 'warn', line: 'border-ink-warning' },
  stopped: { dot: 'bg-ink-danger', badge: 'bad', line: 'border-ink-danger' },
  done: { dot: 'bg-ink-tertiary', badge: 'neutral', line: 'border-transparent' },
}

function needsAttention(container: InstanceDetail): boolean {
  const bucket = bucketOf(container)
  return bucket === 'unhealthy' || bucket === 'stopped'
}

function detailValue(value?: string | number | null): string {
  return value == null || value === '' ? '—' : String(value)
}

/** 容器排障工作台:左侧定位容器,中间持续查看详情与日志。 */
export function ContainersPanel({ user }: { user: User }) {
  const [containers, setContainers] = useState<InstanceDetail[]>([])
  const [servers, setServers] = useState<Server[]>([])
  const [projects, setProjects] = useState<Project[]>([])
  const [catalog, setCatalog] = useState<ActionCatalogItem[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<Bucket | 'attention' | 'all'>('all')
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const collapsedInitialized = useRef(false)

  const load = useCallback(async () => {
    try {
      const [instances, serverList, projectList, actionCatalog] = await Promise.all([
        api.instancesDetail(), api.servers(), api.projects(), api.actionCatalog(),
      ])
      setContainers(instances)
      setServers(serverList)
      setProjects(projectList)
      setCatalog(actionCatalog)
      setError(null)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
    const timer = setInterval(() => void load(), 15_000)
    return () => clearInterval(timer)
  }, [load])

  const counts = useMemo(() => {
    const value = { running: 0, unhealthy: 0, stopped: 0, done: 0 }
    for (const container of containers) value[bucketOf(container)] += 1
    return value
  }, [containers])

  const visible = useMemo(() => {
    const text = query.trim().toLowerCase()
    return containers.filter((container) => {
      const bucket = bucketOf(container)
      if (filter === 'attention' && !needsAttention(container)) return false
      if (filter !== 'all' && filter !== 'attention' && bucket !== filter) return false
      if (!text) return true
      return [container.name, container.project_name, container.image, container.server_name]
        .filter((value): value is string => Boolean(value))
        .some((value) => value.toLowerCase().includes(text))
    })
  }, [containers, filter, query])

  const groups = useMemo(() => {
    const byServer = new Map<string, { id: string; name: string; items: InstanceDetail[] }>()
    for (const container of visible) {
      const id = container.server_id ?? 'unknown'
      const group = byServer.get(id) ?? { id, name: container.server_name ?? '未知服务器', items: [] }
      group.items.push(container)
      byServer.set(id, group)
    }
    const rank = (container: InstanceDetail) => ({ unhealthy: 0, stopped: 1, running: 2, done: 3 })[bucketOf(container)]
    for (const group of byServer.values()) group.items.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name))
    return [...byServer.values()].sort((a, b) => a.name.localeCompare(b.name))
  }, [visible])

  const selected = containers.find((container) => container.id === selectedId) ?? null

  useEffect(() => {
    if (collapsedInitialized.current || groups.length === 0) return
    collapsedInitialized.current = true
    setCollapsed(new Set(groups.filter((group) => !group.items.some(needsAttention)).map((group) => group.id)))
  }, [groups])

  // 初始选择异常容器;轮询后若目标消失,自动切到当前容器的第一项。
  useEffect(() => {
    if (selectedId != null && containers.some((container) => container.id === selectedId)) return
    const firstIssue = containers.find(needsAttention)
    setSelectedId((firstIssue ?? containers[0] ?? null)?.id ?? null)
  }, [containers, selectedId])

  if (loading) return <PageSkeleton />
  if (error) return <p className="py-16 text-center text-ink-danger">加载失败: {error}</p>

  const attention = counts.unhealthy + counts.stopped
  const filters: Array<{ key: Bucket | 'attention' | 'all'; label: string; count: number }> = [
    { key: 'all', label: '全部', count: containers.length },
    { key: 'attention', label: '需关注', count: attention },
    { key: 'running', label: '运行中', count: counts.running },
    { key: 'done', label: '已完成', count: counts.done },
  ]

  const toggleGroup = (id: string) => setCollapsed((previous) => {
    const next = new Set(previous)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    return next
  })

  return (
    <div className="flex flex-col gap-3">
      <Card padded={false} className="overflow-hidden">
        <div className="grid grid-cols-2 divide-x divide-y divide-line sm:grid-cols-5 sm:divide-y-0">
          {[
            { label: '总数', count: containers.length, tone: 'text-ink' },
            { label: '运行中', count: counts.running, tone: 'text-ink-success' },
            { label: '需关注', count: attention, tone: attention > 0 ? 'text-ink-warning' : 'text-ink-tertiary' },
            { label: '已停止', count: counts.stopped, tone: counts.stopped > 0 ? 'text-ink-danger' : 'text-ink-tertiary' },
            { label: '已完成', count: counts.done, tone: 'text-ink-tertiary' },
          ].map((item) => (
            <div key={item.label} className="px-3.5 py-2.5">
              <div className="text-[10px] text-ink-tertiary">{item.label}</div>
              <div className={cn('mt-0.5 text-[17px] font-semibold tabular-nums', item.tone)}>{item.count}</div>
            </div>
          ))}
        </div>
        <div className="flex h-1.5 gap-px bg-overlay-medium">
          {(['running', 'unhealthy', 'stopped', 'done'] as const).map((bucket) => counts[bucket] > 0 ? (
            <span key={bucket} className={TONE[bucket].dot} style={{ flexGrow: counts[bucket], flexBasis: 0 }} title={`${LABEL[bucket]} ${counts[bucket]}`} />
          ) : null)}
        </div>
      </Card>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <div className="flex items-center gap-2">
          <Boxes className="size-4 text-ink-tertiary" />
          <span className="text-[14px] font-semibold text-ink">容器工作台</span>
          <span className="text-[11px] text-ink-tertiary">{servers.length} 台服务器 · {containers.length} 个容器</span>
        </div>

        <div className="relative min-w-0 flex-1 sm:max-w-sm">
          <Search className="pointer-events-none absolute start-2.5 top-1/2 size-3.5 -translate-y-1/2 text-ink-tertiary" />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索容器、项目、镜像或服务器"
            aria-label="搜索容器"
            className="h-8 w-full rounded-md border border-line bg-primary ps-8 pe-8 text-[12px] text-ink outline-none placeholder:text-ink-tertiary focus:border-accent"
          />
          {query ? (
            <button type="button" onClick={() => setQuery('')} aria-label="清空搜索" className="absolute end-2 top-1/2 -translate-y-1/2 text-ink-tertiary hover:text-ink">
              <X className="size-3.5" />
            </button>
          ) : null}
        </div>

        <div className="flex flex-wrap items-center gap-1">
          {filters.map((item) => {
            const active = filter === item.key
            return (
              <button
                key={item.key}
                type="button"
                onClick={() => setFilter(item.key)}
                className={cn('flex h-8 cursor-pointer items-center gap-1 rounded-md px-2 text-[11px] transition-colors', active ? 'bg-overlay-light font-medium text-ink' : 'text-ink-tertiary hover:bg-overlay-lighter hover:text-ink-secondary')}
              >
                {item.label} <span className="tabular-nums">{item.count}</span>
              </button>
            )
          })}
        </div>
      </div>

      <div className="grid min-h-[38rem] gap-3 xl:grid-cols-[minmax(19rem,0.82fr)_minmax(0,1.7fr)]">
        <Card padded={false} className="flex min-h-0 flex-col overflow-hidden">
          <div className="flex items-center justify-between border-b border-line px-3.5 py-2.5">
            <span className="text-[12px] font-semibold text-ink">容器列表</span>
            <span className="text-[10.5px] text-ink-tertiary">按服务器分组</span>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            {groups.length === 0 ? (
              <div className="flex h-full flex-col items-center justify-center gap-2 px-5 text-center text-[12px] text-ink-tertiary">
                <CircleSlash className="size-5" />
                没有匹配的容器
              </div>
            ) : groups.map((group) => {
              const issues = group.items.filter(needsAttention).length
              const isCollapsed = collapsed.has(group.id)
              return (
                <section key={group.id} className="border-b border-line last:border-0">
                  <button type="button" onClick={() => toggleGroup(group.id)} aria-expanded={!isCollapsed} className="flex w-full cursor-pointer items-center gap-2 bg-secondary/30 px-3.5 py-2 text-left hover:bg-overlay-lighter">
                    <ChevronRight className={cn('size-3 shrink-0 text-ink-tertiary transition-transform', isCollapsed ? '' : 'rotate-90')} />
                    <ServerIcon className="size-3.5 text-ink-tertiary" />
                    <span className="min-w-0 flex-1 truncate text-[11.5px] font-medium text-ink-secondary">{group.name}</span>
                    {issues > 0 ? <span className="text-[10px] text-ink-warning">{issues} 异常</span> : null}
                    <span className="rounded-xs bg-overlay-light px-1 text-[9.5px] text-ink-tertiary">{group.items.length}</span>
                  </button>
                  {isCollapsed ? null : group.items.map((container) => {
                    const bucket = bucketOf(container)
                    const active = container.id === selectedId
                    return (
                      <button
                        key={container.id}
                        type="button"
                        onClick={() => setSelectedId(container.id)}
                        className={cn('flex w-full cursor-pointer items-center gap-2 border-s-2 px-3.5 py-2 text-left transition-colors', TONE[bucket].line, active ? 'bg-tint-blue' : 'hover:bg-overlay-lighter')}
                      >
                        <span className={cn('size-1.5 shrink-0 rounded-full', TONE[bucket].dot)} />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-[12px] font-medium text-ink">{container.name}</span>
                          <span className="block truncate text-[10px] text-ink-tertiary">{container.project_name ?? '未归属项目'} · {container.image ?? '未知镜像'}</span>
                        </span>
                        {bucket !== 'running' ? <span className={cn('shrink-0 text-[9.5px]', bucket === 'stopped' ? 'text-ink-danger' : 'text-ink-warning')}>{LABEL[bucket]}</span> : null}
                        <span className="shrink-0 text-right text-[10.5px] tabular-nums text-ink-tertiary">{container.mem_used_mb != null ? `${container.mem_used_mb} MB` : '—'}</span>
                      </button>
                    )
                  })}
                </section>
              )
            })}
          </div>
        </Card>

        <ContainerDetail container={selected} canReadLogs={user.role === 'admin'} canOperate={user.role !== 'viewer'} projects={projects} catalog={catalog} />
      </div>
    </div>
  )
}

function ContainerDetail({ container, canReadLogs, canOperate, projects, catalog }: {
  container: InstanceDetail | null
  canReadLogs: boolean
  canOperate: boolean
  projects: Project[]
  catalog: ActionCatalogItem[]
}) {
  if (!container) {
    return (
      <Card className="flex min-h-0 flex-col items-center justify-center text-center">
        <Boxes className="mb-3 size-7 text-ink-tertiary" />
        <p className="text-[13px] text-ink-secondary">选择一个容器查看详情</p>
        <p className="mt-1 text-[11px] text-ink-tertiary">异常容器会优先显示在左侧列表中。</p>
      </Card>
    )
  }

  const bucket = bucketOf(container)
  const project = projects.find((item) => item.id === container.project_id)
  const memoryLimit = container.mem_limit_mb != null && container.mem_limit_mb > 0 ? `${container.mem_limit_mb} MB` : '未设置'
  const startedAt = container.started_at ? new Date(container.started_at).toLocaleString('zh-CN') : '—'
  return (
    <Card padded={false} className="flex min-h-0 flex-col overflow-hidden">
      <div className="border-b border-line px-4 py-3.5">
        <div className="flex flex-wrap items-start gap-3">
          <span className={cn('mt-1 size-2 shrink-0 rounded-full', TONE[bucket].dot)} />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="mono truncate text-[15px] font-semibold text-ink">{container.name}</h2>
              <Badge tone={TONE[bucket].badge}>{LABEL[bucket]}</Badge>
            </div>
            <p className="mt-1 text-[11px] text-ink-tertiary">{container.server_name ?? '未知服务器'} · {container.project_name ?? '未归属项目'}</p>
          </div>
        </div>

        <dl className="mt-3 grid grid-cols-2 gap-x-5 gap-y-2.5 border-t border-line pt-3 text-[11px] sm:grid-cols-4">
          <DetailItem label="内存" value={container.mem_used_mb != null ? `${container.mem_used_mb} MB` : '—'} />
          <DetailItem label="内存上限" value={memoryLimit} />
          <DetailItem label="运行状态" value={detailValue(container.state)} />
          <DetailItem label="健康检查" value={detailValue(container.health)} />
          <DetailItem label="镜像" value={detailValue(container.image)} mono />
          <DetailItem label="启动时间" value={startedAt} />
          <DetailItem label="更新时间" value={new Date(container.updated_at).toLocaleString('zh-CN')} />
          <DetailItem label="退出码" value={detailValue(container.exit_code)} />
          <DetailItem label="端口" value="当前采集未提供" />
        </dl>
        {canOperate && project ? <ProjectActions project={project} catalog={catalog} /> : null}
      </div>

      {canReadLogs ? <ContainerLogPanel key={container.id} container={container} /> : (
        <div className="flex flex-1 items-center justify-center px-5 text-center text-[12px] text-ink-tertiary">仅管理员可以查看容器日志。</div>
      )}
    </Card>
  )
}

function DetailItem({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="min-w-0">
      <dt className="text-[10px] text-ink-tertiary">{label}</dt>
      <dd className={cn('mt-0.5 truncate text-[11px] text-ink-secondary', mono && 'mono')} title={value}>{value}</dd>
    </div>
  )
}

/** 现有后端的安全边界是项目级 compose 操作，必须明确写出来，避免误导成单容器控制。 */
function ProjectActions({ project, catalog }: { project: Project; catalog: ActionCatalogItem[] }) {
  const [running, setRunning] = useState<string | null>(null)
  const [result, setResult] = useState<{ text: string; ok: boolean } | null>(null)
  const [showLogs, setShowLogs] = useState(false)
  const available = catalog.filter((item) => item.enabled && ['restart', 'start', 'stop'].includes(item.key))

  const run = async (action: ActionCatalogItem) => {
    if (action.confirm_required && !confirm(`确认执行「${action.label}」？\n\n项目：${project.name}\n风险：${DANGER_LABEL[action.danger]}\n\n${action.description}`)) return
    setRunning(action.key)
    setResult(null)
    try {
      const log = await api.executeAction({ project_id: project.id, action: action.key, confirm: action.confirm_required })
      setResult({ text: `${action.label} ${log.status === 'success' ? '已完成' : `结束：${log.status}`}`, ok: log.status === 'success' })
    } catch (error) {
      setResult({ text: (error as Error).message, ok: false })
    } finally {
      setRunning(null)
    }
  }

  return (
    <div className="mt-3 flex flex-wrap items-center gap-1.5 border-t border-line pt-3">
      <span className="me-1 text-[10px] text-ink-tertiary">项目级操作 · {project.name}</span>
      <button
        type="button"
        onClick={() => setShowLogs(true)}
        className="h-7 cursor-pointer rounded-md border border-line px-2 text-[10.5px] text-ink-secondary transition-colors hover:bg-overlay-light hover:text-ink"
      >
        查看日志
      </button>
      {available.map((action) => (
        <button
          key={action.key}
          type="button"
          disabled={running !== null}
          onClick={() => void run(action)}
          title={`${action.description}（作用于项目全部容器）`}
          className={cn('h-7 cursor-pointer rounded-md border px-2 text-[10.5px] transition-colors disabled:cursor-not-allowed disabled:opacity-50', action.danger === 'medium' ? 'border-line-danger/60 text-ink-danger hover:bg-tint-danger' : 'border-line text-ink-secondary hover:bg-overlay-light hover:text-ink')}
        >
          {running === action.key ? '执行中…' : action.label}
        </button>
      ))}
      {result ? <span className={cn('text-[10.5px]', result.ok ? 'text-ink-success' : 'text-ink-danger')}>{result.text}</span> : null}
      {showLogs ? <ProjectLogDialog project={project} onClose={() => setShowLogs(false)} /> : null}
    </div>
  )
}

export { bucketOf as containerBucket }
