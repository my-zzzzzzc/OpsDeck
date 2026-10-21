import { Boxes, FileCode2, FileText, History, Layers3, Save, Server as ServerIcon, Settings2, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

import { api, DANGER_LABEL, type ActionCatalogItem, type ActionLogItem, type InstanceDetail, type Project, type ProjectConfig, type User } from '../api'
import { cn } from '../cn'
import { Badge } from '../ui'
import { ProjectLogDialog } from './ProjectLogDialog'

type Tab = 'overview' | 'services' | 'logs' | 'config' | 'history'

const TABS: Array<{ id: Tab; label: string; icon: typeof Layers3 }> = [
  { id: 'overview', label: '概览', icon: Layers3 },
  { id: 'services', label: '容器', icon: Boxes },
  { id: 'logs', label: '日志', icon: FileText },
  { id: 'config', label: '配置', icon: Settings2 },
  { id: 'history', label: '操作记录', icon: History },
]

/** 项目层工作区：配置和操作的作用域是 Compose 项目，不是单个容器。 */
export function ProjectWorkspaceDialog({ project, user, catalog, onClose, initialTab = 'overview', focusInstanceId }: {
  project: Project
  user: User
  catalog: ActionCatalogItem[]
  onClose: () => void
  initialTab?: Tab
  /** 从某个容器进入时高亮并滚动到该容器。 */
  focusInstanceId?: number
}) {
  const [tab, setTab] = useState<Tab>(initialTab)
  const [instances, setInstances] = useState<InstanceDetail[]>([])
  const [history, setHistory] = useState<ActionLogItem[]>([])
  const [config, setConfig] = useState<ProjectConfig | null>(null)
  const [configError, setConfigError] = useState<string | null>(null)
  const [compose, setCompose] = useState('')
  const [env, setEnv] = useState('')
  const [saving, setSaving] = useState(false)
  const [showLogs, setShowLogs] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const canManage = user.role === 'admin'

  const reloadHistory = () => api.actionLogs(30, project.id).then(setHistory).catch(() => undefined)
  useEffect(() => { void api.instancesDetail().then((list) => setInstances(list.filter((item) => item.project_id === project.id))).catch(() => undefined); void reloadHistory() }, [project.id])
  useEffect(() => {
    if (tab !== 'config' || !canManage || config) return
    api.projectConfig(project.id).then((value) => {
      setConfig(value); setCompose(value.compose_content ?? ''); setEnv(value.env_content ?? '')
    }).catch((err: Error) => setConfigError(err.message))
  }, [tab, canManage, config, project.id])
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const saveConfig = async () => {
    setSaving(true); setConfigError(null)
    try {
      const next = await api.updateProjectConfig(project.id, { compose_content: compose, env_content: env })
      setConfig(next); setMessage('配置已保存。需重新部署后才会应用到服务。')
    } catch (err) { setConfigError((err as Error).message) } finally { setSaving(false) }
  }

  const run = async (action: ActionCatalogItem) => {
    if (action.confirm_required && !confirm(`确认执行「${action.label}」？\n\n${DANGER_LABEL[action.danger]}：${action.description}`)) return
    try { await api.executeAction({ project_id: project.id, action: action.key, confirm: action.confirm_required }); setMessage(`${action.label} 已提交`); void reloadHistory() } catch (err) { setMessage((err as Error).message) }
  }

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/60 p-3" role="presentation" onClick={onClose}>
      <div role="dialog" aria-modal="true" aria-label={`${project.name} 项目详情`} onClick={(event) => event.stopPropagation()} className="flex h-[min(86vh,760px)] w-[min(96vw,1120px)] overflow-hidden rounded-lg border border-line bg-primary shadow-2xl">
        <aside className="flex w-36 shrink-0 flex-col border-e border-line bg-secondary/30 p-2 sm:w-44">
          <div className="px-2 py-2"><p className="truncate text-[13px] font-semibold text-ink">{project.name}</p><p className="mt-0.5 truncate text-[10px] text-ink-tertiary">{project.kind}</p></div>
          <nav className="mt-2 space-y-0.5">{TABS.map(({ id, label, icon: Icon }) => <button key={id} type="button" onClick={() => setTab(id)} className={cn('flex h-8 w-full cursor-pointer items-center gap-2 rounded-md px-2 text-left text-[11px]', tab === id ? 'bg-overlay-light font-medium text-ink' : 'text-ink-tertiary hover:bg-overlay-lighter hover:text-ink-secondary')}><Icon className="size-3.5" />{label}</button>)}</nav>
        </aside>
        <div className="flex min-w-0 flex-1 flex-col">
          <header className="flex h-12 shrink-0 items-center gap-3 border-b border-line px-4"><span className="min-w-0 flex-1 truncate text-[13px] font-semibold text-ink">{TABS.find((item) => item.id === tab)?.label}</span><Badge tone="neutral">{project.kind}</Badge><button type="button" onClick={onClose} title="关闭" className="flex size-7 cursor-pointer items-center justify-center rounded-md text-ink-tertiary hover:bg-overlay-light hover:text-ink"><X className="size-4" /></button></header>
          <main className="min-h-0 flex-1 overflow-auto p-4">
            {message ? <p className="mb-3 rounded-md bg-tint-success px-3 py-2 text-[11px] text-ink-success">{message}</p> : null}
            {tab === 'overview' ? <Overview project={project} instances={instances} /> : null}
            {tab === 'services' ? <Services project={project} instances={instances} focusId={focusInstanceId} /> : null}
            {tab === 'logs' ? <div className="flex h-full flex-col items-center justify-center text-center"><FileText className="mb-3 size-7 text-ink-tertiary" /><p className="text-[13px] text-ink-secondary">查看项目内全部服务的最近日志</p><button type="button" onClick={() => setShowLogs(true)} className="mt-3 h-8 cursor-pointer rounded-md border border-line px-3 text-[11px] text-ink-secondary hover:bg-overlay-light">打开日志浮窗</button></div> : null}
            {tab === 'config' ? <Config project={project} canManage={canManage} config={config} error={configError} compose={compose} env={env} saving={saving} onCompose={setCompose} onEnv={setEnv} onSave={() => void saveConfig()} /> : null}
            {tab === 'history' ? <HistoryList history={history} /> : null}
          </main>
          <footer className="flex shrink-0 flex-wrap items-center gap-1.5 border-t border-line px-4 py-2"><span className="me-1 text-[10px] text-ink-tertiary">项目级操作</span><button type="button" onClick={() => setShowLogs(true)} className="h-7 cursor-pointer rounded-md border border-line px-2 text-[10.5px] text-ink-secondary hover:bg-overlay-light">查看日志</button>{user.role !== 'viewer' ? catalog.filter((action) => action.enabled && !action.read_only).map((action) => <button key={action.key} type="button" onClick={() => void run(action)} className={cn('h-7 cursor-pointer rounded-md border px-2 text-[10.5px]', action.danger === 'medium' ? 'border-line-danger/60 text-ink-danger hover:bg-tint-danger' : 'border-line text-ink-secondary hover:bg-overlay-light')}>{action.label}</button>) : null}</footer>
        </div>
      </div>
      {showLogs ? <ProjectLogDialog project={project} onClose={() => setShowLogs(false)} /> : null}
    </div>
  )
}

