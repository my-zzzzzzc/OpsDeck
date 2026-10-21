import { X } from 'lucide-react'
import { useEffect } from 'react'

import type { Project } from '../api'
import { LogStreamPanel } from './ContainerLogDrawer'

/** 项目级 Compose 日志浮窗,可由右下角拖拽改变尺寸。 */
export function ProjectLogDialog({ project, onClose }: { project: Project; onClose: () => void }) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div
      className="fixed inset-0 z-50 bg-black/60"
      role="presentation"
      onClick={(event) => { event.stopPropagation(); onClose() }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`${project.name} 项目日志`}
        onClick={(event) => event.stopPropagation()}
        style={{ width: 'min(88vw, 860px)', height: 'min(78vh, 620px)', resize: 'both' }}
        className="absolute left-1/2 top-1/2 flex min-h-[19rem] min-w-[22rem] max-w-[96vw] max-h-[92vh] -translate-x-1/2 -translate-y-1/2 overflow-hidden rounded-lg border border-line bg-primary shadow-2xl"
      >
        <div className="flex min-h-0 w-full flex-col">
          <header className="flex shrink-0 items-center gap-2 border-b border-line px-4 py-2.5">
            <div className="min-w-0 flex-1">
              <h2 className="truncate text-[13px] font-semibold text-ink">
                {project.name} · 项目日志
              </h2>
              <p className="text-[10px] text-ink-tertiary">
                全部容器 · 切换时间范围回看历史 · 可拖拽右下角调整大小
              </p>
            </div>
            <button type="button" onClick={onClose} title="关闭" className="flex size-7 cursor-pointer items-center justify-center rounded-md text-ink-tertiary hover:bg-overlay-light hover:text-ink"><X className="size-4" /></button>
          </header>
          <div className="flex min-h-0 flex-1 flex-col">
            <LogStreamPanel
              ariaLabel={`${project.name} 的项目日志`}
              streamUrl={`/ws/projects/${project.id}/logs`}
              liveNote="docker compose logs --follow"
              emptyText="该时间范围内没有项目日志"
            />
          </div>
        </div>
      </div>
    </div>
  )
}
