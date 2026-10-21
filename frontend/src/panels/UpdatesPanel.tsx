import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  DownloadCloud,
  ExternalLink,
  GitBranch,
  Loader2,
  Package,
  RefreshCw,
  Search,
  Settings2,
  Tag,
  X,
  XCircle,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'

import {
  api,
  type ActionLogItem,
  type UpdateApplyResult,
  type UpdateProject,
  type UpdateSource,
  type UpdateStatus,
  type UpdateSuggestion,
  type User,
} from '../api'
import { cn } from '../cn'
import { useHeaderMeta } from '../header-meta'
import { PageSkeleton } from '../motion'
import { Badge, Card, Empty, GhostButton, PrimaryButton, SectionTitle, Stat, StatStrip } from '../ui'

/*
 * 「版本更新」页。
 *
 * 它与「项目」页的分工:
 *   项目 —— 项目是什么、在哪、怎么起停。
 *   版本更新 —— 这个项目的上游有没有变,以及在不改变部署方式的前提下推进版本。
 *
 * 更新按**项目**聚合,不按容器。Dify 的 postgres / redis / nginx 是内部依赖,
 * 它们各自"可更新"没有意义 —— 真正要升级的是 Dify 这一整套版本。
 */

type RowStatus = UpdateStatus | 'unconfigured'

const STATUS_META: Record<RowStatus, { label: string; tone: 'ok' | 'warn' | 'bad' | 'neutral' }> = {
  update_available: { label: '可更新', tone: 'warn' },
  up_to_date: { label: '已是最新', tone: 'ok' },
  check_failed: { label: '检查失败', tone: 'bad' },
  unknown: { label: '待检查', tone: 'neutral' },
  manual: { label: '不检测', tone: 'neutral' },
  unconfigured: { label: '未配置', tone: 'neutral' },
}

const SOURCE_LABEL: Record<UpdateSource, string> = {
  git: 'Git 提交',
  release: 'GitHub Release',
  registry: '镜像 Digest',
  manual: '手动',
}

const SOURCE_HINT: Record<UpdateSource, string> = {
  git: '适合从源码构建的项目:对比远端分支的最新提交。',
  release: '适合官方镜像 / 按版本发版的项目:对比 GitHub Release 版本号。',
  registry: '适合固定镜像标签的项目:对比同一标签的远端 digest。',
  manual: '只记录人工维护的版本,不做自动检测。',
}

function statusOf(project: UpdateProject): RowStatus {
  if (!project.config?.confirmed) return 'unconfigured'
  return project.config.status
}

function fmtVersion(value: string | null, source?: UpdateSource): string {
  if (!value) return '—'
  if (source === 'git' && /^[0-9a-f]{7,40}$/i.test(value)) return value.slice(0, 7)
  if (value.startsWith('sha256:')) return `${value.slice(0, 19)}…`
  return value
}

