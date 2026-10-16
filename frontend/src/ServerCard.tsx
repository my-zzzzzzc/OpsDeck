import {
  Cpu,
  Globe,
  HardDrive,
  MemoryStick,
  Server as ServerIcon,
  Terminal,
} from 'lucide-react'
import type { ReactNode } from 'react'

import type { EventItem, Metric, Server } from './api'
import { levelOf, type Health } from './health'
import { StatusDot } from './meter'
import { Badge, Card } from './ui'

/*
 * 单服务器独立监控卡片。
 *
 * 每一台服务器独占一张卡片，展现各自的：
 * 1. 标题区：服务器名称、在线/离线状态指示、IP/主机名、操作系统与 CPU/内存规格
 * 2. 状态带：过去 24 小时状态色带（24格，每小时一格，展现离线或最严重的资源水位）
 * 3. 核心资源条：CPU、内存、磁盘、Swap 的百分比进度条与具体数值量纲
 * 4. 统计与操作：1/5/15 分钟负载、最后活跃时间与终端/详情快捷动作
 */

export interface ServerCardProps {
  server: Server
  metric?: Metric
  history?: Metric[]
  unackedEvents?: EventItem[]
  onSelectServer?: (server: Server) => void
  onOpenTerminal?: (server: Server) => void
}

/** 评估单个时间桶的健康度（按 CPU/内存/磁盘中最高者计算，缺数据置为 null） */
function getBucketHealth(m?: Metric): Health | 'empty' {
  if (!m) return 'empty'
  const cpu = m.cpu_percent
  const mem = m.mem_used_mb && m.mem_total_mb ? (m.mem_used_mb / m.mem_total_mb) * 100 : null
  const disk = m.disk_used_gb && m.disk_total_gb ? (m.disk_used_gb / m.disk_total_gb) * 100 : null

  const pcts = [cpu, mem, disk].filter((v): v is number => v !== null && !Number.isNaN(v))
  if (pcts.length === 0) return 'empty'
  const max = Math.max(...pcts)
  return levelOf(max)
}

/** 资源仪表进度条项 */
function MetricBarRow({
  label,
  icon,
  percent,
  detail,
  warn = 70,
  crit = 85,
}: {
  label: string
  icon: ReactNode
  percent: number | null
  detail?: string
  warn?: number
  crit?: number
}) {
  const hasValue = percent !== null && Number.isFinite(percent)
  const pct = hasValue ? Math.max(0, Math.min(100, percent as number)) : 0

  let barColor = 'bg-ink-success'
  let textColor = 'text-ink'
  if (pct >= crit) {
    barColor = 'bg-ink-danger'
    textColor = 'text-ink-danger font-semibold'
  } else if (pct >= warn) {
    barColor = 'bg-ink-warning'
    textColor = 'text-ink-warning font-semibold'
  }

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between text-xs">
        <span className="flex items-center gap-1.5 text-ink-secondary">
          <span className="text-ink-tertiary">{icon}</span>
          <span>{label}</span>
        </span>
        <span className="flex items-center gap-2">
          {detail ? <span className="text-[11px] text-ink-tertiary">{detail}</span> : null}
          <span className={`mono text-right text-[12px] tabular-nums ${textColor}`}>
            {hasValue ? `${pct.toFixed(1)}%` : '—'}
          </span>
        </span>
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-overlay-medium">
        <div
          className={`h-full rounded-full transition-all duration-300 ${barColor}`}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  )
}

