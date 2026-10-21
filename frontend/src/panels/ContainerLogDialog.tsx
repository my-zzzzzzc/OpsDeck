import { X } from 'lucide-react'
import { useEffect } from 'react'

import type { InstanceDetail } from '../api'
import { LogStreamPanel } from './ContainerLogDrawer'

/** 单容器日志浮窗。与项目日志不同,这里只跟一个容器,不混入同栈其它服务。 */
export function ContainerLogDialog({ container, onClose }: { container: InstanceDetail; onClose: () => void }) {
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
        aria-label={`${container.name} 容器日志`}
        onClick={(event) => event.stopPropagation()}
        style={{ width: 'min(88vw, 860px)', height: 'min(78vh, 620px)', resize: 'both' }}
        className="absolute left-1/2 top-1/2 flex min-h-[19rem] min-w-[22rem] max-w-[96vw] max-h-[92vh] -translate-x-1/2 -translate-y-1/2 overflow-hidden rounded-lg border border-line bg-primary shadow-2xl"
      >
        <div className="flex min-h-0 w-full flex-col">
          <header className="flex shrink-0 items-center gap-2 border-b border-line px-4 py-2.5">
            <div className="min-w-0 flex-1">
              <h2 className="mono truncate text-[13px] font-semibold text-ink">
                {container.name} · 容器日志
              </h2>
              <p className="truncate text-[10px] text-ink-tertiary">
                {container.project_name ?? '未归属项目'} · {container.image ?? '未知镜像'} · 切换时间范围回看历史
              </p>
            </div>
            <button type="button" onClick={onClose} title="关闭" className="flex size-7 cursor-pointer items-center justify-center rounded-md text-ink-tertiary hover:bg-overlay-light hover:text-ink"><X className="size-4" /></button>
          </header>
          <div className="flex min-h-0 flex-1 flex-col">
            <LogStreamPanel
              ariaLabel={`${container.name} 的容器日志`}
              streamUrl={`/ws/containers/${container.id}/logs`}
              liveNote={`docker logs --follow ${container.name}`}
              emptyText="该时间范围内没有容器日志"
            />
          </div>
        </div>
      </div>
    </div>
  )
}
