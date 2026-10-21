import { FolderSearch, Loader2, Server as ServerIcon, X } from 'lucide-react'
import { useEffect, useState } from 'react'

import { api, type Project } from '../api'
import { cn } from '../cn'
import { GhostButton, PrimaryButton } from '../ui'

/*
 * 接管对话框。
 *
 * 接管只把自动发现的项目登记为受管资产,不执行 docker compose up,
 * 也不重启任何容器 —— 命令类操作仍由部署、更新与白名单操作各自负责。
 */

const field =
  'h-8 w-full rounded-md border border-line bg-secondary px-2.5 text-[12.5px] text-ink outline-none transition-colors placeholder:text-ink-tertiary focus:border-accent disabled:cursor-not-allowed disabled:opacity-60'

export function AdoptProjectDialog({
  project,
  onClose,
  onAdopted,
}: {
  project: Project
  onClose: () => void
  onAdopted: (project: Project) => Promise<void> | void
}) {
  const [name, setName] = useState(project.compose_project ?? project.name)
  const [workDir, setWorkDir] = useState(project.work_dir ?? '')
  const [composeFile, setComposeFile] = useState(project.compose_file ?? '')
  const [url, setUrl] = useState(project.url ?? '')
  const [note, setNote] = useState(project.note ?? '')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !submitting) onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, submitting])

  const submit = async () => {
    const dir = workDir.trim()
    const file = composeFile.trim()

    if (!dir) {
      setError('请填写项目的工作目录。')
      return
    }
    if (!dir.startsWith('/')) {
      setError('工作目录必须是绝对路径,例如 /opt/dify/docker。')
      return
    }
    if (!file) {
      setError('请填写 Compose 文件名。')
      return
    }
    if (file.includes('/') || file.includes('\\') || file === '.' || file === '..') {
      setError('Compose 文件只填工作目录中的文件名,例如 docker-compose.yml。')
      return
    }

    setSubmitting(true)
    setError(null)
    try {
      const adopted = await api.adoptProject(project.id, {
        name: name.trim() || undefined,
        work_dir: dir,
        compose_file: file,
        url: url.trim() || null,
        note: note.trim() || null,
      })
      await onAdopted(adopted)
      onClose()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setSubmitting(false)
    }
  }

  const close = () => {
    if (!submitting) onClose()
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
        aria-label={`接管 ${project.name}`}
        className="flex max-h-[90vh] w-full max-w-[560px] flex-col overflow-hidden rounded-lg border border-line bg-primary shadow-xl"
      >
        <div className="flex items-center gap-2 border-b border-line px-4 py-3">
          <FolderSearch className="size-4 text-accent" />
          <h2 className="text-[14px] font-semibold text-ink">接管项目</h2>
          <span className="min-w-0 truncate text-[11.5px] text-ink-tertiary">
            · {project.compose_project ?? project.name}
          </span>
          <button
            type="button"
            onClick={close}
            disabled={submitting}
            aria-label="关闭"
            className="ms-auto cursor-pointer rounded-sm p-1 text-ink-tertiary transition-colors hover:bg-overlay-light hover:text-ink disabled:cursor-not-allowed disabled:opacity-40"
          >
            <X className="size-4" />
          </button>
        </div>

        <div className="flex flex-col gap-3.5 overflow-y-auto px-4 py-4">
          <div className="grid gap-2 rounded-md border border-line bg-sunken px-3 py-2 text-[11px] sm:grid-cols-2">
            <div className="flex min-w-0 items-center gap-1.5">
              <span className="shrink-0 text-ink-tertiary">Compose 项目</span>
              <span className="mono min-w-0 truncate text-ink-secondary">
                {project.compose_project ?? '—'}
              </span>
            </div>
            <div className="flex min-w-0 items-center gap-1.5">
              <ServerIcon className="size-3 shrink-0 text-ink-tertiary" />
              <span className="min-w-0 truncate text-ink-secondary">
                {project.server_name ?? '未知服务器'}
              </span>
            </div>
          </div>

          <label className="flex flex-col gap-1">
            <span className="text-[11.5px] text-ink-tertiary">显示名</span>
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="例如 dify"
              className={field}
              autoComplete="off"
              disabled={submitting}
            />
            <span className="text-[10.5px] text-ink-tertiary">
              同一服务器内唯一,仅用于管理,不影响 Compose 项目名。
            </span>
          </label>

          <label className="flex flex-col gap-1">
            <span className="text-[11.5px] text-ink-tertiary">工作目录</span>
            <input
              value={workDir}
              onChange={(event) => setWorkDir(event.target.value)}
              placeholder="/opt/dify/docker"
              className={cn(field, 'mono')}
              autoComplete="off"
              disabled={submitting}
            />
            <span className="text-[10.5px] text-ink-tertiary">
              必须是绝对路径。{project.work_dir ? '已按采集结果预填,请确认。' : '请填写 Compose 文件所在目录。'}
            </span>
          </label>

          <label className="flex flex-col gap-1">
            <span className="text-[11.5px] text-ink-tertiary">Compose 文件</span>
            <input
              value={composeFile}
              onChange={(event) => setComposeFile(event.target.value)}
              placeholder="docker-compose.yml"
              className={cn(field, 'mono')}
              autoComplete="off"
              disabled={submitting}
            />
            <span className="text-[10.5px] text-ink-tertiary">
              只填文件名,不要带目录{project.compose_file ? ';已按采集结果预填。' : '。'}
            </span>
          </label>

          <div className="grid gap-3 sm:grid-cols-2">
            <label className="flex flex-col gap-1">
              <span className="text-[11.5px] text-ink-tertiary">访问地址(可选)</span>
              <input
                value={url}
                onChange={(event) => setUrl(event.target.value)}
                placeholder="https://app.example.com"
                className={cn(field, 'mono')}
                autoComplete="off"
                disabled={submitting}
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-[11.5px] text-ink-tertiary">说明(可选)</span>
              <input
                value={note}
                onChange={(event) => setNote(event.target.value)}
                placeholder="例如:生产环境,勿随意重启"
                className={field}
                autoComplete="off"
                disabled={submitting}
              />
            </label>
          </div>

          <p className="rounded-md border border-line bg-sunken px-3 py-2 text-[11px] leading-5 text-ink-secondary">
            接管只登记资产,不重启容器、不执行任何远端命令;接管后才会参与部署、更新、操作和告警。
          </p>

          {error ? (
            <p className="rounded-md bg-tint-danger px-3 py-2 text-[12px] break-all text-ink-danger">
              {error}
            </p>
          ) : null}
        </div>

        <div className="flex items-center gap-2 border-t border-line px-4 py-3">
          <span className="text-[10.5px] text-ink-tertiary">接管记录会写入审计日志。</span>
          <div className="ms-auto flex items-center gap-2">
            <GhostButton onClick={close} disabled={submitting}>
              取消
            </GhostButton>
            <PrimaryButton onClick={() => void submit()} disabled={submitting}>
              <span className="flex items-center gap-1.5">
                {submitting ? <Loader2 className="size-3 animate-spin" /> : null}
                {submitting ? '接管中…' : '确认接管'}
              </span>
            </PrimaryButton>
          </div>
        </div>
      </div>
    </div>
  )
}
