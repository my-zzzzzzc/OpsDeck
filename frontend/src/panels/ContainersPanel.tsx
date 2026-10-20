import {
  createColumnHelper,
  flexRender,
  getCoreRowModel,
  getSortedRowModel,
  useReactTable,
  type SortingState,
} from '@tanstack/react-table'
import { ArrowDown, ArrowUp, Boxes, ChevronsUpDown, ScrollText, Search, X } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'

import { api, type InstanceDetail, type Server, type User } from '../api'
import { cn } from '../cn'
import { PageSkeleton } from '../motion'
import { Card } from '../ui'
import { ContainerLogDrawer } from './ContainerLogDrawer'

/*
 * 「容器」页。
 *
 * 与仪表板上那块容器看板的**分工**:
 *   仪表板 —— 扫一眼,知道"整体还活着吗"。卡片墙,信息浅。
 *   这一页 —— 查问题。表格、可排序、可筛选,并且能点开日志。
 *
 * 所以这里默认用表格而不是卡片:排查时用户手里通常有一个具体问题
 * ("哪个容器吃了 450MB""worker 是不是挂了"),需要的是**对比**,
 * 而卡片网格里数值不对齐,对比只能靠眼睛来回跳。
 */

/** 容器状态分类。与 ContainerBoard 保持同一套语义。 */
type Bucket = 'running' | 'unhealthy' | 'stopped' | 'done'

function isOneShot(name: string): boolean {
  const lowered = name.toLowerCase()
  return ['init', 'migrat', 'setup', 'provision'].some((m) => lowered.includes(m))
}

function bucketOf(c: InstanceDetail): Bucket {
  const state = (c.state ?? '').toLowerCase()
  if (state !== 'running') return isOneShot(c.name) ? 'done' : 'stopped'
  if ((c.health ?? '').toLowerCase() === 'unhealthy') return 'unhealthy'
  return 'running'
}

const BUCKET_TEXT: Record<Bucket, string> = {
  running: '运行中',
  unhealthy: '不健康',
  stopped: '已停止',
  done: '已完成',
}

const BUCKET_DOT: Record<Bucket, string> = {
  running: 'bg-ink-success',
  unhealthy: 'bg-ink-warning',
  stopped: 'bg-ink-danger',
  done: 'bg-ink-tertiary',
}

/** 表格行:容器 + 它的显示字段。 */
interface Row extends InstanceDetail {
  bucket: Bucket
}

const col = createColumnHelper<Row>()

