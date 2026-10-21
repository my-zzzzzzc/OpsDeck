import { useMemo } from 'react'

import type { InstanceDetail } from './api'
import { cn } from './cn'
import { IconAlert, IconArrowUpRight, IconBoxes, IconCheck } from './icons'
import { Card } from './ui'

/** 容器在概览和容器页共用的展示分类。 */
export type ContainerBucket = 'running' | 'unhealthy' | 'stopped' | 'done'

const ONE_SHOT_MARKERS = ['init', 'migrat', 'setup', 'provision']

/** 一次性初始化任务退出属于正常生命周期，不应作为异常提示。
 *
 * docker compose run 创建的容器带 oneoff 标签，这是权威信号；普通 service
 * （包括名字里带 setup 的常驻服务）被人工停止时不能算完成。旧采集器没有标签
 * 与准确退出码，此时保留名称启发式作为历史数据兜底。
 */
export function isOneShot(container: InstanceDetail): boolean {
  if (container.one_off) return true
  const policy = (container.restart_policy ?? '').trim().toLowerCase()
  if (policy !== '' && policy !== 'no') return false
  if (container.exit_code !== 0) return false
  return ONE_SHOT_MARKERS.some((marker) => container.name.toLowerCase().includes(marker))
}

export function bucketOf(container: InstanceDetail): ContainerBucket {
  const state = (container.state ?? '').toLowerCase()
  const health = (container.health ?? '').toLowerCase()
  if (state !== 'running') return isOneShot(container) ? 'done' : 'stopped'
  return health === 'unhealthy' ? 'unhealthy' : 'running'
}

const LABEL: Record<ContainerBucket, string> = {
  running: '运行中', unhealthy: '不健康', stopped: '已停止', done: '已完成',
}

const TONE: Record<ContainerBucket, { dot: string; segment: string; text: string; row: string }> = {
  running: { dot: 'bg-status-ok', segment: 'bg-status-ok', text: 'text-ink-success', row: '' },
  unhealthy: { dot: 'bg-status-warn', segment: 'bg-status-warn', text: 'text-ink-warning', row: 'border-s-ink-warning bg-tint-warning/30' },
  stopped: { dot: 'bg-status-bad', segment: 'bg-status-bad', text: 'text-ink-danger', row: 'border-s-ink-danger bg-tint-danger/30' },
  done: { dot: 'bg-ink-tertiary', segment: 'bg-ink-tertiary/50', text: 'text-ink-tertiary', row: '' },
}

function needsAttention(container: InstanceDetail): boolean {
  const bucket = bucketOf(container)
  return bucket === 'unhealthy' || bucket === 'stopped'
}

