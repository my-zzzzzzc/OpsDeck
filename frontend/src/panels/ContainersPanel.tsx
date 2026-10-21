import {
  AlertTriangle,
  Boxes,
  ChevronRight,
  CircleSlash,
  FolderOpen,
  Pencil,
  Play,
  RotateCcw,
  ScrollText,
  Search,
  Server as ServerIcon,
  Square,
  X,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'

import { api, DANGER_LABEL, type ActionCatalogItem, type InstanceDetail, type Project, type Server, type User } from '../api'
import { cn } from '../cn'
import { PageSkeleton } from '../motion'
import { Card } from '../ui'
import { ContainerLogPanel } from './ContainerLogDrawer'
import { ProjectLogDialog } from './ProjectLogDialog'
import { ProjectWorkspaceDialog } from './ProjectWorkspaceDialog'

type Bucket = 'running' | 'unhealthy' | 'stopped' | 'done'
type Filter = Bucket | 'attention' | 'all'

function isOneShot(name: string): boolean {
  return ['init', 'migrat', 'setup', 'provision'].some((marker) => name.toLowerCase().includes(marker))
}

function bucketOf(container: InstanceDetail): Bucket {
  if ((container.state ?? '').toLowerCase() !== 'running') return isOneShot(container.name) ? 'done' : 'stopped'
  return (container.health ?? '').toLowerCase() === 'unhealthy' ? 'unhealthy' : 'running'
}

function needsAttention(container: InstanceDetail): boolean {
  const bucket = bucketOf(container)
  return bucket === 'unhealthy' || bucket === 'stopped'
}

const LABEL: Record<Bucket, string> = {
  running: '运行中',
  unhealthy: '不健康',
  stopped: '已停止',
  done: '已完成',
}

const TONE: Record<Bucket, { dot: string; text: string; bar: string; rail: string; height: string }> = {
  running: { dot: 'bg-status-ok', text: 'text-ink-secondary', bar: 'bg-status-ok', rail: 'bg-status-ok', height: 'h-2.5' },
  unhealthy: { dot: 'bg-status-warn', text: 'text-ink-warning', bar: 'bg-status-warn', rail: 'bg-status-warn', height: 'h-4' },
  stopped: { dot: 'bg-status-bad', text: 'text-ink-danger', bar: 'bg-status-bad', rail: 'bg-status-bad', height: 'h-5' },
  done: { dot: 'bg-ink-tertiary', text: 'text-ink-tertiary', bar: 'bg-ink-tertiary', rail: 'bg-ink-tertiary', height: 'h-1.5' },
}

const HEALTH_TEXT: Record<string, string> = {
  healthy: '健康',
  unhealthy: '不健康',
  starting: '检查中',
  running: '无检查',
  none: '无检查',
}

function detailValue(value?: string | number | null): string {
  return value == null || value === '' ? '—' : String(value)
}

function absoluteTime(value: string | null): string {
  if (!value) return '—'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString('zh-CN')
}

function shortTime(value: string | null): string {
  if (!value) return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '—'
  const today = new Date()
  return date.toDateString() === today.toDateString()
    ? date.toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit' })
    : date.toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' })
}

function elapsedSince(value: string | null): string {
  if (!value) return '—'
  const started = new Date(value).getTime()
  if (!Number.isFinite(started)) return '—'
  const minutes = Math.max(0, Math.floor((Date.now() - started) / 60_000))
  if (minutes < 60) return `${minutes} 分钟`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} 小时`
  return `${Math.floor(hours / 24)} 天`
}

function memoryLabel(value: number | null): string {
  return value == null ? '—' : `${value} MB`
}

/** 容器排障工作台：左侧定位容器，右侧持续查看详情与日志。 */
export function ContainersPanel({ user }: { user: User }) {
  const [containers, setContainers] = useState<InstanceDetail[]>([])
  const [servers, setServers] = useState<Server[]>([])
  const [projects, setProjects] = useState<Project[]>([])
  const [catalog, setCatalog] = useState<ActionCatalogItem[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [syncedAt, setSyncedAt] = useState<Date | null>(null)
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<Filter>('all')
  const [selectedId, setSelectedId] = useState<number | null>(null)
  // 用户手动折叠/展开过的分组；没动过的分组按是否有异常推导默认状态
  const [collapsedOverrides, setCollapsedOverrides] = useState<Map<string, boolean>>(new Map())
  const [workspace, setWorkspace] = useState<Project | null>(null)
  const [workspaceTab, setWorkspaceTab] = useState<'overview' | 'services' | 'config'>('overview')
  const [workspaceFocus, setWorkspaceFocus] = useState<number | null>(null)
  const listRef = useRef<HTMLDivElement>(null)

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
      setSyncedAt(new Date())
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

  // 按项目分组:容器配置属于 Compose 项目,项目才是排障的归属单位。
  // 服务器作为组头的第二行保留,需要按机器定位时仍能直接读到。
  const groups = useMemo(() => {
    const byProject = new Map<string, { id: string; name: string; server: string; items: InstanceDetail[] }>()
    for (const container of visible) {
      const id = container.project_id
      const group = byProject.get(id) ?? {
        id,
        name: container.project_name ?? '未归属项目',
        server: container.server_name ?? '未知服务器',
        items: [],
      }
      group.items.push(container)
      byProject.set(id, group)
    }
    const rank = (container: InstanceDetail) => ({ unhealthy: 0, stopped: 1, running: 2, done: 3 })[bucketOf(container)]
    for (const group of byProject.values()) group.items.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name))
    return [...byProject.values()].sort((a, b) => a.name.localeCompare(b.name) || a.server.localeCompare(b.server))
  }, [visible])

  const projectCount = useMemo(
    () => new Set(containers.map((container) => container.project_id)).size,
    [containers],
  )

  const selected = containers.find((container) => container.id === selectedId) ?? null

  // 初始选择异常容器；轮询后若目标消失，自动切到当前容器的第一项。
  useEffect(() => {
    if (selectedId != null && containers.some((container) => container.id === selectedId)) return
    const firstIssue = containers.find(needsAttention)
    setSelectedId((firstIssue ?? containers[0] ?? null)?.id ?? null)
  }, [containers, selectedId])

  if (loading) return <PageSkeleton />
  if (error && containers.length === 0) return <p className="py-16 text-center text-ink-danger">加载失败：{error}</p>

  const attention = counts.unhealthy + counts.stopped
  const filters: Array<{ key: Filter; label: string; count: number }> = [
    { key: 'all', label: '全部', count: containers.length },
    { key: 'attention', label: '需关注', count: attention },
    { key: 'running', label: '运行中', count: counts.running },
    { key: 'done', label: '已完成', count: counts.done },
  ]

  const filtering = query.trim() !== '' || filter !== 'all'

  const toggleGroup = (id: string, isCollapsed: boolean) => setCollapsedOverrides(
    (previous) => new Map(previous).set(id, !isCollapsed),
  )

  const resetFilters = () => {
    setQuery('')
    setFilter('all')
  }

  const openWorkspace = (project: Project, focusId?: number) => {
    setWorkspace(project)
    setWorkspaceFocus(focusId ?? null)
    // 没有可编辑的 Compose 路径时,直接落到「项目内每个容器」的配置列表,
    // 而不是一张全是「—」的项目概览。
    setWorkspaceTab(project.kind === 'docker-compose' && project.work_dir ? 'config' : 'services')
  }

  // 信号轨是全局导航：选中后清掉筛选、展开所属项目，保证列表里能对上号。
  const selectFromRail = (container: InstanceDetail) => {
    setSelectedId(container.id)
    setQuery('')
    setFilter('all')
    setCollapsedOverrides((previous) => new Map(previous).set(container.project_id, false))
    requestAnimationFrame(() => {
      listRef.current?.querySelector<HTMLElement>(`[data-container-id="${container.id}"]`)?.scrollIntoView({ block: 'nearest' })
    })
  }

  return (
    <div className="flex flex-col gap-3">
      <FleetBar
        containers={containers}
        counts={counts}
        serverCount={servers.length}
        selectedId={selectedId}
        onSelect={selectFromRail}
      />

      {error ? (
        <p className="flex items-center gap-1.5 rounded-md border border-line-danger/60 bg-tint-danger px-3 py-1.5 text-[11px] text-ink-danger">
          <AlertTriangle className="size-3.5 shrink-0" />
          刷新失败：{error}。以下为上次采集结果。
        </p>
      ) : null}

      <div className="grid min-h-0 gap-3 xl:h-[calc(100dvh-19rem)] xl:min-h-[32rem] xl:grid-cols-[22rem_minmax(0,1fr)]">
        <Card padded={false} className="flex max-h-[30rem] min-h-0 flex-col overflow-hidden xl:max-h-none">
          <div className="shrink-0 border-b border-line px-3 pt-2.5 pb-2">
            <div className="flex items-baseline justify-between gap-2">
              <div className="flex items-baseline gap-1.5">
                <h2 className="text-[12px] font-semibold text-ink">容器列表</h2>
                <span className="text-[10px] text-ink-tertiary">按项目 · {projectCount} 个</span>
              </div>
              <span className="text-[10.5px] tabular-nums text-ink-tertiary">
                {filtering ? `${visible.length} / ${containers.length}` : containers.length} 个容器
              </span>
            </div>

            <div className="relative mt-2">
              <Search className="pointer-events-none absolute start-2 top-1/2 size-3.5 -translate-y-1/2 text-ink-tertiary" />
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="搜索名称、镜像、项目"
                aria-label="搜索容器"
                className="h-7 w-full rounded-md border border-line bg-background ps-7 pe-7 text-[11.5px] text-ink outline-none placeholder:text-ink-tertiary focus:border-line-strong"
              />
              {query ? (
                <button
                  type="button"
                  onClick={() => setQuery('')}
                  aria-label="清空搜索"
                  className="absolute end-1.5 top-1/2 flex size-5 -translate-y-1/2 cursor-pointer items-center justify-center rounded-sm text-ink-tertiary hover:bg-overlay-light hover:text-ink"
                >
                  <X className="size-3" />
                </button>
              ) : null}
            </div>

            <div className="mt-1.5 flex flex-wrap items-center gap-0.5">
              {filters.map((item) => {
                const active = filter === item.key
                return (
                  <button
                    key={item.key}
                    type="button"
                    onClick={() => setFilter(item.key)}
                    aria-pressed={active}
                    className={cn(
                      'flex h-6 cursor-pointer items-center gap-1 rounded-sm px-1.5 text-[10.5px] transition-colors',
                      active ? 'bg-overlay-light font-medium text-ink' : 'text-ink-tertiary hover:text-ink-secondary',
                    )}
                  >
                    {item.label}
                    <span className="tabular-nums">{item.count}</span>
                  </button>
                )
              })}
            </div>
          </div>

          <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto">
            {groups.length === 0 ? (
              <div className="flex h-full min-h-40 flex-col items-center justify-center gap-2 px-5 text-center">
                <CircleSlash className="size-5 text-ink-tertiary" />
                <p className="text-[12px] text-ink-tertiary">没有匹配的容器</p>
                {filtering ? (
                  <button
                    type="button"
                    onClick={resetFilters}
                    className="h-6 cursor-pointer rounded-sm px-2 text-[10.5px] text-ink-secondary hover:bg-accent-soft hover:text-ink"
                  >
                    清除筛选
                  </button>
                ) : null}
              </div>
            ) : groups.map((group) => {
              const issues = group.items.filter(needsAttention).length
              // 有异常的分组默认展开；搜索/筛选时全部展开，只有手动折叠才会覆盖默认值
              const isCollapsed = collapsedOverrides.get(group.id) ?? (!filtering && issues === 0)
              return (
                <section key={group.id} className="border-b border-line last:border-0">
                  <button
                    type="button"
                    onClick={() => toggleGroup(group.id, isCollapsed)}
                    aria-expanded={!isCollapsed}
                    className="sticky top-0 z-10 flex w-full cursor-pointer items-center gap-1.5 border-b border-line bg-secondary px-3 py-1.5 text-left"
                  >
                    <ChevronRight className={cn('size-3 shrink-0 text-ink-tertiary transition-transform', isCollapsed ? '' : 'rotate-90')} />
                    <FolderOpen className="size-3 shrink-0 text-ink-tertiary" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[11px] font-medium text-ink-secondary" title={group.name}>{group.name}</span>
                      <span className="mt-0.5 flex min-w-0 items-center gap-1 text-[9.5px] text-ink-tertiary">
                        <ServerIcon className="size-2.5 shrink-0" />
                        <span className="truncate" title={group.server}>{group.server}</span>
                      </span>
                    </span>
                    {issues > 0 ? <span className="shrink-0 text-[10px] tabular-nums text-ink-warning">{issues} 异常</span> : null}
                    <span className="shrink-0 text-[10px] tabular-nums text-ink-tertiary">{group.items.length}</span>
                  </button>

                  {isCollapsed ? null : group.items.map((container) => {
                    const bucket = bucketOf(container)
                    const active = container.id === selectedId
                    const isIssue = bucket === 'unhealthy' || bucket === 'stopped'
                    // 采集不到就不写：整列「启动时间未知」比留白更像故障
                    const hint = bucket === 'running' || bucket === 'unhealthy'
                      ? (container.started_at ? `已运行 ${elapsedSince(container.started_at)}` : null)
                      : (container.exit_code != null ? `退出码 ${container.exit_code}` : null)
                    return (
                      <button
                        key={container.id}
                        type="button"
                        data-container-id={container.id}
                        onClick={() => setSelectedId(container.id)}
                        aria-current={active ? 'true' : undefined}
                        className={cn(
                          'relative flex w-full cursor-pointer items-center gap-2.5 border-b border-line/60 px-3 py-2 text-left transition-colors last:border-b-0',
                          active ? 'bg-tint-blue' : 'hover:bg-overlay-lighter',
                        )}
                      >
                        <span className={cn('absolute inset-y-0 start-0 w-[2px]', active ? 'bg-accent' : isIssue ? TONE[bucket].bar : 'bg-transparent')} />
                        <span className={cn('size-1.5 shrink-0 rounded-full', TONE[bucket].dot)} />
                        <span className="min-w-0 flex-1">
                          <span className="flex items-center gap-1.5">
                            <span className="truncate text-[13px] font-medium text-ink">{container.name}</span>
                            {bucket !== 'running' ? (
                              <span className={cn('shrink-0 text-[10px]', TONE[bucket].text)}>{LABEL[bucket]}</span>
                            ) : null}
                          </span>
                          <span className="mt-0.5 block truncate text-[10.5px] text-ink-tertiary">
                            {container.project_name ?? '未归属项目'} · {container.image ?? '未知镜像'}
                          </span>
                        </span>
                        {container.mem_used_mb != null || hint ? (
                          <span className="flex shrink-0 flex-col items-end gap-0.5">
                            {container.mem_used_mb != null ? (
                              <span className="text-[11px] tabular-nums text-ink-secondary">{memoryLabel(container.mem_used_mb)}</span>
                            ) : null}
                            {hint ? <span className="text-[10px] tabular-nums text-ink-tertiary">{hint}</span> : null}
                          </span>
                        ) : null}
                      </button>
                    )
                  })}
                </section>
              )
            })}
          </div>

          <footer className="flex shrink-0 items-center gap-1.5 border-t border-line px-3 py-1.5 text-[10px] text-ink-tertiary">
            <span className={cn('size-1.5 rounded-full', error ? 'bg-status-bad' : 'bg-status-ok')} />
            {error ? '刷新失败' : '15 秒自动刷新'}
            <span className="ms-auto tabular-nums">{syncedAt ? syncedAt.toLocaleTimeString('zh-CN', { hour12: false }) : '—'}</span>
          </footer>
        </Card>

        <ContainerDetail
          container={selected}
          canReadLogs={user.role === 'admin'}
          canOperate={user.role !== 'viewer'}
          canEdit={user.role === 'admin'}
          projects={projects}
          catalog={catalog}
          onEdit={openWorkspace}
        />
      </div>

      {workspace ? (
        <ProjectWorkspaceDialog
          project={workspace}
          user={user}
          catalog={catalog}
          initialTab={workspaceTab}
          focusInstanceId={workspaceFocus ?? undefined}
          onClose={() => setWorkspace(null)}
        />
      ) : null}
    </div>
  )
}

function FleetBar({ containers, counts, serverCount, selectedId, onSelect }: {
  containers: InstanceDetail[]
  counts: { running: number; unhealthy: number; stopped: number; done: number }
  serverCount: number
  selectedId: number | null
  onSelect: (container: InstanceDetail) => void
}) {
  const attention = counts.unhealthy + counts.stopped
  const ordered = useMemo(() => {
    const rank = (container: InstanceDetail) => ({ unhealthy: 0, stopped: 1, running: 2, done: 3 })[bucketOf(container)]
    return [...containers].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name))
  }, [containers])

  return (
    <Card padded={false} className="overflow-hidden">
      <div className="flex flex-col gap-3 px-4 py-3 lg:flex-row lg:items-center lg:gap-5">
        <div className="flex shrink-0 items-center gap-3 lg:w-48">
          <span className={cn('text-[26px] leading-none font-semibold tabular-nums', attention > 0 ? 'text-ink-warning' : 'text-ink')}>
            {attention}
          </span>
          <div className="min-w-0">
            <p className="text-[12px] font-medium text-ink-secondary">个容器需关注</p>
            <p className="mt-0.5 truncate text-[10.5px] text-ink-tertiary">
              {attention > 0 ? `${counts.unhealthy} 不健康 · ${counts.stopped} 已停止` : '当前没有异常容器'}
            </p>
          </div>
        </div>

        <div className="hidden h-9 w-px shrink-0 bg-line lg:block" />

        <div className="min-w-0 flex-1">
          <div className="mb-1.5 flex items-baseline justify-between gap-3 text-[10.5px] text-ink-tertiary">
            <span>
              全部容器 <b className="font-medium tabular-nums text-ink-secondary">{containers.length}</b>
            </span>
            <span>{serverCount} 台服务器</span>
          </div>

          {/* 信号轨：一台容器一个刻度，异常刻度更高、发色；点刻度直接定位容器。 */}
          <div className="flex h-6 items-end gap-[3px] overflow-x-auto border-b border-line" role="group" aria-label="容器状态信号轨">
            {ordered.map((container) => {
              const bucket = bucketOf(container)
              const active = container.id === selectedId
              const dim = bucket === 'running' || bucket === 'done'
              return (
                <button
                  key={container.id}
                  type="button"
                  onClick={() => onSelect(container)}
                  title={`${container.name} · ${LABEL[bucket]} · ${container.project_name ?? '未归属项目'}`}
                  aria-label={`选择 ${container.name}（${LABEL[bucket]}）`}
                  aria-current={active ? 'true' : undefined}
                  className="group flex h-6 w-3 shrink-0 cursor-pointer items-end justify-center"
                >
                  <span
                    className={cn(
                      'rounded-xs transition-all duration-150 group-hover:opacity-100',
                      TONE[bucket].rail,
                      active ? 'h-6 w-2 opacity-100' : cn('w-1.5', TONE[bucket].height, dim ? 'opacity-60' : 'opacity-100'),
                    )}
                  />
                </button>
              )
            })}
          </div>

          <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10.5px] text-ink-tertiary">
            {(['running', 'unhealthy', 'stopped', 'done'] as const).map((bucket) => (
              <span key={bucket} className="flex items-center gap-1">
                <i className={cn('size-1.5 rounded-full', TONE[bucket].dot)} />
                {LABEL[bucket]}
                <b className="font-medium tabular-nums text-ink-secondary">{counts[bucket]}</b>
              </span>
            ))}
          </div>
        </div>
      </div>
    </Card>
  )
}

function ContainerDetail({ container, canReadLogs, canOperate, canEdit, projects, catalog, onEdit }: {
  container: InstanceDetail | null
  canReadLogs: boolean
  canOperate: boolean
  canEdit: boolean
  projects: Project[]
  catalog: ActionCatalogItem[]
  onEdit: (project: Project, focusId?: number) => void
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
  const isIssue = bucket === 'unhealthy' || bucket === 'stopped'
  const project = projects.find((item) => item.id === container.project_id)
  const editable = canEdit && project?.kind === 'docker-compose' ? project : null
  const health = container.health
    ? (HEALTH_TEXT[container.health.toLowerCase()] ?? container.health)
    : '—'
  const ports = project?.ports?.length
    ? project.ports
      .map((port) => `${port.host ?? '?'} → ${port.container ?? '?'}${port.proto ? `/${port.proto}` : ''}`)
      .join('、')
    : null
  const vitals = [
    { label: '内存', value: memoryLabel(container.mem_used_mb), title: '当前内存占用' },
    {
      label: '内存上限',
      value: container.mem_limit_mb != null && container.mem_limit_mb > 0 ? `${container.mem_limit_mb} MB` : '未设置',
      title: '容器内存上限',
    },
    { label: '健康检查', value: health, title: container.health ?? '采集器未上报健康检查' },
    {
      label: '启动',
      value: container.started_at ? `${elapsedSince(container.started_at)}前` : '—',
      title: absoluteTime(container.started_at),
    },
    { label: '退出码', value: detailValue(container.exit_code), title: '最近一次退出的退出码' },
    {
      label: '端口',
      value: ports ?? '未采集',
      title: ports ? '项目登记的端口映射' : '采集器暂未上报端口映射',
    },
  ]

  return (
    <Card padded={false} className="flex min-h-0 flex-col overflow-hidden">
      <div className={cn('h-[2px] w-full shrink-0', isIssue ? TONE[bucket].bar : 'bg-transparent')} />

      <header className="shrink-0">
        <div className="px-4 pt-3">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span className={cn('size-1.5 shrink-0 rounded-full', TONE[bucket].dot)} />
                <span className={cn('text-[11px] font-medium', isIssue ? TONE[bucket].text : 'text-ink-secondary')}>
                  {LABEL[bucket]}
                </span>
                <span className="text-[10.5px] text-ink-tertiary" title={absoluteTime(container.updated_at)}>
                  · 更新 {shortTime(container.updated_at)}
                </span>
              </div>
              <h2 className="mono mt-1 truncate text-[18px] font-semibold tracking-tight text-ink" title={container.name}>
                {container.name}
              </h2>
            </div>

            {editable ? (
              <button
                type="button"
                onClick={() => onEdit(editable, container.id)}
                className="mt-0.5 flex h-7 shrink-0 cursor-pointer items-center gap-1.5 rounded-md border border-line bg-primary px-2 text-[10.5px] font-medium text-ink-secondary transition-colors hover:bg-accent-soft hover:text-ink"
              >
                <Pencil className="size-3" />
                {editable.work_dir ? '编辑配置' : '项目详情'}
              </button>
            ) : null}
          </div>

          <p className="mt-1 truncate text-[11px] text-ink-tertiary" title={`${container.server_name ?? '未知服务器'} · ${container.project_name ?? '未归属项目'} · ${container.image ?? '未知镜像'}`}>
            {container.server_name ?? '未知服务器'} · {container.project_name ?? '未归属项目'} · {container.image ?? '未知镜像'}
          </p>
        </div>

        <dl className="mt-3 grid grid-cols-2 gap-px border-t border-line bg-line sm:grid-cols-3 xl:grid-cols-6">
          {vitals.map((item) => (
            <div key={item.label} className="min-w-0 bg-primary px-3.5 py-2" title={item.title}>
              <dt className="text-[10px] text-ink-tertiary">{item.label}</dt>
              <dd className="mt-0.5 truncate text-[12.5px] tabular-nums text-ink-secondary">{item.value}</dd>
            </div>
          ))}
        </dl>

        {canOperate && project ? <ProjectActions project={project} catalog={catalog} /> : null}
      </header>

      {canReadLogs ? <ContainerLogPanel key={container.id} container={container} /> : (
        <div className="flex flex-1 items-center justify-center px-5 py-10 text-center text-[12px] text-ink-tertiary">
          仅管理员可以查看容器日志。
        </div>
      )}
    </Card>
  )
}

function ActionButton({ children, onClick, disabled, danger = false, title }: {
  children: ReactNode
  onClick: () => void
  disabled?: boolean
  danger?: boolean
  title?: string
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={cn(
        'flex h-7 cursor-pointer items-center gap-1 rounded-md border px-2 text-[10.5px] transition-colors disabled:cursor-not-allowed disabled:opacity-50',
        danger
          ? 'border-line-danger/60 text-ink-danger hover:bg-tint-danger'
          : 'border-line text-ink-secondary hover:bg-overlay-light hover:text-ink',
      )}
    >
      {children}
    </button>
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
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5 border-t border-line px-4 py-2">
      <span className="min-w-0 truncate text-[10.5px] text-ink-tertiary">
        项目级操作 · <span className="text-ink-secondary">{project.name}</span>
      </span>

      <div className="ms-auto flex flex-wrap items-center gap-1">
        {result ? (
          <span className={cn('me-1 max-w-56 truncate text-[10.5px]', result.ok ? 'text-ink-success' : 'text-ink-danger')} title={result.text}>
            {result.text}
          </span>
        ) : null}

        <ActionButton onClick={() => setShowLogs(true)} title="查看项目内全部服务的日志">
          <ScrollText className="size-3" />
          项目日志
        </ActionButton>

        {available.map((action) => (
          <ActionButton
            key={action.key}
            disabled={running !== null}
            danger={action.danger === 'medium'}
            title={`${action.description}（作用于项目全部容器）`}
            onClick={() => void run(action)}
          >
            {action.key === 'restart' ? <RotateCcw className="size-3" /> : action.key === 'stop' ? <Square className="size-3" /> : <Play className="size-3" />}
            {running === action.key ? '执行中…' : action.label}
          </ActionButton>
        ))}
      </div>

      {showLogs ? <ProjectLogDialog project={project} onClose={() => setShowLogs(false)} /> : null}
    </div>
  )
}