export function ContainersPanel({ user }: { user: User }) {
  const [containers, setContainers] = useState<InstanceDetail[]>([])
  const [servers, setServers] = useState<Server[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [query, setQuery] = useState('')
  const [bucket, setBucket] = useState<Bucket | 'all'>('all')
  const [serverFilter, setServerFilter] = useState<string>('all')
  const [sorting, setSorting] = useState<SortingState>([{ id: 'mem', desc: true }])

  /** 正在看日志的容器。null 表示抽屉关闭。 */
  const [logTarget, setLogTarget] = useState<InstanceDetail | null>(null)

  const isAdmin = user.role === 'admin'

  const load = useCallback(async () => {
    try {
      const [c, s] = await Promise.all([api.instancesDetail(), api.servers()])
      setContainers(c)
      setServers(s)
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

  const counts = useMemo(() => {
    const out = { running: 0, unhealthy: 0, stopped: 0, done: 0 }
    for (const c of containers) out[bucketOf(c)] += 1
    return out
  }, [containers])

  const rows = useMemo<Row[]>(() => {
    const q = query.trim().toLowerCase()
    return containers
      .filter((c) => {
        if (bucket !== 'all' && bucketOf(c) !== bucket) return false
        if (serverFilter !== 'all' && c.server_id !== serverFilter) return false
        if (!q) return true
        return [c.name, c.project_name, c.image, c.server_name]
          .filter((v): v is string => !!v)
          .some((v) => v.toLowerCase().includes(q))
      })
      .map((c) => ({ ...c, bucket: bucketOf(c) }))
  }, [containers, query, bucket, serverFilter])

  const columns = useMemo(
    () => [
      col.accessor('bucket', {
        header: () => <span className="text-[11px] font-medium text-ink-tertiary">状态</span>,
        size: 90,
        cell: ({ row }) => (
          <span className="flex items-center gap-1.5" title={`state=${row.original.state ?? '—'}`}>
            <span className={cn('size-1.5 shrink-0 rounded-full', BUCKET_DOT[row.original.bucket])} />
            <span className="truncate text-[12px] text-ink-secondary">{BUCKET_TEXT[row.original.bucket]}</span>
          </span>
        ),
      }),
      col.accessor('name', {
        header: () => <span className="text-[11px] font-medium text-ink-tertiary">容器</span>,
        cell: ({ getValue }) => (
          <span className="mono truncate text-[12.5px] text-ink" title={getValue()}>
            {getValue()}
          </span>
        ),
      }),
      col.accessor('image', {
        header: () => <span className="text-[11px] font-medium text-ink-tertiary">镜像</span>,
        cell: ({ getValue }) => (
          <span className="mono truncate text-[11.5px] text-ink-tertiary" title={getValue() ?? ''}>
            {getValue() ?? '—'}
          </span>
        ),
      }),
      col.accessor('project_name', {
        header: () => <span className="text-[11px] font-medium text-ink-tertiary">项目</span>,
        size: 110,
        cell: ({ getValue }) => (
          <span className="truncate text-[12px] text-ink-secondary">{getValue() ?? '—'}</span>
        ),
      }),
      col.accessor('server_name', {
        header: () => <span className="text-[11px] font-medium text-ink-tertiary">服务器</span>,
        size: 150,
        cell: ({ getValue }) => (
          <span className="truncate text-[12px] text-ink-tertiary" title={getValue() ?? ''}>
            {getValue() ?? '—'}
          </span>
        ),
      }),
      col.accessor('mem_used_mb', {
        id: 'mem',
        header: () => <span className="text-[11px] font-medium text-ink-tertiary">内存</span>,
        size: 100,
        sortDescFirst: true,
        /*
         * 缺失值恒排最后,两个方向都是。
         *
         * 已停止的容器没有内存读数(采集器只在 running 时查 stats)。
         * 默认排序会把 null 当成最小的值,于是"按内存降序"看完是
         * 451MB → 447MB → … → — → —,那些"—"占据末尾没问题;
         * 但升序时就变成 — → — → 6MB → …,用户想看"谁最省内存"
         * 却先看到一堆没有数据的行。排序的意义是比大小,
         * 没有值的东西不该参与比较。
         */
        sortingFn: (a, b, id) => {
          // null 表示"没有读数",不是 0。手动把它压到最后,两个方向都成立。
          const va = a.getValue<number | null>(id)
          const vb = b.getValue<number | null>(id)
          if (va == null && vb == null) return 0
          if (va == null) return 1
          if (vb == null) return -1
          return va - vb
        },
        cell: ({ getValue }) => {
          const v = getValue()
          return (
            <span className="tnum text-right text-[12px] text-ink-secondary">
              {v != null ? `${v} MB` : '—'}
            </span>
          )
        },
      }),
      col.display({
        id: 'actions',
        header: () => <span className="text-[11px] font-medium text-ink-tertiary">操作</span>,
        size: 90,
        cell: ({ row }) =>
          isAdmin ? (
            <div className="flex justify-end">
              {/*
                用原生 button 而不是 GhostButton(HeroUI):
                后者靠 onPress,在 table 单元格里实测不触发 ——
                按钮本身可点、无遮挡,但回调不执行。表格是这一页的主交互,
                不值得为复用组件在这里赌行为差异,原生元素最可控。
              */}
              <button
                type="button"
                onClick={() => setLogTarget(row.original)}
                className="flex h-6 cursor-pointer items-center gap-1 rounded-sm border-[0.5px] border-line bg-primary px-2 text-[11px] font-medium text-ink-secondary transition-colors hover:bg-overlay-light hover:text-ink"
              >
                <ScrollText className="size-3" />
                日志
              </button>
            </div>
          ) : null,
      }),
    ],
    [isAdmin],
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

  const filters: Array<{ key: Bucket | 'all'; label: string; n: number }> = [
    { key: 'all', label: '全部', n: containers.length },
    { key: 'running', label: BUCKET_TEXT.running, n: counts.running },
    { key: 'unhealthy', label: BUCKET_TEXT.unhealthy, n: counts.unhealthy },
    { key: 'stopped', label: BUCKET_TEXT.stopped, n: counts.stopped },
    { key: 'done', label: BUCKET_TEXT.done, n: counts.done },
  ]

  return (
    <>
      {/* 工具条:搜索 + 状态筛选 + 服务器筛选 + 数量 */}
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="relative min-w-0 flex-1 sm:max-w-[260px]">
          <Search className="pointer-events-none absolute start-2.5 top-1/2 size-3.5 -translate-y-1/2 text-ink-tertiary" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索容器 / 镜像 / 项目 / 服务器"
            aria-label="搜索容器"
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
          {filters.map((f) => {
            const active = bucket === f.key
            return (
              <button
                key={f.key}
                type="button"
                onClick={() => setBucket(f.key)}
                className={cn(
                  'flex h-8 cursor-pointer items-center gap-1.5 rounded-md border px-2.5 text-[11.5px] transition-colors',
                  active
                    ? 'border-line-strong bg-overlay-light font-medium text-ink'
                    : 'border-line bg-primary text-ink-secondary hover:bg-overlay-lighter',
                )}
              >
                {f.label}
                <span className={cn('tnum text-[10.5px]', active ? 'text-ink' : 'text-ink-tertiary')}>
                  {f.n}
                </span>
              </button>
            )
          })}
        </div>

        <select
          value={serverFilter}
          onChange={(e) => setServerFilter(e.target.value)}
          aria-label="按服务器筛选"
          className="h-8 cursor-pointer rounded-md border border-line bg-primary px-2.5 text-[12px] text-ink outline-none focus:border-accent"
        >
          <option value="all">全部服务器</option>
          {servers.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>

        {query || bucket !== 'all' || serverFilter !== 'all' ? (
          <span className="text-[11.5px] text-ink-tertiary">
            {rows.length} / {containers.length}
          </span>
        ) : null}
      </div>

      {/* 表格 */}
      {containers.length === 0 ? (
        <Card className="py-12 text-center">
          <Boxes className="mx-auto mb-2 size-6 text-ink-tertiary" />
          <p className="text-[13px] text-ink-secondary">还没有采集到任何容器</p>
          <p className="mt-1 text-[11.5px] text-ink-tertiary">
            采集器每 30 秒上报一次;容器只有在「部署」页登记了对应项目后才会被纳入。
          </p>
        </Card>
      ) : rows.length === 0 ? (
        <Card className="py-12 text-center">
          <p className="text-[13px] text-ink-secondary">没有匹配的容器</p>
          <button
            type="button"
            onClick={() => {
              setQuery('')
              setBucket('all')
              setServerFilter('all')
            }}
            className="mt-2 cursor-pointer text-[11.5px] text-accent hover:underline"
          >
            清除筛选条件
          </button>
        </Card>
      ) : (
        <Card padded={false} className="overflow-hidden">
          <table className="w-full table-fixed border-collapse">
            <thead className="sticky top-0 z-10 bg-primary">
              {table.getHeaderGroups().map((hg) => (
                <tr key={hg.id} className="border-b border-line">
                  {hg.headers.map((h) => {
                    const sortable = h.column.getCanSort()
                    const dir = h.column.getIsSorted()
                    return (
                      <th
                        key={h.id}
                        style={{ width: h.getSize() || undefined }}
                        className="px-3 py-2 text-left font-normal"
                      >
                        {sortable ? (
                          <button
                            type="button"
                            onClick={h.column.getToggleSortingHandler()}
                            className="flex cursor-pointer items-center gap-1 text-[11px] font-medium text-ink-tertiary transition-colors hover:text-ink"
                          >
                            {flexRender(h.column.columnDef.header, h.getContext())}
                            {dir === 'asc' ? (
                              <ArrowUp className="size-3" />
                            ) : dir === 'desc' ? (
                              <ArrowDown className="size-3" />
                            ) : (
                              <ChevronsUpDown className="size-3 opacity-40" />
                            )}
                          </button>
                        ) : (
                          flexRender(h.column.columnDef.header, h.getContext())
                        )}
                      </th>
                    )
                  })}
                </tr>
              ))}
            </thead>
            <tbody>
              {table.getRowModel().rows.map((row) => (
                <tr
                  key={row.id}
                  className="border-b border-line last:border-0 transition-colors hover:bg-overlay-lighter"
                >
                  {row.getVisibleCells().map((cell) => (
                    <td key={cell.id} className="px-3 py-2">
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}

      {/* 日志抽屉 */}
      {logTarget ? (
        <ContainerLogDrawer container={logTarget} onClose={() => setLogTarget(null)} />
      ) : null}
    </>
  )
}

/** 供外部引用的桶判定(仪表板等处复用同一套语义)。 */
export { bucketOf as containerBucket }
