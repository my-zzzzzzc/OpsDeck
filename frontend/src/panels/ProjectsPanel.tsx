import { useCallback, useEffect, useState } from 'react'

import {
  api,
  DANGER_LABEL,
  type ActionCatalogItem,
  type ActionLogItem,
  type Project,
  type User,
} from '../api'
import { useHeaderMeta } from '../header-meta'
import { Badge, Card, Empty, SectionTitle } from '../ui'
import { ProjectWorkspaceDialog } from './ProjectWorkspaceDialog'

/**
 * 项目管理面板：展示项目资产，并对每个项目执行白名单操作。
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
  const [selected, setSelected] = useState<Project | null>(null)
  const [logs, setLogs] = useState<ActionLogItem[]>([])
  const [running, setRunning] = useState<string | null>(null)
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null)
  const [workspace, setWorkspace] = useState<Project | null>(null)

  // viewer 没有 operate 权限,不展示写操作
  const canOperate = user.role === 'admin' || user.role === 'operator'

  const reload = useCallback(async () => {
    try {
      setProjects(await api.projects())
      setLogs(await api.actionLogs(20))
    } catch (err) {
      setMsg({ text: (err as Error).message, ok: false })
    }
  }, [])

  useEffect(() => {
    void reload()
  }, [reload])

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
      setMsg({
        text: `${action.label} 执行完成（${log.status}）`,
        ok: log.status === 'success',
      })
      setSelected(project)
      await reload()
    } catch (err) {
      setMsg({ text: `执行失败：${(err as Error).message}`, ok: false })
    } finally {
      setRunning(null)
    }
  }

  // 数量交给页头,内容区不再重复「项目」这个页面名
  useHeaderMeta(projects.length > 0 ? `${projects.length} 个` : null)

  return (
    <>
      <section className="mb-5">
        {projects.length === 0 ? (
          <Card>
            <Empty>还没有项目。先登记项目后才能执行运维操作。</Empty>
          </Card>
        ) : (
          <div className="flex flex-col gap-3">
            {projects.map((p) => (
              <Card key={p.id}>
                <div className="mb-2 flex flex-wrap items-center gap-2.5">
                  <strong className="text-[15px]">{p.name}</strong>
                  <Badge tone="neutral">{p.kind}</Badge>
                  {p.tags?.map((t) => (
                    <Badge key={t} tone="ok">
                      {t}
                    </Badge>
                  ))}
                  {p.url ? (
                    <a
                      href={p.url}
                      target="_blank"
                      rel="noreferrer"
                      className="text-xs text-accent hover:underline"
                    >
                      {p.url}
                    </a>
                  ) : null}
                  <button
                    type="button"
                    onClick={() => setWorkspace(p)}
                    className="ms-auto h-7 cursor-pointer rounded-md border border-line px-2 text-[10.5px] text-ink-secondary hover:bg-overlay-light hover:text-ink"
                  >
                    打开项目
                  </button>
                </div>

                <div className="mb-3 grid gap-x-6 gap-y-1 text-xs text-ink-tertiary sm:grid-cols-2">
                  <div>
                    工作目录：<span className="mono text-ink-secondary">{p.work_dir ?? '—'}</span>
                  </div>
                  <div>
                    重启命令：<span className="mono text-ink-secondary">{p.restart_cmd ?? '—'}</span>
                  </div>
                </div>

                {canOperate ? (
                  <div className="flex flex-wrap gap-1.5">
                    {catalog
                      .filter((a) => a.enabled && a.key !== 'logs')
                      .map((a) => {
                        const busy = running === `${p.id}:${a.key}`
                        return (
                          <button
                            key={a.key}
                            type="button"
                            disabled={busy}
                            onClick={() => void run(p, a)}
                            title={a.description}
                            className={`rounded-md border px-2.5 py-1 text-xs transition-colors disabled:opacity-50 ${
                              a.read_only
                                ? 'border-line text-ink-tertiary hover:border-line hover:text-ink'
                                : a.danger === 'medium' || a.danger === 'high'
                                  ? 'border-danger/40 text-ink-danger hover:bg-tint-danger'
                                  : 'border-line text-ink-secondary hover:border-line'
                            }`}
                          >
                            {busy ? '执行中…' : a.label}
                          </button>
                        )
                      })}
                  </div>
                ) : (
                  <p className="text-xs text-ink-tertiary">只读角色无法执行操作。</p>
                )}
              </Card>
            ))}
          </div>
        )}
      </section>

      {workspace ? (
        <ProjectWorkspaceDialog
          project={workspace}
          user={user}
          catalog={catalog}
          onClose={() => setWorkspace(null)}
        />
      ) : null}

      {msg ? (
        <p className={`mb-5 text-[13px] ${msg.ok ? 'text-ink-success' : 'text-ink-danger'}`}>{msg.text}</p>
      ) : null}

      <section>
        <SectionTitle>操作历史</SectionTitle>
        <Card className="p-0">
          {logs.length === 0 ? (
            <div className="p-5">
              <Empty>还没有执行过操作。</Empty>
            </div>
          ) : (
            <ul>
              {logs.map((l) => (
                <li key={l.id} className="border-b border-line px-5 py-3 last:border-0">
                  <div className="flex flex-wrap items-center gap-2.5">
                    <Badge
                      tone={
                        l.status === 'success'
                          ? 'ok'
                          : l.status === 'rejected'
                            ? 'warn'
                            : l.status === 'failed'
                              ? 'bad'
                              : 'neutral'
                      }
                    >
                      {l.status}
                    </Badge>
                    <span className="text-[13px] font-medium">{l.project_name}</span>
                    <span className="text-xs text-ink-tertiary">{l.action}</span>
                    <span className="ml-auto text-xs text-ink-tertiary">
                      {l.username} · {new Date(l.created_at).toLocaleString('zh-CN')}
                    </span>
                  </div>
                  {l.command ? (
                    <div className="mono mt-1.5 text-xs text-ink-tertiary">{l.command}</div>
                  ) : null}
                  {selected?.id === l.project_id && l.output ? (
                    <pre className="mono mt-2 max-h-48 overflow-auto rounded-lg bg-secondary p-3 text-xs whitespace-pre-wrap">
                      {l.output}
                    </pre>
                  ) : l.output ? (
                    <div className="mt-1 text-xs text-ink-tertiary">{l.output.slice(0, 120)}</div>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </Card>
      </section>
    </>
  )
}
