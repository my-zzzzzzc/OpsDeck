import { Maximize2, RefreshCw, X } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'

import { api, type Project } from '../api'
import { cn } from '../cn'

function tone(line: string): string {
  const text = line.toUpperCase()
  if (text.includes('ERROR') || text.includes('FATAL') || text.includes('TRACEBACK')) return 'text-ink-danger'
  if (text.includes('WARN')) return 'text-ink-warning'
  return 'text-ink-secondary'
}

/** 项目级 Compose 日志；浮窗可由右下角拖拽改变尺寸。 */
export function ProjectLogDialog({ project, onClose }: { project: Project; onClose: () => void }) {
  const [output, setOutput] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const log = await api.executeAction({ project_id: project.id, action: 'logs' })
      setOutput(log.output || '(无输出)')
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setLoading(false)
    }
  }, [project.id])

  useEffect(() => { void load() }, [load])
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className="fixed inset-0 z-50 bg-black/60" role="presentation" onClick={onClose}>
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
            <span className="size-1.5 rounded-full bg-ink-success" />
            <div className="min-w-0 flex-1"><h2 className="truncate text-[13px] font-semibold text-ink">{project.name} · 项目日志</h2><p className="text-[10px] text-ink-tertiary">最近 200 行 · 可拖拽右下角调整大小</p></div>
            <button type="button" onClick={() => void load()} disabled={loading} title="刷新日志" className="flex size-7 cursor-pointer items-center justify-center rounded-md text-ink-tertiary hover:bg-overlay-light hover:text-ink disabled:opacity-50"><RefreshCw className={cn('size-3.5', loading && 'animate-spin')} /></button>
            <button type="button" onClick={onClose} title="关闭" className="flex size-7 cursor-pointer items-center justify-center rounded-md text-ink-tertiary hover:bg-overlay-light hover:text-ink"><X className="size-4" /></button>
          </header>
          <main className="min-h-0 flex-1 overflow-auto bg-sunken px-4 py-3">
            {error ? <p className="rounded-md bg-tint-danger px-3 py-2 text-[12px] text-ink-danger">{error}</p> : null}
            {loading && !output ? <p className="py-8 text-center text-[12px] text-ink-tertiary">正在读取日志…</p> : null}
            {output ? <pre className="mono text-[11.5px] leading-[1.65] whitespace-pre-wrap break-all">{output.split('\n').map((line, index) => <span key={index} className={cn('block', tone(line))}>{line}</span>)}</pre> : null}
          </main>
          <footer className="flex shrink-0 items-center justify-end gap-1 border-t border-line px-3 py-1.5 text-[10px] text-ink-tertiary"><Maximize2 className="size-3" />拖拽右下角缩放</footer>
        </div>
      </div>
    </div>
  )
}
