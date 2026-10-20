import {
  AlertTriangle,
  CheckCircle2,
  FolderSearch,
  GitBranch,
  Loader2,
  Rocket,
  Server as ServerIcon,
  X,
  XCircle,
} from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'

import {
  api,
  type DeployPreflight,
  type DeployResult,
  type DeploySource,
  type Server,
} from '../api'
import { cn } from '../cn'
import { Badge, GhostButton, PrimaryButton } from '../ui'

/*
 * 部署对话框：接管已有目录 / 从 Git 新建。
 *
 * 与「版本更新」页的分工:
 *   部署 —— 让一个项目第一次跑起来,或把机器上已有的 compose 项目纳入管理。
 *   更新 —— 项目已经在管理之中,推进到上游的新提交 / 镜像。
 *
 * 部署命令由后端构造,前端只收集参数;执行前必须先通过只读预检。
 */

const SOURCE_LABEL: Record<DeploySource, string> = {
  existing: '已有目录',
  git: 'Git 仓库',
}

const SOURCE_HINT: Record<DeploySource, string> = {
  existing: '目录与 Compose 文件已存在,直接执行 docker compose up -d。不拉取、不构建。',
  git: '克隆到不存在或空的目录,构建镜像后启动。成功后自动创建 Git 更新来源。',
}

const field =
  'h-8 w-full rounded-md border border-line bg-secondary px-2.5 text-[12.5px] text-ink outline-none transition-colors placeholder:text-ink-tertiary focus:border-accent disabled:cursor-not-allowed disabled:opacity-60'