function fmtTime(value: string | null): string {
  if (!value) return '尚未检查'
  return new Date(value).toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function SourceBadge({ source }: { source: UpdateSource }) {
  const Icon = source === 'git' ? GitBranch : source === 'release' ? Tag : source === 'registry' ? Package : Settings2
  return (
    <Badge tone="neutral">
      <span className="flex items-center gap-1">
        <Icon size={10} />
        {SOURCE_LABEL[source]}
      </span>
    </Badge>
  )
}

export function UpdatesPanel({ user }: { user: User }) {
  const [projects, setProjects] = useState<UpdateProject[]>([])
  const [history, setHistory] = useState<ActionLogItem[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null)

  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<'all' | 'update' | 'unconfigured' | 'failed'>('all')
  const [checking, setChecking] = useState<Set<string>>(new Set())
  const [checkingAll, setCheckingAll] = useState(false)

  const [configId, setConfigId] = useState<string | null>(null)
  const [detailId, setDetailId] = useState<string | null>(null)

  const canOperate = user.role === 'admin' || user.role === 'operator'
  const canManage = user.role === 'admin'

  const load = useCallback(async () => {
    try {
      const [rows, logs] = await Promise.all([api.updates(), api.updateHistory(20)])
      setProjects(rows)
      setHistory(logs)
      setError(null)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const counts = useMemo(() => {
    const out = { available: 0, current: 0, unconfigured: 0, failed: 0 }
    for (const project of projects) {
      const status = statusOf(project)
      if (status === 'update_available') out.available += 1
      else if (status === 'up_to_date') out.current += 1
      else if (status === 'check_failed') out.failed += 1
      else if (status === 'unconfigured') out.unconfigured += 1
    }
    return out
  }, [projects])

  useHeaderMeta(
    projects.length > 0
      ? `${projects.length} 个项目${counts.available > 0 ? ` · ${counts.available} 个可更新` : ''}`
      : null,
  )

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase()
    return projects.filter((project) => {
      const status = statusOf(project)
      if (filter === 'update' && status !== 'update_available') return false
      if (filter === 'unconfigured' && status !== 'unconfigured') return false
      if (filter === 'failed' && status !== 'check_failed') return false
      if (!q) return true
      return [project.project_name, project.server_name, project.work_dir, ...project.images]
        .filter((value): value is string => !!value)
        .some((value) => value.toLowerCase().includes(q))
    })
  }, [projects, filter, query])

  const checkById = useCallback(
    async (projectId: string) => {
      setChecking((prev) => new Set(prev).add(projectId))
      try {
        await api.checkUpdate(projectId)
        await load()
      } catch (err) {
        setMsg({ text: `检查失败:${(err as Error).message}`, ok: false })
      } finally {
        setChecking((prev) => {
          const next = new Set(prev)
          next.delete(projectId)
          return next
        })
      }
    },
    [load],
  )

  const checkAll = async () => {
    const targets = projects.filter(
      (project) => project.config?.confirmed && project.config.source_type !== 'manual',
    )
    if (targets.length === 0) {
      setMsg({ text: '没有可检查的项目。请先配置更新来源。', ok: false })
      return
    }

    setCheckingAll(true)
    setChecking(new Set(targets.map((project) => project.project_id)))
    setMsg(null)
    try {
      const results = await Promise.allSettled(
        targets.map((project) => api.checkUpdate(project.project_id)),
      )
      const failed = results.filter((result) => result.status === 'rejected').length
      await load()
      setMsg({
        text: `已检查 ${targets.length} 个项目${failed > 0 ? `,${failed} 个请求失败` : ''}`,
        ok: failed === 0,
      })
    } finally {
      setChecking(new Set())
      setCheckingAll(false)
    }
  }

  const configProject = projects.find((project) => project.project_id === configId) ?? null
  const detailProject = projects.find((project) => project.project_id === detailId) ?? null

  if (loading) return <PageSkeleton />
  if (error && projects.length === 0) {
    return <p className="py-16 text-center text-ink-danger">加载失败:{error}</p>
  }

  const filters: Array<{ key: typeof filter; label: string; n: number }> = [
    { key: 'all', label: '全部', n: projects.length },
    { key: 'update', label: '可更新', n: counts.available },
    { key: 'unconfigured', label: '未配置', n: counts.unconfigured },
    { key: 'failed', label: '检查失败', n: counts.failed },
  ]

  return (
    <>
      <StatStrip cols={4} className="mb-3">
        <Stat
          label="可更新"
          value={counts.available}
          tone={counts.available > 0 ? 'warn' : 'neutral'}
          hint="检测到新提交 / 版本 / digest"
        />
        <Stat label="已是最新" value={counts.current} tone="ok" hint="最近一次检查通过" />
        <Stat label="未配置" value={counts.unconfigured} hint="还没有确认更新来源" />
        <Stat
          label="检查失败"
          value={counts.failed}
          tone={counts.failed > 0 ? 'bad' : 'neutral'}
          hint="SSH / 网络 / 认证问题"
        />
      </StatStrip>

      <p className="mb-3 text-[11.5px] text-ink-tertiary">
        更新以项目为单位。Dify 的 postgres / redis / nginx 属于内部依赖,不会单独出现。
        Release 来源只提示版本,不会自动修改镜像 tag —— 数据库迁移必须人工按发布说明执行。
      </p>

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="relative min-w-0 flex-1 sm:max-w-[250px]">
          <Search className="pointer-events-none absolute start-2.5 top-1/2 size-3.5 -translate-y-1/2 text-ink-tertiary" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索项目 / 服务器 / 镜像"
            aria-label="搜索更新项目"
            className="h-8 w-full rounded-md border border-line bg-primary ps-8 pe-7 text-[12.5px] text-ink outline-none transition-colors placeholder:text-ink-tertiary focus:border-accent"
          />
          {query ? (
            <button
              type="button"
              onClick={() => setQuery('')}
              aria-label="清空搜索"
              className="absolute end-2 top-1/2 -translate-y-1/2 cursor-pointer text-ink-tertiary hover:text-ink"
            >
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
                className={cn(
                  'flex h-8 cursor-pointer items-center gap-1.5 rounded-md border px-2.5 text-[11.5px] transition-colors',
                  active
                    ? 'border-line-strong bg-overlay-light font-medium text-ink'
                    : 'border-line bg-primary text-ink-secondary hover:bg-overlay-lighter',
                )}
              >
                {item.label}
                <span className={cn('tnum text-[10.5px]', active ? 'text-ink' : 'text-ink-tertiary')}>
                  {item.n}
                </span>
              </button>
            )
          })}
        </div>

        <div className="ms-auto flex items-center gap-1.5">
          <button
            type="button"
            onClick={() => void load()}
            aria-label="刷新列表"
            title="刷新列表"
            className="flex size-8 cursor-pointer items-center justify-center rounded-md border border-line bg-primary text-ink-tertiary transition-colors hover:bg-overlay-light hover:text-ink"
          >
            <RefreshCw className="size-3.5" />
          </button>
          {canOperate ? (
            <GhostButton onClick={() => void checkAll()} disabled={checkingAll}>
              <span className="flex items-center gap-1.5">
                {checkingAll ? <Loader2 className="size-3 animate-spin" /> : <DownloadCloud className="size-3" />}
                {checkingAll ? '检查中…' : '全部检查'}
              </span>
            </GhostButton>
          ) : null}
        </div>
      </div>

      {msg ? (
        <p className={cn('mb-3 text-[12.5px]', msg.ok ? 'text-ink-success' : 'text-ink-danger')}>{msg.text}</p>
      ) : null}

      <section className="mb-5">
        {projects.length === 0 ? (
          <Card>
            <Empty>还没有项目。先在「项目」页登记,再回来配置更新来源。</Empty>
          </Card>
        ) : rows.length === 0 ? (
          <Card className="py-10 text-center">
            <p className="text-[13px] text-ink-secondary">没有匹配的项目</p>
            <button
              type="button"
              onClick={() => {
                setQuery('')
                setFilter('all')
              }}
              className="mt-2 cursor-pointer text-[11.5px] text-accent hover:underline"
            >
              清除筛选条件
            </button>
          </Card>
        ) : (
          <div className="flex flex-col gap-2.5">
            {rows.map((project) => {
              const status = statusOf(project)
              const meta = STATUS_META[status]
              const source = project.config?.source_type ?? 'manual'
              const busy = checking.has(project.project_id)
              const checked = project.config?.last_checked_at ?? null

              return (
                <Card key={project.project_id}>
                  <div className="flex flex-wrap items-start gap-x-4 gap-y-2">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <strong className="text-[14px] text-ink">{project.project_name}</strong>
                        <Badge tone={meta.tone}>{meta.label}</Badge>
                        {project.config?.confirmed ? <SourceBadge source={source} /> : null}
                        <span className="text-[11.5px] text-ink-tertiary">
                          {project.server_name ?? '未知服务器'}
                        </span>
                        {project.work_dir ? (
                          <span className="mono hidden truncate text-[10.5px] text-ink-tertiary sm:inline">
                            {project.work_dir}
                          </span>
                        ) : null}
                      </div>

                      {project.config?.confirmed ? (
                        <>
                          <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px]">
                            <span className="text-ink-tertiary">当前</span>
                            <span className="mono text-ink">
                              {fmtVersion(project.config.current_version, source)}
                            </span>
                            {project.config.latest_version ? (
                              <>
                                <ArrowRight className="size-3 text-ink-tertiary" />
                                <span
                                  className={cn(
                                    'mono',
                                    status === 'update_available' ? 'text-ink-warning' : 'text-ink-secondary',
                                  )}
                                >
                                  {fmtVersion(project.config.latest_version, source)}
                                </span>
                              </>
                            ) : null}
                            <span className="ms-1 text-[10.5px] text-ink-tertiary">
                              {checked ? `检查于 ${fmtTime(checked)}` : '尚未检查'}
                            </span>
                          </div>
                          {project.config.detail ? (
                            <p
                              className={cn(
                                'mt-1 text-[11.5px]',
                                status === 'check_failed'
                                  ? 'text-ink-danger'
                                  : status === 'update_available'
                                    ? 'text-ink-secondary'
                                    : 'text-ink-tertiary',
                              )}
                            >
                              {project.config.detail}
                            </p>
                          ) : null}
                        </>
                      ) : (
                        <p className="mt-2 text-[11.5px] text-ink-tertiary">
                          {project.images.length > 0
                            ? `已采集镜像:${project.images.slice(0, 2).join('、')}${project.images.length > 2 ? ' 等' : ''}。配置来源后才能判断是否有新版本。`
                            : '配置更新来源后才能判断是否有新版本。'}
                        </p>
                      )}
                    </div>

                    <div className="flex flex-wrap items-center gap-1.5">
                      {canOperate && project.config?.confirmed && source !== 'manual' ? (
                        <GhostButton onClick={() => void checkById(project.project_id)} disabled={busy}>
                          <span className="flex items-center gap-1.5">
                            {busy ? <Loader2 className="size-3 animate-spin" /> : null}
                            {busy ? '检查中' : '检查'}
                          </span>
                        </GhostButton>
                      ) : null}

                      {canManage ? (
                        <GhostButton onClick={() => setConfigId(project.project_id)}>
                          <span className="flex items-center gap-1.5">
                            <Settings2 className="size-3" />
                            {project.config ? '配置' : '配置来源'}
                          </span>
                        </GhostButton>
                      ) : null}

                      {project.config?.confirmed ? (
                        status === 'update_available' ? (
                          <PrimaryButton onClick={() => setDetailId(project.project_id)}>
                            <span className="flex items-center gap-1.5">
                              <DownloadCloud className="size-3" />
                              查看更新
                            </span>
                          </PrimaryButton>
                        ) : (
                          <GhostButton onClick={() => setDetailId(project.project_id)}>详情</GhostButton>
                        )
                      ) : null}
                    </div>
                  </div>
                </Card>
              )
            })}
          </div>
        )}
      </section>

      <section>
        <SectionTitle>更新记录</SectionTitle>
        <Card className="p-0">
          {history.length === 0 ? (
            <div className="p-5">
              <Empty>还没有执行过更新。检测记录不写入这里,只有实际升级动作才留痕。</Empty>
            </div>
          ) : (
            <ul>
              {history.map((log) => (
                <li key={log.id} className="border-b border-line px-4 py-3 last:border-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge
                      tone={
                        log.status === 'success'
                          ? 'ok'
                          : log.status === 'failed'
                            ? 'bad'
                            : log.status === 'rejected'
                              ? 'warn'
                              : 'neutral'
                      }
                    >
                      {log.status === 'success' ? '成功' : log.status === 'failed' ? '失败' : log.status}
                    </Badge>
                    <span className="text-[12.5px] font-medium text-ink">{log.project_name ?? '未知项目'}</span>
                    <span className="text-[11px] text-ink-tertiary">更新</span>
                    <span className="ms-auto text-[11px] text-ink-tertiary">
                      {log.username ?? '—'} · {new Date(log.created_at).toLocaleString('zh-CN')}
                    </span>
                  </div>
                  {log.command ? (
                    <div className="mono mt-1 truncate text-[11px] text-ink-tertiary" title={log.command}>
                      {log.command}
                    </div>
                  ) : null}
                  {log.output ? (
                    <details className="mt-1.5">
                      <summary className="cursor-pointer text-[11px] text-accent">查看输出</summary>
                      <pre className="mono mt-1.5 max-h-40 overflow-auto rounded-md bg-secondary p-2.5 text-[11px] whitespace-pre-wrap">
                        {log.output}
                      </pre>
                    </details>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </Card>
      </section>

      {configProject ? (
        <UpdateConfigDialog
          key={configProject.project_id}
          project={configProject}
          canSave={canManage}
          onClose={() => setConfigId(null)}
          onSaved={async (projectId) => {
            setConfigId(null)
            await load()
            await checkById(projectId)
          }}
        />
      ) : null}

      {detailProject ? (
        <UpdateDetailDialog
          key={detailProject.project_id}
          project={detailProject}
          canOperate={canOperate}
          onClose={() => setDetailId(null)}
          onUpdated={() => void load()}
        />
      ) : null}
    </>
  )
}

/* ---------------------------------------------------------------- 配置对话框 */

function UpdateConfigDialog({
  project,
  canSave,
  onClose,
  onSaved,
}: {
  project: UpdateProject
  canSave: boolean
  onClose: () => void
  onSaved: (projectId: string) => Promise<void>
}) {
  const config = project.config
  const [source, setSource] = useState<UpdateSource>(config?.source_type ?? 'git')
  const [repoUrl, setRepoUrl] = useState(config?.repo_url ?? '')
  const [branch, setBranch] = useState(config?.branch ?? '')
  const [imageRef, setImageRef] = useState(config?.image_ref ?? '')
  const [upstreamRepo, setUpstreamRepo] = useState(config?.upstream_repo ?? '')
  const [currentVersion, setCurrentVersion] = useState(config?.current_version ?? '')

  const [detecting, setDetecting] = useState(!config)
  const [saving, setSaving] = useState(false)
  const [reason, setReason] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const applySuggestion = (suggestion: UpdateSuggestion) => {
    setSource(suggestion.source_type)
    setRepoUrl(suggestion.repo_url ?? '')
    setBranch(suggestion.branch ?? '')
    setImageRef(suggestion.image_ref ?? '')
    setUpstreamRepo(suggestion.upstream_repo ?? '')
    setCurrentVersion(suggestion.current_version ?? '')
    setReason(suggestion.reason)
  }

  const detect = async () => {
    setDetecting(true)
    setError(null)
    try {
      applySuggestion(await api.detectUpdate(project.project_id))
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setDetecting(false)
    }
  }

  useEffect(() => {
    if (!config) void detect()
    // 只在首次打开、且尚未配置时自动识别一次;已有配置不覆盖用户的选择。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const missingGitDir = source === 'git' && !project.work_dir
  const missingImage = source === 'registry' && !imageRef.trim()
  const missingRepo = source === 'release' && !upstreamRepo.trim()
  const invalid = missingGitDir || missingImage || missingRepo

  const save = async () => {
    if (!canSave || invalid) return
    setSaving(true)
    setError(null)
    try {
      await api.saveUpdateConfig(project.project_id, {
        source_type: source,
        repo_url: source === 'git' ? repoUrl.trim() || null : null,
        branch: source === 'git' ? branch.trim() || null : null,
        image_ref: source === 'registry' ? imageRef.trim() : null,
        upstream_repo: source === 'release' ? upstreamRepo.trim() : null,
        current_version: source === 'release' && currentVersion.trim() ? currentVersion.trim() : null,
      })
      await onSaved(project.project_id)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setSaving(false)
    }
  }

  const field =
    'h-8 w-full rounded-md border border-line bg-secondary px-2.5 text-[12.5px] text-ink outline-none transition-colors placeholder:text-ink-tertiary focus:border-accent'

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
        aria-label={`${project.project_name} 的更新来源`}
        className="flex max-h-[88vh] w-full max-w-[560px] flex-col overflow-hidden rounded-lg border border-line bg-primary shadow-xl"
      >
        <div className="flex items-center gap-2 border-b border-line px-4 py-3">
          <h2 className="text-[14px] font-semibold text-ink">更新来源</h2>
          <span className="truncate text-[11.5px] text-ink-tertiary">· {project.project_name}</span>
          <button
            type="button"
            onClick={onClose}
            aria-label="关闭"
            className="ms-auto cursor-pointer rounded-sm p-1 text-ink-tertiary transition-colors hover:bg-overlay-light hover:text-ink"
          >
            <X className="size-4" />
          </button>
        </div>

        <div className="flex flex-col gap-3.5 overflow-y-auto px-4 py-4">
          <div className="flex flex-wrap items-center gap-1.5">
            {(['git', 'release', 'registry', 'manual'] as UpdateSource[]).map((value) => {
              const active = source === value
              return (
                <button
                  key={value}
                  type="button"
                  onClick={() => setSource(value)}
                  className={cn(
                    'h-7 cursor-pointer rounded-md border px-2.5 text-[11.5px] transition-colors',
                    active
                      ? 'border-line-strong bg-overlay-light font-medium text-ink'
                      : 'border-line bg-primary text-ink-secondary hover:bg-overlay-lighter',
                  )}
                >
                  {SOURCE_LABEL[value]}
                </button>
              )
            })}
            <button
              type="button"
              onClick={() => void detect()}
              disabled={detecting}
              className="ms-auto flex h-7 cursor-pointer items-center gap-1.5 rounded-md border border-line px-2.5 text-[11.5px] text-ink-secondary transition-colors hover:bg-overlay-light disabled:cursor-wait disabled:opacity-60"
            >
              {detecting ? <Loader2 className="size-3 animate-spin" /> : <RefreshCw className="size-3" />}
              {detecting ? '识别中…' : '自动识别'}
            </button>
          </div>

          <p className="text-[11px] text-ink-tertiary">{SOURCE_HINT[source]}</p>

          {reason ? (
            <div className="rounded-md bg-sunken px-3 py-2 text-[11.5px] text-ink-secondary">
              <span className="text-ink-tertiary">识别结果:</span> {reason}
            </div>
          ) : null}

          {source === 'git' ? (
            <>
              {missingGitDir ? (
                <p className="rounded-md bg-tint-orange px-3 py-2 text-[11.5px] text-ink-warning">
                  该项目没有配置工作目录,无法使用 Git 来源。请先到「项目」页补充工作目录。
                </p>
              ) : null}
              <label className="flex flex-col gap-1">
                <span className="text-[11.5px] text-ink-tertiary">仓库地址</span>
                <input
                  value={repoUrl}
                  onChange={(event) => setRepoUrl(event.target.value)}
                  placeholder="https://github.com/owner/repo"
                  className={cn(field, 'mono')}
                  autoComplete="off"
                />
                <span className="text-[10.5px] text-ink-tertiary">
                  仅用于记录;检测与升级使用服务器工作目录中的 origin 与凭据。
                </span>
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-[11.5px] text-ink-tertiary">分支</span>
                <input
                  value={branch}
                  onChange={(event) => setBranch(event.target.value)}
                  placeholder="留空使用服务器当前分支"
                  className={cn(field, 'mono')}
                  autoComplete="off"
                />
              </label>
              <p className="rounded-md bg-sunken px-3 py-2 text-[11px] text-ink-tertiary">
                工作目录:<span className="mono text-ink-secondary">{project.work_dir ?? '—'}</span>
                <br />
                升级命令:git pull --ff-only → docker compose build → docker compose up -d
              </p>
            </>
          ) : null}

          {source === 'release' ? (
            <>
              <label className="flex flex-col gap-1">
                <span className="text-[11.5px] text-ink-tertiary">GitHub 仓库</span>
                <input
                  value={upstreamRepo}
                  onChange={(event) => setUpstreamRepo(event.target.value)}
                  placeholder="owner/repo"
                  className={cn(field, 'mono')}
                  autoComplete="off"
                />
                <span className="text-[10.5px] text-ink-tertiary">
                  例如 langgenius/dify。读取最新 Release 的 tag 与发布说明。
                </span>
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-[11.5px] text-ink-tertiary">当前版本(可选)</span>
                <input
                  value={currentVersion}
                  onChange={(event) => setCurrentVersion(event.target.value)}
                  placeholder="留空时从部署镜像的 tag 推断"
                  className={cn(field, 'mono')}
                  autoComplete="off"
                />
                {project.images.length > 0 ? (
                  <span className="truncate text-[10.5px] text-ink-tertiary" title={project.images.join('\n')}>
                    已采集镜像:{project.images.slice(0, 3).join('、')}
                    {project.images.length > 3 ? ' 等' : ''}
                  </span>
                ) : null}
              </label>
              <p className="rounded-md bg-sunken px-3 py-2 text-[11px] text-ink-tertiary">
                Release 来源只负责发现新版本。升级需要人工修改镜像 tag / .env,再执行 pull + up;
                涉及数据库迁移的项目请先备份并阅读官方升级说明。
              </p>
            </>
          ) : null}

          {source === 'registry' ? (
            <>
              <label className="flex flex-col gap-1">
                <span className="text-[11.5px] text-ink-tertiary">镜像引用</span>
                <input
                  value={imageRef}
                  onChange={(event) => setImageRef(event.target.value)}
                  placeholder="ghcr.io/owner/app:v1.2.3"
                  className={cn(field, 'mono')}
                  autoComplete="off"
                />
                <span className="text-[10.5px] text-ink-tertiary">
                  只能发现同一 tag 的 digest 变化。跨版本升级请使用 Release 来源,或手动修改 tag。
                </span>
              </label>
              {project.images.length > 0 ? (
                <div className="flex flex-col gap-1">
                  <span className="text-[10.5px] text-ink-tertiary">项目已采集的镜像</span>
                  <div className="flex flex-wrap gap-1">
                    {project.images.map((image) => (
                      <button
                        key={image}
                        type="button"
                        onClick={() => setImageRef(image)}
                        className={cn(
                          'mono cursor-pointer rounded-sm border px-1.5 py-0.5 text-[10.5px] transition-colors',
                          imageRef === image
                            ? 'border-accent text-accent'
                            : 'border-line text-ink-tertiary hover:text-ink',
                        )}
                      >
                        {image}
                      </button>
                    ))}
                  </div>
                </div>
              ) : null}
            </>
          ) : null}

          {source === 'manual' ? (
            <p className="rounded-md bg-sunken px-3 py-2 text-[11.5px] text-ink-tertiary">
              手动来源不检测、不自动升级,适合无法从机器读取版本的项目。页面上只保留配置与操作记录。
            </p>
          ) : null}

          {error ? (
            <p className="rounded-md bg-tint-danger px-3 py-2 text-[12px] text-ink-danger">{error}</p>
          ) : null}
        </div>

        <div className="flex items-center gap-2 border-t border-line px-4 py-3">
          <span className="text-[10.5px] text-ink-tertiary">
            保存后会立即检查一次;自动识别只是建议,以你的确认为准。
          </span>
          <div className="ms-auto flex items-center gap-2">
            <GhostButton onClick={onClose}>取消</GhostButton>
            <PrimaryButton onClick={() => void save()} disabled={!canSave || saving || invalid}>
              {saving ? '保存中…' : '保存并检查'}
            </PrimaryButton>
          </div>
        </div>
      </div>
    </div>
  )
}

/* ---------------------------------------------------------------- 更新详情 */

function UpdateDetailDialog({
  project,
  canOperate,
  onClose,
  onUpdated,
}: {
  project: UpdateProject
  canOperate: boolean
  onClose: () => void
  onUpdated: () => void
}) {
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<UpdateApplyResult | null>(null)
  const [error, setError] = useState<string | null>(null)

  const config = project.config
  const source = config?.source_type ?? 'manual'
  const status = statusOf(project)

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy) onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, busy])

  const apply = async () => {
    if (!canOperate || !config) return
    const action =
      source === 'git'
        ? 'git pull --ff-only、docker compose build、docker compose up -d'
        : 'docker compose pull、docker compose up -d'
    const ok = confirm(
      `确认更新「${project.project_name}」?\n\n` +
        `来源:${SOURCE_LABEL[source]}\n` +
        `将执行:${action}\n\n` +
        '容器会被重建,服务会短暂中断。数据库迁移类项目请先备份。',
    )
    if (!ok) return

    setBusy(true)
    setError(null)
    setResult(null)
    try {
      const applied = await api.applyUpdate(project.project_id)
      setResult(applied)
      onUpdated()
    } catch (err) {
      setError((err as Error).message)
      onUpdated()
    } finally {
      setBusy(false)
    }
  }

  const notes = typeof config?.extra?.notes === 'string' ? config.extra.notes : ''
  const publishedAt =
    typeof config?.extra?.published_at === 'string' ? config.extra.published_at : null

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={(event) => {
        if (event.target === event.currentTarget && !busy) onClose()
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`${project.project_name} 的更新详情`}
        className="flex max-h-[88vh] w-full max-w-[620px] flex-col overflow-hidden rounded-lg border border-line bg-primary shadow-xl"
      >
        <div className="flex items-center gap-2 border-b border-line px-4 py-3">
          <h2 className="text-[14px] font-semibold text-ink">{project.project_name}</h2>
          <Badge tone={STATUS_META[status].tone}>{STATUS_META[status].label}</Badge>
          <SourceBadge source={source} />
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            aria-label="关闭"
            className="ms-auto cursor-pointer rounded-sm p-1 text-ink-tertiary transition-colors hover:bg-overlay-light hover:text-ink disabled:cursor-not-allowed disabled:opacity-40"
          >
            <X className="size-4" />
          </button>
        </div>

        <div className="flex flex-col gap-3.5 overflow-y-auto px-4 py-4">
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <div className="rounded-md bg-sunken px-3 py-2">
              <div className="text-[10.5px] text-ink-tertiary">当前</div>
              <div className="mono mt-0.5 truncate text-[12px] text-ink" title={config?.current_version ?? ''}>
                {fmtVersion(config?.current_version ?? null, source)}
              </div>
            </div>
            <div className="rounded-md bg-sunken px-3 py-2">
              <div className="text-[10.5px] text-ink-tertiary">最新</div>
              <div className="mono mt-0.5 truncate text-[12px] text-ink" title={config?.latest_version ?? ''}>
                {fmtVersion(config?.latest_version ?? null, source)}
              </div>
            </div>
            <div className="rounded-md bg-sunken px-3 py-2">
              <div className="text-[10.5px] text-ink-tertiary">服务器</div>
              <div className="mt-0.5 truncate text-[12px] text-ink">{project.server_name ?? '—'}</div>
            </div>
            <div className="rounded-md bg-sunken px-3 py-2">
              <div className="text-[10.5px] text-ink-tertiary">检查时间</div>
              <div className="mt-0.5 truncate text-[12px] text-ink">{fmtTime(config?.last_checked_at ?? null)}</div>
            </div>
          </div>

          {config?.detail ? (
            <p
              className={cn(
                'text-[12.5px]',
                status === 'check_failed' ? 'text-ink-danger' : 'text-ink-secondary',
              )}
            >
              {config.detail}
            </p>
          ) : null}

          {source === 'release' && config?.release_url ? (
            <a
              href={config.release_url}
              target="_blank"
              rel="noreferrer"
              className="flex w-fit items-center gap-1.5 text-[12px] text-accent hover:underline"
            >
              <ExternalLink className="size-3" />
              查看发布页
              {publishedAt ? (
                <span className="text-ink-tertiary">· {new Date(publishedAt).toLocaleDateString('zh-CN')}</span>
              ) : null}
            </a>
          ) : null}

          {notes ? (
            <div>
              <div className="mb-1 text-[10.5px] font-medium text-ink-tertiary">
                Release Notes
              </div>
              <pre className="mono max-h-52 overflow-auto rounded-md bg-secondary p-3 text-[11px] whitespace-pre-wrap text-ink-secondary">
                {notes}
              </pre>
            </div>
          ) : null}

          {status === 'update_available' && source === 'release' ? (
            <div className="rounded-md bg-tint-orange px-3 py-2.5 text-[11.5px] text-ink-warning">
              <div className="flex items-center gap-1.5 font-medium">
                <AlertTriangle className="size-3.5" />
                Release 来源不自动执行升级
              </div>
              <ol className="mt-1.5 list-decimal space-y-0.5 ps-4">
                <li>先备份数据,尤其是数据库。</li>
                <li>阅读发布说明中的破坏性变更与迁移步骤。</li>
                <li>在服务器上修改镜像 tag / .env 到目标版本。</li>
                <li>执行 docker compose pull && docker compose up -d。</li>
                <li>验证启动日志与数据迁移结果。</li>
              </ol>
            </div>
          ) : null}

          {status === 'update_available' && (source === 'git' || source === 'registry') ? (
            <div className="rounded-md bg-tint-orange px-3 py-2.5 text-[11.5px] text-ink-warning">
              <div className="flex items-center gap-1.5 font-medium">
                <AlertTriangle className="size-3.5" />
                这会重建容器
              </div>
              <p className="mt-1">
                {source === 'git'
                  ? '将执行 git pull --ff-only → docker compose build → docker compose up -d。'
                  : '将执行 docker compose pull → docker compose up -d。'}
                服务会短暂中断;若项目包含数据库迁移,请先备份。
              </p>
            </div>
          ) : null}

          {result ? (
            <div
              className={cn(
                'rounded-md px-3 py-2.5 text-[12px]',
                result.ok ? 'bg-tint-success text-ink-success' : 'bg-tint-danger text-ink-danger',
              )}
            >
              <div className="flex items-center gap-1.5 font-medium">
                {result.ok ? <CheckCircle2 className="size-3.5" /> : <XCircle className="size-3.5" />}
                {result.message}
              </div>
              {result.command ? (
                <div className="mono mt-1 break-all text-[10.5px] opacity-80">{result.command}</div>
              ) : null}
            </div>
          ) : null}

          {error ? (
            <p className="rounded-md bg-tint-danger px-3 py-2 text-[12px] text-ink-danger">{error}</p>
          ) : null}

          {result?.output ? (
            <div>
              <div className="mb-1 text-[10.5px] font-medium text-ink-tertiary">输出</div>
              <pre className="mono max-h-60 overflow-auto rounded-md bg-secondary p-3 text-[11px] whitespace-pre-wrap">
                {result.output}
              </pre>
            </div>
          ) : null}

          {source === 'manual' ? (
            <p className="text-[11.5px] text-ink-tertiary">
              手动来源只记录配置与操作历史,不执行任何自动检测或升级。
            </p>
          ) : null}
        </div>

        <div className="flex items-center gap-2 border-t border-line px-4 py-3">
          <span className="text-[10.5px] text-ink-tertiary">
            {busy ? '构建 / 拉取可能需要数分钟,请勿关闭页面。' : '更新动作会写入审计日志。'}
          </span>
          <div className="ms-auto flex items-center gap-2">
            <GhostButton onClick={onClose} disabled={busy}>
              关闭
            </GhostButton>
            {canOperate && status === 'update_available' && (source === 'git' || source === 'registry') ? (
              <PrimaryButton onClick={() => void apply()} disabled={busy}>
                <span className="flex items-center gap-1.5">
                  {busy ? <Loader2 className="size-3 animate-spin" /> : <DownloadCloud className="size-3" />}
                  {busy ? '更新中…' : '执行更新'}
                </span>
              </PrimaryButton>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  )
}