export function ServerCard({
  server,
  metric,
  history = [],
  unackedEvents = [],
  onSelectServer,
  onOpenTerminal,
}: ServerCardProps) {
  const online = server.status === 'online'
  const serverEvents = unackedEvents.filter((e) => e.server_id === server.id)
  const isBad = serverEvents.some((e) => e.level === 'critical') || !online
  const isWarn = serverEvents.some((e) => e.level === 'warning')

  const memPct =
    metric?.mem_used_mb && metric?.mem_total_mb
      ? (metric.mem_used_mb / metric.mem_total_mb) * 100
      : null
  const diskPct =
    metric?.disk_used_gb && metric?.disk_total_gb
      ? (metric.disk_used_gb / metric.disk_total_gb) * 100
      : null
  const swapPct =
    metric?.swap_total_mb && metric.swap_total_mb > 0 && metric?.swap_used_mb != null
      ? (metric.swap_used_mb / metric.swap_total_mb) * 100
      : null

  // 格式化内存与磁盘已用量
  const memDetail =
    metric?.mem_used_mb && metric?.mem_total_mb
      ? `${(metric.mem_used_mb / 1024).toFixed(1)} / ${(metric.mem_total_mb / 1024).toFixed(1)} GB`
      : undefined

  const diskDetail =
    metric?.disk_used_gb && metric?.disk_total_gb
      ? `${metric.disk_used_gb.toFixed(0)} / ${metric.disk_total_gb.toFixed(0)} GB`
      : undefined

  // 补齐 24 个点
  const buckets = Array.from({ length: 24 }).map((_, i) => {
    const item = history[i]
    return getBucketHealth(item)
  })

  return (
    <Card
      padded={false}
      className={`group flex flex-col justify-between overflow-hidden border transition-all duration-150 hover:border-line-strong hover:shadow-sm ${
        isBad ? 'border-line-danger/40' : isWarn ? 'border-line-strong' : ''
      }`}
    >
      {/* 头部：名称与状态信息 */}
      <div className="border-b border-line bg-secondary/30 px-4 py-3">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <StatusDot state={online ? 'good' : 'crit'} />
              <button
                type="button"
                onClick={() => onSelectServer?.(server)}
                className="cursor-pointer truncate text-[14px] font-semibold text-ink transition-colors hover:text-accent hover:underline"
                title={server.name}
              >
                {server.name}
              </button>
              {serverEvents.length > 0 ? (
                <Badge tone={isBad ? 'bad' : 'warn'}>{serverEvents.length} 告警</Badge>
              ) : null}
            </div>

            <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11.5px] text-ink-tertiary">
              <span className="mono flex items-center gap-1">
                <Globe className="size-3 shrink-0" />
                {server.ip || server.hostname || '—'}
              </span>
              {server.os_info ? (
                <span className="truncate" title={server.os_info}>
                  {server.os_info}
                </span>
              ) : null}
              {server.cpu_cores ? <span>{server.cpu_cores} 核</span> : null}
              {server.mem_total_mb ? (
                <span>{(server.mem_total_mb / 1024).toFixed(1)} GB</span>
              ) : null}
            </div>
          </div>

          <div className="flex shrink-0 items-center gap-1">
            {server.terminal_enabled && onOpenTerminal ? (
              <button
                type="button"
                onClick={() => onOpenTerminal(server)}
                className="flex size-7 cursor-pointer items-center justify-center rounded-md border border-line bg-primary text-ink-tertiary transition-colors hover:bg-overlay-light hover:text-ink"
                title="打开终端"
                aria-label="打开终端"
              >
                <Terminal className="size-3.5" />
              </button>
            ) : null}
            <button
              type="button"
              onClick={() => onSelectServer?.(server)}
              className="flex size-7 cursor-pointer items-center justify-center rounded-md border border-line bg-primary text-ink-tertiary transition-colors hover:bg-overlay-light hover:text-accent"
              title="查看详情"
              aria-label="查看详情"
            >
              <ServerIcon className="size-3.5" />
            </button>
          </div>
        </div>
      </div>

      {/* 24 小时状态条 */}
      <div className="border-b border-line bg-primary px-4 py-2">
        <div className="mb-1 flex items-center justify-between text-[11px] text-ink-tertiary">
          <span>近 24 小时运行状态</span>
          <span className="mono">
            {online ? (
              <span className="text-ink-success">在线</span>
            ) : (
              <span className="text-ink-danger">离线</span>
            )}
          </span>
        </div>
        <div className="flex h-3 w-full gap-0.5 overflow-hidden rounded-xs bg-overlay-light p-0.5" title="每格代表一小时，颜色代表该时段最高负载等级">
          {buckets.map((b, idx) => {
            let bg = 'bg-overlay-medium'
            if (b === 'ok') bg = 'bg-ink-success'
            else if (b === 'warn') bg = 'bg-ink-warning'
            else if (b === 'bad') bg = 'bg-ink-danger'
            else if (!online && idx >= 20) bg = 'bg-ink-danger/70'

            return (
              <span
                key={idx}
                className={`h-full flex-1 rounded-[1px] transition-colors ${bg}`}
              />
            )
          })}
        </div>
      </div>

      {/* 核心指标进度条 */}
      <div className="flex flex-col gap-2.5 p-4">
        <MetricBarRow
          label="CPU"
          icon={<Cpu className="size-3.5" />}
          percent={metric?.cpu_percent ?? null}
        />
        <MetricBarRow
          label="内存"
          icon={<MemoryStick className="size-3.5" />}
          percent={memPct}
          detail={memDetail}
        />
        <MetricBarRow
          label="磁盘"
          icon={<HardDrive className="size-3.5" />}
          percent={diskPct}
          detail={diskDetail}
          crit={92}
        />
        {swapPct !== null && metric?.swap_total_mb && metric.swap_total_mb > 0 ? (
          <MetricBarRow
            label="Swap"
            icon={<span className="text-[10px] font-bold">⇄</span>}
            percent={swapPct}
            detail={
              metric?.swap_used_mb != null
                ? `${(metric.swap_used_mb / 1024).toFixed(1)} / ${(metric.swap_total_mb / 1024).toFixed(1)} GB`
                : undefined
            }
          />
        ) : null}
      </div>

      {/* 卡片底栏：负载与最后上报 */}
      <div className="flex items-center justify-between border-t border-line bg-secondary/15 px-4 py-2 text-[11.5px] text-ink-tertiary">
        <div className="flex items-center gap-1.5">
          <span>负载</span>
          <span className="mono font-medium text-ink-secondary">
            {metric?.load_1 != null
              ? `${metric.load_1.toFixed(2)} / ${metric.load_5?.toFixed(2) ?? '—'} / ${metric.load_15?.toFixed(2) ?? '—'}`
              : '—'}
          </span>
        </div>
        <div>
          {metric?.captured_at ? (
            <span
              className="tnum"
              title={new Date(metric.captured_at).toLocaleString('zh-CN')}
            >
              {new Date(metric.captured_at).toLocaleTimeString('zh-CN', {
                hour: '2-digit',
                minute: '2-digit',
              })}
            </span>
          ) : (
            '无指标'
          )}
        </div>
      </div>
    </Card>
  )
}
