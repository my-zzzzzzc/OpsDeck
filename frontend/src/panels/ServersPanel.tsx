import {
  createColumnHelper,
  flexRender,
  getCoreRowModel,
  getSortedRowModel,
  useReactTable,
  type SortingState,
} from '@tanstack/react-table'
import {
  type LucideIcon,
  ArrowDown,
  ArrowUp,
  ChevronsUpDown,
  Cpu,
  HardDrive,
  MemoryStick,
  Network,
  Wifi,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'

import { api, type Metric, type Project, type Server } from '../api'
import { PageSkeleton } from '../motion'
import { ColumnHeader, MeterCell, StatusDot, ValueCell, meterState } from '../meter'
import { Badge, Card, Empty, GhostButton, SectionTitle } from '../ui'
import { RemoteTerminalDialog } from './RemoteTerminalDialog'
import { ServerDetail } from './ServerDetail'
import { SshCredentialDialog } from './SshCredentialDialog'

/**
 * 服务器列表。
 *
 * 布局与交互规格参考 Beszel(26k star 的服务器监控):
 *   - 紧凑表格,行高 32px,一屏可容纳 20+ 台机器
 *   - 每列带图标,数值列用「定宽数值 + 细条」的组合,便于纵向扫读
 *   - 表头可点击排序,固定吸顶
 *
 * 用 TanStack Table 而非手写:排序、列宽、后续的虚拟滚动都由它承担。
 */

/** 表格行 = 服务器 + 它的最新指标 + 项目列表。 */
interface ServerRow {
  server: Server
  metric?: Metric
  projects: Project[]
}

const columnHelper = createColumnHelper<ServerRow>()

/** 可排序的表头。点击在 升序 → 降序 → 取消 之间循环。 */
function SortHeader({
  label,
  icon,
  sorted,
  onToggle,
  align = 'left',
}: {
  label: string
  icon?: LucideIcon
  sorted: false | 'asc' | 'desc'
  onToggle: () => void
  align?: 'left' | 'right'
}) {
  const Icon = sorted === 'asc' ? ArrowUp : sorted === 'desc' ? ArrowDown : ChevronsUpDown

  return (
    <button
      type="button"
      onClick={onToggle}
      className={`group flex w-full cursor-pointer items-center gap-1.5 text-[11px] font-medium text-ink-tertiary
        transition-colors hover:text-ink ${align === 'right' ? 'justify-end' : ''}`}
    >
      <ColumnHeader icon={icon} align={align}>
        {label}
      </ColumnHeader>
      <Icon
        size={11}
        className={`shrink-0 transition-opacity ${sorted ? 'opacity-100' : 'opacity-0 group-hover:opacity-50'}`}
      />
    </button>
  )
}

export function ServersPanel({ user }: { user: { role: string } }) {
  const [servers, setServers] = useState<Server[]>([])
  const [metrics, setMetrics] = useState<Metric[]>([])
  const [projects, setProjects] = useState<Project[]>([])
  const [sorting, setSorting] = useState<SortingState>([])
  const [active, setActive] = useState<Server | null>(null)
  const [detail, setDetail] = useState<Server | null>(null)
  /** 正在编辑 SSH 凭据的服务器。 */
  const [credTarget, setCredTarget] = useState<Server | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  const isAdmin = user.role === 'admin'

  const load = useCallback(async () => {
    try {
      const [s, m, p] = await Promise.all([api.servers(), api.latestMetrics(), api.projects()])
      setServers(s)
      setMetrics(m)
      setProjects(p)
      setError(null)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
    const timer = setInterval(() => void load(), 15_000)
    return () => clearInterval(timer)
  }, [load])

  const toggleTerminal = async (server: Server) => {
    try {
      await api.updateServer(server.id, { terminal_enabled: !server.terminal_enabled })
      await load()
    } catch (err) {
      setError((err as Error).message)
    }
  }

  const rows: ServerRow[] = useMemo(() => {
    const metricByServer = new Map(metrics.map((m) => [m.server_id, m]))
    const projectsByServer = new Map<string, Project[]>()
    for (const p of projects) {
      const list = projectsByServer.get(p.server_id) ?? []
      list.push(p)
      projectsByServer.set(p.server_id, list)
    }
    return servers.map((server) => ({
      server,
      metric: metricByServer.get(server.id),
      projects: projectsByServer.get(server.id) ?? [],
    }))
  }, [servers, metrics, projects])

  const columns = useMemo(
    () => [
      columnHelper.accessor((r) => r.server.name, {
        id: 'name',
        header: ({ column }) => (
          <SortHeader
            label="服务器"
            sorted={column.getIsSorted()}
            onToggle={() => column.toggleSorting()}
          />
        ),
        cell: ({ row }) => {
          const { server } = row.original
          const online = server.status === 'online'
          return (
            <div className="flex min-w-0 items-center gap-2">
              <StatusDot state={online ? 'good' : 'crit'} />
              <button
                type="button"
                onClick={() => setDetail(server)}
                className="cursor-pointer truncate text-[13px] font-medium text-ink transition-colors hover:text-accent hover:underline"
              >
                {server.name}
              </button>
              {server.terminal_enabled ? <Badge tone="warn">终端</Badge> : null}
            </div>
          )
        },
      }),

      columnHelper.accessor((r) => r.server.ip ?? r.server.hostname ?? '', {
        id: 'address',
        header: () => <ColumnHeader icon={Wifi}>地址</ColumnHeader>,
        cell: ({ getValue }) => (
          <span className="mono truncate text-[12px] text-ink-tertiary">{getValue() || '—'}</span>
        ),
      }),

      columnHelper.accessor((r) => r.metric?.cpu_percent ?? -1, {
        id: 'cpu',
        header: ({ column }) => (
          <SortHeader
            label="CPU"
            icon={Cpu}
            sorted={column.getIsSorted()}
            onToggle={() => column.toggleSorting()}
          />
        ),
        cell: ({ row }) => <MeterCell value={row.original.metric?.cpu_percent} />,
      }),

      columnHelper.accessor(
        (r) => {
          const m = r.metric
          if (!m?.mem_used_mb || !m?.mem_total_mb) return -1
          return (m.mem_used_mb / m.mem_total_mb) * 100
        },
        {
          id: 'memory',
          header: ({ column }) => (
            <SortHeader
              label="内存"
              icon={MemoryStick}
              sorted={column.getIsSorted()}
              onToggle={() => column.toggleSorting()}
            />
          ),
          cell: ({ row }) => {
            const m = row.original.metric
            const pct = m?.mem_used_mb && m?.mem_total_mb ? (m.mem_used_mb / m.mem_total_mb) * 100 : null
            return (
              <div className="flex items-center gap-2">
                <MeterCell value={pct} />
                {m?.mem_used_mb ? (
                  <span className="hidden shrink-0 text-[11px] text-ink-tertiary xl:inline">
                    {(m.mem_used_mb / 1024).toFixed(1)}G
                  </span>
                ) : null}
              </div>
            )
          },
        },
      ),

      columnHelper.accessor(
        (r) => {
          const m = r.metric
          if (!m?.swap_used_mb || !m?.swap_total_mb) return -1
          return (m.swap_used_mb / m.swap_total_mb) * 100
        },
        {
          id: 'swap',
          header: ({ column }) => (
            <SortHeader
              label="Swap"
              sorted={column.getIsSorted()}
              onToggle={() => column.toggleSorting()}
            />
          ),
          cell: ({ row }) => {
            const m = row.original.metric
            if (!m?.swap_total_mb) return <span className="text-[12px] text-ink-tertiary">—</span>
            const pct = ((m.swap_used_mb ?? 0) / m.swap_total_mb) * 100
            return <MeterCell value={pct} crit={90} />
          },
        },
      ),

      columnHelper.accessor(
        (r) => {
          const m = r.metric
          if (!m?.disk_used_gb || !m?.disk_total_gb) return -1
          return (m.disk_used_gb / m.disk_total_gb) * 100
        },
        {
          id: 'disk',
          header: ({ column }) => (
            <SortHeader
              label="磁盘"
              icon={HardDrive}
              sorted={column.getIsSorted()}
              onToggle={() => column.toggleSorting()}
            />
          ),
          cell: ({ row }) => {
            const m = row.original.metric
            const pct = m?.disk_used_gb && m?.disk_total_gb ? (m.disk_used_gb / m.disk_total_gb) * 100 : null
            return <MeterCell value={pct} crit={92} />
          },
        },
      ),

      columnHelper.accessor((r) => r.metric?.load_1 ?? -1, {
        id: 'load',
        header: ({ column }) => (
          <SortHeader
            label="负载"
            icon={Network}
            sorted={column.getIsSorted()}
            onToggle={() => column.toggleSorting()}
          />
        ),
        cell: ({ row }) => <ValueCell value={row.original.metric?.load_1} decimals={2} />,
      }),

      columnHelper.accessor((r) => r.projects.length, {
        id: 'projects',
        header: () => <ColumnHeader>项目</ColumnHeader>,
        cell: ({ row }) =>
          row.original.projects.length === 0 ? (
            <span className="text-[12px] text-ink-tertiary">—</span>
          ) : (
            <span className="truncate text-[12px] text-ink-secondary">
              {row.original.projects.map((p) => p.name).join('、')}
            </span>
          ),
      }),

      columnHelper.display({
        id: 'actions',
        header: () => <span className="text-[11px] font-medium text-ink-tertiary">操作</span>,
        cell: ({ row }) => {
          const { server } = row.original
          return (
            <div className="flex justify-end gap-1">
              {isAdmin && server.terminal_enabled ? (
                <GhostButton onClick={() => setActive(server)}>连接</GhostButton>
              ) : null}
              {isAdmin ? (
                <GhostButton onClick={() => setCredTarget(server)}>凭据</GhostButton>
              ) : null}
              {isAdmin ? (
                <GhostButton onClick={() => void toggleTerminal(server)}>
                  {server.terminal_enabled ? '关终端' : '开终端'}
                </GhostButton>
              ) : null}
            </div>
          )
        },
      }),
    ],
    [isAdmin, setCredTarget],
  )

  const table = useReactTable({
    data: rows,
    columns,
    state: { sorting },
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
  })

  if (loading) return <PageSkeleton />
  if (error) return <p className="py-16 text-center text-ink-danger">加载失败:{error}</p>

  // 详情视图:点击服务器名进入
  if (detail) {
    return (
      <ServerDetail
        server={detail}
        onBack={() => setDetail(null)}
        onOpenTerminal={() => setActive(detail)}
      />
    )
  }

  return (
    <>
      <SectionTitle
        aside={<span className="text-[11px] text-ink-tertiary">{servers.length} 台</span>}
      >
        服务器
      </SectionTitle>

      <Card padded={false} className="overflow-hidden">
        {servers.length === 0 ? (
          <div className="p-6">
            <Empty>还没有服务器。</Empty>
          </div>
        ) : (
          <div className="max-h-[calc(100vh-13rem)] overflow-auto">
            <table className="w-full border-collapse text-[13px]">
              {/* 表头吸顶:长列表滚动时列名始终可见 */}
              <thead className="sticky top-0 z-10 bg-primary">
                {table.getHeaderGroups().map((hg) => (
                  <tr key={hg.id} className="border-b border-line">
                    {hg.headers.map((header) => (
                      <th
                        key={header.id}
                        style={{ width: header.getSize() !== 150 ? header.getSize() : undefined }}
                        className="h-8 px-2 text-left align-middle font-medium whitespace-nowrap"
                      >
                        {header.isPlaceholder
                          ? null
                          : flexRender(header.column.columnDef.header, header.getContext())}
                      </th>
                    ))}
                  </tr>
                ))}
              </thead>

              <tbody>
                {table.getRowModel().rows.map((row) => {
                  const st = row.original.server.status
                  return (
                    <tr
                      key={row.id}
                      className={`h-8 border-b border-line transition-colors last:border-b-0
                        hover:bg-overlay-lighter ${st !== 'online' ? 'opacity-60' : ''}`}
                    >
                      {row.getVisibleCells().map((cell) => (
                        <td key={cell.id} className="h-8 max-h-8 px-2 align-middle">
                          <div className="flex h-8 items-center overflow-hidden">
                            {flexRender(cell.column.columnDef.cell, cell.getContext())}
                          </div>
                        </td>
                      ))}
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {active ? (
        <RemoteTerminalDialog
          server={active}
          onClose={() => {
            setActive(null)
            void load()
          }}
        />
      ) : null}

      {credTarget ? (
        <SshCredentialDialog
          server={credTarget}
          onClose={() => {
            setCredTarget(null)
            // 重新拉一次:用户名/端口可能已改,列表上的状态需要跟着更新
            void load()
          }}
        />
      ) : null}
    </>
  )
}

/** 供其他面板复用的阈值判定。 */
export { meterState }