function Overview({ project, instances }: { project: Project; instances: InstanceDetail[] }) {
  const ports = project.ports?.length
    ? project.ports
      .map((port) => `${port.host ?? '?'} → ${port.container ?? '?'}${port.proto ? `/${port.proto}` : ''}`)
      .join('、')
    : '—'
  return (
    <div className="grid gap-3 md:grid-cols-2">
      <Info label="工作目录" value={project.work_dir ?? '—'} mono />
      <Info label="Compose 文件" value={project.compose_file ?? '—'} mono />
      <Info label="容器数量" value={`${instances.length} 个`} />
      <Info label="端口映射" value={ports} mono />
      <Info label="访问地址" value={project.url ?? '—'} />
      <Info label="重启命令" value={project.restart_cmd ?? '—'} mono />
      <Info label="说明" value={project.note ?? '—'} />
    </div>
  )
}
function Info({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) { return <div className="rounded-md bg-sunken px-3 py-2.5"><dt className="text-[10px] text-ink-tertiary">{label}</dt><dd className={cn('mt-1 break-all text-[11.5px] text-ink-secondary', mono && 'mono')}>{value}</dd></div> }
const STATE_LABEL: Record<string, string> = {
  running: '运行中',
  exited: '已停止',
  created: '已创建',
  restarting: '重启中',
  paused: '已暂停',
  dead: '已退出',
}

const HEALTH_LABEL: Record<string, string> = {
  healthy: '健康',
  unhealthy: '不健康',
  starting: '检查中',
  running: '无检查',
  none: '无检查',
}

function formatMoment(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime())
    ? '—'
    : date.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
}