export function DeployDialog({
  onClose,
  onDeployed,
}: {
  onClose: () => void
  onDeployed: () => Promise<void> | void
}) {
  const [servers, setServers] = useState<Server[]>([])
  const [serverId, setServerId] = useState('')
  const [loadingServers, setLoadingServers] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)

  const [source, setSource] = useState<DeploySource>('existing')
  const [name, setName] = useState('')
  const [workDir, setWorkDir] = useState('')
  const [composeFile, setComposeFile] = useState('')
  const [repoUrl, setRepoUrl] = useState('')
  const [branch, setBranch] = useState('')
  const [url, setUrl] = useState('')
  const [note, setNote] = useState('')

  const [preflight, setPreflight] = useState<DeployPreflight | null>(null)
  const [checking, setChecking] = useState(false)
  const [deploying, setDeploying] = useState(false)
  const [result, setResult] = useState<DeployResult | null>(null)
  const [error, setError] = useState<string | null>(null)

  const busy = checking || deploying

  useEffect(() => {
    let active = true
    api
      .servers()
      .then((rows) => {
        if (!active) return
        setServers(rows)
        setServerId((prev) => prev || rows[0]?.id || '')
        setLoadError(null)
      })
      .catch((err: Error) => {
        if (active) setLoadError(err.message)
      })
      .finally(() => {
        if (active) setLoadingServers(false)
      })
    return () => {
      active = false
    }
  }, [])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy) onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, busy])

  // 任何一个参数变化,之前的预检结论就失效;避免拿旧结论去部署新配置。
  const signature = useMemo(
    () =>
      JSON.stringify([
        serverId,
        name.trim(),
        source,
        workDir.trim(),
        composeFile.trim(),
        repoUrl.trim(),
        branch.trim(),
      ]),
    [serverId, name, source, workDir, composeFile, repoUrl, branch],
  )

  useEffect(() => {
    setPreflight(null)
    setResult(null)
    setError(null)
  }, [signature])

  const selectedServer = servers.find((server) => server.id === serverId) ?? null
  const canCheck =
    !!serverId &&
    name.trim().length > 0 &&
    workDir.trim().length > 0 &&
    (source === 'existing' || repoUrl.trim().length > 0) &&
    !busy

  const payload = () => ({
    server_id: serverId,
    name: name.trim(),
    source,
    work_dir: workDir.trim(),
    compose_file: composeFile.trim() || null,
    repo_url: source === 'git' ? repoUrl.trim() : null,
    branch: source === 'git' ? branch.trim() || null : null,
  })

  const check = async () => {
    if (!canCheck) return
    setChecking(true)
    setError(null)
    setPreflight(null)
    setResult(null)
    try {
      setPreflight(await api.deployPreflight(payload()))
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setChecking(false)
    }
  }

  const deploy = async () => {
    if (!preflight?.ok) return

    const serverName = selectedServer?.name ?? '目标服务器'
    const action =
      source === 'existing'
        ? '启动或重建容器,服务可能短暂中断。'
        : '克隆代码、构建镜像并启动,可能需要数分钟。'
    const ok = confirm(
      `确认部署「${name.trim()}」?\n\n` +
        `服务器:${serverName}\n` +
        `方式:${SOURCE_LABEL[source]}\n` +
        `目录:${preflight.work_dir}\n\n` +
        `将执行:\n${preflight.command}\n\n` +
        action,
    )
    if (!ok) return

    setDeploying(true)
    setError(null)
    setResult(null)
    try {
      const applied = await api.deployProject({
        ...payload(),
        url: url.trim() || null,
        note: note.trim() || null,
      })
      setResult(applied)
      if (applied.ok) await onDeployed()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setDeploying(false)
    }
  }

  const close = () => {
    if (!busy) onClose()
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={(event) => {
        if (event.target === event.currentTarget) close()
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="新建部署"
        className="flex max-h-[90vh] w-full max-w-[620px] flex-col overflow-hidden rounded-lg border border-line bg-primary shadow-xl"
      >
        <div className="flex items-center gap-2 border-b border-line px-4 py-3">
          <Rocket className="size-4 text-accent" />
          <h2 className="text-[14px] font-semibold text-ink">新建部署</h2>
          <span className="text-[11.5px] text-ink-tertiary">· 接管已有项目,或从 Git 新建</span>
          <button
            type="button"
            onClick={close}
            disabled={busy}
            aria-label="关闭"
            className="ms-auto cursor-pointer rounded-sm p-1 text-ink-tertiary transition-colors hover:bg-overlay-light hover:text-ink disabled:cursor-not-allowed disabled:opacity-40"
          >
            <X className="size-4" />
          </button>
        </div>

        <div className="flex flex-col gap-3.5 overflow-y-auto px-4 py-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="flex flex-col gap-1">
              <span className="flex items-center gap-1 text-[11.5px] text-ink-tertiary">
                <ServerIcon className="size-3" />
                目标服务器
              </span>
              <select
                value={serverId}
                onChange={(event) => setServerId(event.target.value)}
                disabled={busy || loadingServers || servers.length === 0}
                className={field}
              >
                {servers.length === 0 ? <option value="">没有可用服务器</option> : null}
                {servers.map((server) => (
                  <option key={server.id} value={server.id}>
                    {server.name} · {server.ip ?? server.hostname ?? '未配置地址'}
                  </option>
                ))}
              </select>
            </label>

            <label className="flex flex-col gap-1">
              <span className="text-[11.5px] text-ink-tertiary">项目名</span>
              <input
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="例如 dify"
                className={field}
                autoComplete="off"
                disabled={busy}
              />
              <span className="text-[10.5px] text-ink-tertiary">同一服务器内唯一,仅用于管理,不参与命令。</span>
            </label>
          </div>

          {loadingServers ? <p className="text-[11.5px] text-ink-tertiary">正在读取服务器…</p> : null}
          {loadError ? (
            <p className="rounded-md bg-tint-danger px-3 py-2 text-[12px] text-ink-danger">
              读取服务器失败:{loadError}
            </p>
          ) : null}
          {!loadingServers && servers.length === 0 && !loadError ? (
            <p className="rounded-md bg-tint-orange px-3 py-2 text-[11.5px] text-ink-warning">
              还没有服务器。请先在「服务器」页登记目标机。
            </p>
          ) : null}

          <div className="flex flex-wrap items-center gap-1.5">
            {(['existing', 'git'] as DeploySource[]).map((value) => {
              const active = source === value
              const Icon = value === 'existing' ? FolderSearch : GitBranch
              return (
                <button
                  key={value}
                  type="button"
                  onClick={() => setSource(value)}
                  disabled={busy}
                  className={cn(
                    'flex h-7 cursor-pointer items-center gap-1.5 rounded-md border px-2.5 text-[11.5px] transition-colors disabled:cursor-not-allowed disabled:opacity-60',
                    active
                      ? 'border-line-strong bg-overlay-light font-medium text-ink'
                      : 'border-line bg-primary text-ink-secondary hover:bg-overlay-lighter',
                  )}
                >
                  <Icon className="size-3" />
                  {SOURCE_LABEL[value]}
                </button>
              )
            })}
          </div>

          <p className="text-[11px] text-ink-tertiary">{SOURCE_HINT[source]}</p>

          <label className="flex flex-col gap-1">
            <span className="text-[11.5px] text-ink-tertiary">
              {source === 'existing' ? '工作目录' : '克隆到'}
            </span>
            <input
              value={workDir}
              onChange={(event) => setWorkDir(event.target.value)}
              placeholder="/opt/dify/docker"
              className={cn(field, 'mono')}
              autoComplete="off"
              disabled={busy}
            />
            <span className="text-[10.5px] text-ink-tertiary">
              必须是绝对路径。Git 方式只允许不存在或空的目录,不会覆盖已有文件。
            </span>
          </label>

          <div className="grid gap-3 sm:grid-cols-2">
            <label className="flex flex-col gap-1">
              <span className="text-[11.5px] text-ink-tertiary">Compose 文件(可选)</span>
              <input
                value={composeFile}
                onChange={(event) => setComposeFile(event.target.value)}
                placeholder="留空使用默认文件"
                className={cn(field, 'mono')}
                autoComplete="off"
                disabled={busy}
              />
            </label>

            {source === 'git' ? (
              <label className="flex flex-col gap-1">
                <span className="text-[11.5px] text-ink-tertiary">分支(可选)</span>
                <input
                  value={branch}
                  onChange={(event) => setBranch(event.target.value)}
                  placeholder="留空使用默认分支"
                  className={cn(field, 'mono')}
                  autoComplete="off"
                  disabled={busy}
                />
              </label>
            ) : (
              <div className="flex flex-col gap-1">
                <span className="text-[11.5px] text-ink-tertiary">执行内容</span>
                <div className="mono flex h-8 items-center rounded-md bg-sunken px-2.5 text-[11px] text-ink-tertiary">
                  docker compose up -d
                </div>
              </div>
            )}
          </div>

          {source === 'git' ? (
            <label className="flex flex-col gap-1">
              <span className="text-[11.5px] text-ink-tertiary">Git 仓库地址</span>
              <input
                value={repoUrl}
                onChange={(event) => setRepoUrl(event.target.value)}
                placeholder="https://github.com/owner/repo.git 或 git@github.com:owner/repo.git"
                className={cn(field, 'mono')}
                autoComplete="off"
                disabled={busy}
              />
              <span className="text-[10.5px] text-ink-tertiary">
                使用目标机上的 Git 凭据;地址里不要写账号或令牌,命令会写入操作历史。
              </span>
            </label>
          ) : null}

          <div className="grid gap-3 sm:grid-cols-2">
            <label className="flex flex-col gap-1">
              <span className="text-[11.5px] text-ink-tertiary">访问地址(可选)</span>
              <input
                value={url}
                onChange={(event) => setUrl(event.target.value)}
                placeholder="https://app.example.com"
                className={cn(field, 'mono')}
                autoComplete="off"
                disabled={busy}
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-[11.5px] text-ink-tertiary">备注(可选)</span>
              <input
                value={note}
                onChange={(event) => setNote(event.target.value)}
                placeholder="例如:生产环境,勿随意重启"
                className={field}
                autoComplete="off"
                disabled={busy}
              />
            </label>
          </div>

          {preflight ? (
            <div className="rounded-md border border-line bg-sunken px-3 py-2.5">
              <div className="mb-1.5 flex flex-wrap items-center gap-2">
                <span className="text-[11.5px] font-medium text-ink">部署前检查</span>
                <Badge tone={preflight.ok ? 'ok' : 'bad'}>{preflight.ok ? '通过' : '未通过'}</Badge>
                <span className="mono truncate text-[10.5px] text-ink-tertiary">{preflight.work_dir}</span>
              </div>
              <ul className="space-y-1">
                {preflight.checks.map((check) => (
                  <li key={check.key} className="flex items-start gap-1.5 text-[11.5px]">
                    {check.ok ? (
                      <CheckCircle2 className="mt-0.5 size-3.5 shrink-0 text-ink-success" />
                    ) : (
                      <XCircle className="mt-0.5 size-3.5 shrink-0 text-ink-danger" />
                    )}
                    <span className={check.ok ? 'text-ink-secondary' : 'text-ink-danger'}>{check.label}</span>
                    <span className="min-w-0 break-all text-ink-tertiary">· {check.detail}</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {preflight && !preflight.ok ? (
            <div className="flex items-start gap-1.5 rounded-md bg-tint-orange px-3 py-2 text-[11.5px] text-ink-warning">
              <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
              预检未通过时不能执行部署。修正后重新检查。
            </div>
          ) : null}

          {preflight ? (
            <div>
              <div className="mb-1 text-[10.5px] font-medium tracking-wider text-ink-tertiary uppercase">
                将执行的命令
              </div>
              <pre className="mono max-h-28 overflow-auto rounded-md bg-secondary p-2.5 text-[10.5px] break-all whitespace-pre-wrap text-ink-secondary">
                {preflight.command}
              </pre>
            </div>
          ) : null}

          {deploying ? (
            <div className="flex items-center gap-2 rounded-md bg-sunken px-3 py-2.5 text-[12px] text-ink-secondary">
              <Loader2 className="size-3.5 animate-spin text-accent" />
              部署执行中,构建镜像可能需要数分钟。请勿关闭页面。
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
              {result.ok && result.project ? (
                <div className="mt-1 text-[11px] opacity-80">
                  项目已登记,可在「版本更新」页检查上游变化
                  {result.config ? '(Git 来源已自动配置)' : ''}。
                </div>
              ) : null}
            </div>
          ) : null}

          {error ? (
            <p className="rounded-md bg-tint-danger px-3 py-2 text-[12px] break-all text-ink-danger">{error}</p>
          ) : null}

          {result?.output ? (
            <div>
              <div className="mb-1 text-[10.5px] font-medium tracking-wider text-ink-tertiary uppercase">
                执行输出
              </div>
              <pre className="mono max-h-56 overflow-auto rounded-md bg-secondary p-3 text-[11px] whitespace-pre-wrap text-ink-secondary">
                {result.output}
              </pre>
            </div>
          ) : null}
        </div>

        <div className="flex items-center gap-2 border-t border-line px-4 py-3">
          <span className="text-[10.5px] text-ink-tertiary">
            {result?.ok ? '部署记录已写入操作历史与审计。' : '部署前必须通过检查;命令由后端构造。'}
          </span>
          <div className="ms-auto flex items-center gap-2">
            <GhostButton onClick={result?.ok ? close : onClose} disabled={busy}>
              {result?.ok ? '完成' : '取消'}
            </GhostButton>
            {!result ? (
              <>
                <GhostButton onClick={() => void check()} disabled={!canCheck}>
                  <span className="flex items-center gap-1.5">
                    {checking ? <Loader2 className="size-3 animate-spin" /> : <FolderSearch className="size-3" />}
                    {checking ? '检查中…' : '检查环境'}
                  </span>
                </GhostButton>
                <PrimaryButton onClick={() => void deploy()} disabled={!preflight?.ok || busy}>
                  <span className="flex items-center gap-1.5">
                    {deploying ? <Loader2 className="size-3 animate-spin" /> : <Rocket className="size-3" />}
                    {deploying ? '部署中…' : '开始部署'}
                  </span>
                </PrimaryButton>
              </>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  )
}