/** 首页只做态势判断；完整的检索、分组、日志和操作放在独立容器页。 */
export function ContainerBoard({ containers, error, onOpenAll }: {
  containers: InstanceDetail[]
  error?: string | null
  onOpenAll?: () => void
}) {
  const counts = useMemo(() => {
    const value = { running: 0, unhealthy: 0, stopped: 0, done: 0 }
    for (const container of containers) value[bucketOf(container)] += 1
    return value
  }, [containers])
  const issues = useMemo(() => containers.filter(needsAttention).sort((a, b) => {
    const rank = (item: InstanceDetail) => bucketOf(item) === 'unhealthy' ? 0 : 1
    return rank(a) - rank(b) || a.name.localeCompare(b.name)
  }), [containers])
  const attention = counts.unhealthy + counts.stopped
  const serverCount = new Set(containers.map((container) => container.server_id ?? container.server_name ?? '?')).size

  return (
    <Card padded={false} className="flex flex-col overflow-hidden">
      <div className="flex flex-wrap items-start justify-between gap-3 px-4 pt-4">
        <div className="flex min-w-0 items-start gap-2.5">
          <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-sunken text-ink-secondary"><IconBoxes size={15} /></span>
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-[13px] font-semibold text-ink">容器状态</h2>
              {attention > 0 ? <span className="flex items-center gap-1 rounded-xs bg-tint-orange px-1.5 py-0.5 text-[9.5px] font-medium text-ink-warning"><IconAlert size={9} /> {attention} 需关注</span> : containers.length > 0 ? <span className="flex items-center gap-1 rounded-xs bg-tint-success px-1.5 py-0.5 text-[9.5px] font-medium text-ink-success"><IconCheck size={9} /> 运行正常</span> : null}
            </div>
            <p className="mt-0.5 text-[10.5px] text-ink-tertiary">{serverCount} 台服务器 · {containers.length} 个容器</p>
          </div>
        </div>
        {onOpenAll ? <button type="button" onClick={onOpenAll} className="flex h-7 cursor-pointer items-center gap-1 rounded-md border border-line px-2 text-[10.5px] text-ink-secondary transition-colors hover:bg-overlay-light hover:text-accent">查看全部容器 <IconArrowUpRight size={11} /></button> : null}
      </div>

      {containers.length > 0 ? <div className="mt-3 px-4">
        <div className="flex h-1.5 gap-px overflow-hidden rounded-full bg-overlay-medium">
          {(['running', 'unhealthy', 'stopped', 'done'] as const).map((bucket) => counts[bucket] > 0 ? <span key={bucket} className={TONE[bucket].segment} style={{ flexGrow: counts[bucket], flexBasis: 0 }} title={`${LABEL[bucket]} ${counts[bucket]}`} /> : null)}
        </div>
        <div className="mt-2 grid grid-cols-4 gap-2 text-[10px]">
          {(['running', 'unhealthy', 'stopped', 'done'] as const).map((bucket) => <span key={bucket} className="flex min-w-0 items-center gap-1 text-ink-tertiary"><i className={cn('size-1.5 shrink-0 rounded-full', TONE[bucket].dot)} /><span className="truncate">{LABEL[bucket]}</span><b className={cn('ms-auto font-medium tabular-nums', TONE[bucket].text)}>{counts[bucket]}</b></span>)}
        </div>
      </div> : null}

      {error ? <p className="mx-4 mt-3 rounded-md bg-tint-danger px-2.5 py-1.5 text-[11px] text-ink-danger">{error}</p> : null}

      <section className="mt-3 flex min-h-0 flex-1 flex-col border-t border-line">
        <div className="flex items-center justify-between px-4 py-2.5"><span className="text-[10.5px] font-medium text-ink-tertiary">需关注的容器</span><span className="text-[10px] tabular-nums text-ink-tertiary">{issues.length} 个</span></div>
        {containers.length === 0 ? <div className="flex flex-1 flex-col items-center justify-center gap-1.5 px-4 py-8 text-center"><IconBoxes size={18} className="text-ink-tertiary" /><p className="text-[11.5px] text-ink-secondary">等待采集器上报容器状态</p></div> : issues.length === 0 ? <div className="flex flex-1 flex-col items-center justify-center gap-1.5 px-4 py-8 text-center"><span className="flex size-9 items-center justify-center rounded-full bg-tint-success text-ink-success"><IconCheck size={16} /></span><p className="text-[11.5px] text-ink-success">当前没有需要处理的容器</p><p className="text-[10.5px] text-ink-tertiary">{counts.running} 个运行中 · {counts.done} 个已完成</p></div> : <div className="border-t border-line">
          {issues.slice(0, 5).map((container) => {
            const bucket = bucketOf(container)
            return <button key={container.id} type="button" onClick={onOpenAll} className={cn('flex w-full cursor-pointer items-center gap-2 border-b border-s-2 border-line px-4 py-2 text-left last:border-b-0 hover:bg-overlay-lighter', TONE[bucket].row)}>
              <span className={cn('size-1.5 shrink-0 rounded-full', TONE[bucket].dot)} />
              <span className="min-w-0 flex-1"><span className="block truncate text-[11.5px] font-medium text-ink">{container.name}</span><span className="block truncate text-[10px] text-ink-tertiary">{container.server_name ?? '未知服务器'} · {container.project_name ?? '未归属项目'}</span></span>
              <span className={cn('shrink-0 text-[10px] font-medium', TONE[bucket].text)}>{LABEL[bucket]}</span>
              <span className="w-12 shrink-0 text-right text-[10px] tabular-nums text-ink-tertiary">{container.mem_used_mb == null ? '—' : `${container.mem_used_mb} MB`}</span>
            </button>
          })}
          {issues.length > 5 ? <p className="px-4 py-2 text-[10px] text-ink-tertiary">另有 {issues.length - 5} 个需关注项，请前往容器页处理。</p> : null}
          {issues.length < 5 && counts.running > 0 ? <div className="flex flex-1 items-center justify-center gap-1.5 px-4 py-4 text-[10.5px] text-ink-tertiary"><IconCheck size={11} className="text-ink-success" />其余 {counts.running} 个容器运行正常</div> : null}
        </div>}
      </section>
    </Card>
  )
}