function Services({ project, instances, focusId }: { project: Project; instances: InstanceDetail[]; focusId?: number }) {
  const focusRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    focusRef.current?.scrollIntoView({ block: 'nearest' })
  }, [focusId, instances.length])

  if (!instances.length) {
    return <p className="py-12 text-center text-[12px] text-ink-tertiary">尚未采集到该项目的容器。</p>
  }

  const running = instances.filter((item) => (item.state ?? '').toLowerCase() === 'running').length

  return (
    <div>
      <div className="mb-2 flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-[10.5px] text-ink-tertiary">
        <span>{instances.length} 个容器 · {running} 个运行中</span>
        <span className="flex min-w-0 items-center gap-1">
          <ServerIcon className="size-3 shrink-0" />
          <span className="truncate" title={project.server_name ?? undefined}>{project.server_name ?? '未知服务器'}</span>
        </span>
      </div>

      <div className="divide-y divide-line overflow-hidden rounded-md border border-line">
        {instances.map((item) => {
          const state = (item.state ?? '').toLowerCase()
          const health = (item.health ?? '').toLowerCase()
          const isRunning = state === 'running'
          const isUnhealthy = isRunning && health === 'unhealthy'
          const tone = isUnhealthy ? 'text-ink-warning' : isRunning ? 'text-ink-success' : 'text-ink-danger'
          const dot = isUnhealthy ? 'bg-status-warn' : isRunning ? 'bg-status-ok' : 'bg-status-bad'
          const stateText = isUnhealthy ? '不健康' : (STATE_LABEL[state] ?? item.state ?? '—')
          const memLimit = item.mem_limit_mb != null && item.mem_limit_mb > 0 ? `${item.mem_limit_mb} MB` : '未设置'

          return (
            <div
              key={item.id}
              ref={item.id === focusId ? focusRef : undefined}
              className={cn(
                'border-s-2 border-s-transparent px-3 py-2.5 transition-colors',
                item.id === focusId && 'border-s-accent bg-accent-soft',
              )}
            >
              <div className="flex items-center gap-2">
                <span className={cn('size-1.5 shrink-0 rounded-full', dot)} />
                <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-ink" title={item.name}>{item.name}</span>
                <span className={cn('shrink-0 text-[10.5px] font-medium', tone)}>{stateText}</span>
              </div>
              <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-[10.5px] text-ink-tertiary">
                <span className="flex min-w-0 max-w-full items-center gap-1">
                  镜像
                  <span className="mono min-w-0 truncate text-ink-secondary" title={item.image ?? undefined}>{item.image ?? '—'}</span>
                </span>
                <span>
                  内存 <b className="font-medium tabular-nums text-ink-secondary">{item.mem_used_mb == null ? '—' : `${item.mem_used_mb} MB`}</b> / {memLimit}
                </span>
                <span>健康检查 <span className="text-ink-secondary">{HEALTH_LABEL[health] ?? item.health ?? '—'}</span></span>
                <span>启动 <span className="text-ink-secondary">{item.started_at ? formatMoment(item.started_at) : '—'}</span></span>
                {item.exit_code != null ? <span>退出码 <span className="tabular-nums text-ink-secondary">{item.exit_code}</span></span> : null}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
function Config({ project, canManage, config, error, compose, env, saving, onCompose, onEnv, onSave }: { project: Project; canManage: boolean; config: ProjectConfig | null; error: string | null; compose: string; env: string; saving: boolean; onCompose: (value: string) => void; onEnv: (value: string) => void; onSave: () => void }) { if (!canManage) return <p className="py-12 text-center text-[12px] text-ink-tertiary">仅管理员可以读取或编辑配置文件。</p>; if (project.kind !== 'docker-compose') return <p className="py-12 text-center text-[12px] text-ink-tertiary">{project.kind} 项目没有 Compose YAML；请在概览中维护其运行信息。</p>; if (error) return <p className="rounded-md bg-tint-danger px-3 py-2 text-[12px] text-ink-danger">{error}</p>; if (!config) return <p className="py-12 text-center text-[12px] text-ink-tertiary">正在读取远端配置…</p>; return <div className="space-y-4"><div><div className="mb-1.5 flex items-center justify-between"><label className="flex items-center gap-1.5 text-[11px] font-medium text-ink"><FileCode2 className="size-3.5" />{config.compose_file ?? 'Compose 文件'}</label><span className="text-[10px] text-ink-tertiary">保存后需重新部署</span></div><textarea value={compose} onChange={(event) => onCompose(event.target.value)} spellCheck={false} className="mono h-72 w-full resize-y rounded-md border border-line bg-sunken p-3 text-[11px] leading-5 text-ink outline-none focus:border-accent" /></div><div><label className="mb-1.5 block text-[11px] font-medium text-ink">.env 环境变量</label><textarea value={env} onChange={(event) => onEnv(event.target.value)} spellCheck={false} className="mono h-40 w-full resize-y rounded-md border border-line bg-sunken p-3 text-[11px] leading-5 text-ink outline-none focus:border-accent" /></div><button type="button" disabled={saving} onClick={onSave} className="flex h-8 cursor-pointer items-center gap-1.5 rounded-md bg-accent px-3 text-[11px] font-medium text-on-accent disabled:opacity-50"><Save className="size-3.5" />{saving ? '保存中…' : '保存配置'}</button></div> }
function HistoryList({ history }: { history: ActionLogItem[] }) { return history.length ? <div className="divide-y divide-line rounded-md border border-line">{history.map((log) => <div key={log.id} className="px-3 py-2.5"><div className="flex gap-2"><span className="min-w-0 flex-1 text-[11.5px] text-ink">{log.action}</span><span className="text-[10px] text-ink-tertiary">{log.status} · {new Date(log.created_at).toLocaleString('zh-CN')}</span></div>{log.output ? <p className="mono mt-1 line-clamp-2 text-[10px] text-ink-tertiary">{log.output}</p> : null}</div>)}</div> : <p className="py-12 text-center text-[12px] text-ink-tertiary">暂无项目操作记录。</p> }
