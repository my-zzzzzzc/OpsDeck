import {
  AlertTriangle,
  Boxes,
  CheckCircle2,
  ChevronRight,
  CircleSlash,
  MemoryStick,
  Search,
  Server as ServerIcon,
  X,
} from 'lucide-react'
import { useMemo, useState } from 'react'

import type { InstanceDetail } from './api'
import { cn } from './cn'
import { Card } from './ui'

/*
 * 容器看板。
 *
 * 汇总**所有服务器**上被采集到的容器,回答三个问题:
 *   1. 一共有多少、几个在跑、几个有问题
 *   2. 哪个容器最吃内存
 *   3. 某个具体的容器在哪台机器、哪个项目里
 *
 * 三个设计取舍:
 *
 * 1. **状态以 Docker 的 state 与 health 分开展示,不合并成一个"健康"**。
 *    `state=running` 但 `health=unhealthy` 是真实存在且最值得看的一类
 *    (进程活着但不 Healthy),合并成一个徽标就会把这种半死状态吃掉。
 *
 * 2. **内存用量没有上限时不画百分比条**。采集器只对设了 `--memory` 的容器
 *    返回 mem_limit_mb,没设时是 null。把 null 当 0 会画出一条永远满格的假条,
 *    当 100% 又会画出一条空的假条 —— 两种都是撒谎。所以这里只在有限额时
 *    画占比,否则只给绝对值。
 *
 * 3. **按服务器分组,而不是拍平成一长串**。容器看板的用途是"哪台机器上
 *    有什么",拍平之后就只剩"有什么",机器维度就丢了。
 */

/** 容器的展示分类。把 Docker 的一堆 state 归成运维真正关心的四类。 */
export type ContainerBucket = 'running' | 'unhealthy' | 'stopped' | 'done'

/**
 * 一次性任务容器(init_permissions / migrate / 建表脚本这类)
 * 跑完退出是它的**正常生命周期**。把它标成「已停止」并计入"需要关注",
 * 每天都在制造一条假异常 —— 假异常看多了,真异常也会被划过去。
 *
 * 判断只能靠名字,与后端 ingest 的启发式保持同一套词表:
 * 采集器不上报 exit_code,所以"退出码为 0 即正常"在这里不可用。
 */
export function isOneShot(name: string): boolean {
  const lowered = name.toLowerCase()
  return ['init', 'migrat', 'setup', 'provision'].some((m) => lowered.includes(m))
}

export function bucketOf(c: InstanceDetail): ContainerBucket {
  const state = (c.state ?? '').toLowerCase()
  const health = (c.health ?? '').toLowerCase()

  // 没跑起来的:一次性容器归「已完成」,其余归「已停止」
  if (state !== 'running') return isOneShot(c.name) ? 'done' : 'stopped'

  // 跑着但 health 明确不健康:这是最该被看见的一类
  if (health === 'unhealthy') return 'unhealthy'

  return 'running'
}

const BUCKET_LABEL: Record<ContainerBucket, string> = {
  running: '运行中',
  unhealthy: '不健康',
  stopped: '已停止',
  done: '已完成',
}

const BUCKET_TONE: Record<ContainerBucket, { dot: string; text: string; chip: string }> = {
  running: {
    dot: 'bg-ink-success',
    text: 'text-ink-success',
    chip: 'bg-tint-success text-ink-success',
  },
  unhealthy: {
    dot: 'bg-ink-warning',
    text: 'text-ink-warning',
    chip: 'bg-tint-orange text-ink-warning',
  },
  stopped: {
    dot: 'bg-ink-danger',
    text: 'text-ink-danger',
    chip: 'bg-tint-danger text-ink-danger',
  },
  done: {
    dot: 'bg-ink-tertiary',
    text: 'text-ink-tertiary',
    chip: 'bg-overlay-light text-ink-tertiary',
  },
}

export function ContainerBoard({
  containers,
  error,
}: {
  containers: InstanceDetail[]
  error?: string | null
}) {
  const [query, setQuery] = useState('')
  const [bucket, setBucket] = useState<ContainerBucket | 'all'>('all')

  /*
   * 折叠状态按服务器名记,默认全部展开但记住用户的选择。
   *
   * 存「被折叠掉的」而不是「被展开的」:新接入一台服务器时它默认是展开的,
   * 用户不需要先找到它再点开 —— 新东西应该主动出现,而不是藏在菜单里。
   */
  const [collapsedServers, setCollapsedServers] = useState<Set<string>>(new Set())

  const toggleServer = (name: string) => {
    setCollapsedServers((prev) => {
      const next = new Set(prev)
      if (next.has(name)) next.delete(name)
      else next.add(name)
      return next
    })
  }

  const counts = useMemo(() => {
    const out = { running: 0, unhealthy: 0, stopped: 0, done: 0 }
    for (const c of containers) out[bucketOf(c)] += 1
    return out
  }, [containers])

  /*
   * 内存最高的容器。
   *
   * 替代原来的「内存合计」:把几十个容器的 MB 相加得不到任何可行动的结论
   * (它既不等于机器可用内存,也不能和任何阈值比较)。而"谁最吃内存"
   * 是能直接转化成动作的 —— 机器变紧时,先看的就是这一个。
   */
  const topMem = useMemo(() => {
    let best: InstanceDetail | null = null
    for (const c of containers) {
      if (c.state !== 'running' || c.mem_used_mb == null) continue
      if (!best || c.mem_used_mb > (best.mem_used_mb ?? 0)) best = c
    }
    return best
  }, [containers])

  const serverCount = useMemo(
    () => new Set(containers.map((c) => c.server_id ?? c.server_name ?? '?')).size,
    [containers],
  )

  /*
   * 过滤后的容器,按服务器分组。
   *
   * 搜索同时匹配容器名、项目名、镜像与服务器名 —— 运维找东西时
   * 手上可能只有其中任意一个("那个跑 grok 的""阿里云上那个 nginx")。
   */
  const groups = useMemo(() => {
    const q = query.trim().toLowerCase()
    const kept = containers.filter((c) => {
      if (bucket !== 'all' && bucketOf(c) !== bucket) return false
      if (!q) return true
      return [c.name, c.project_name, c.image, c.server_name]
        .filter((v): v is string => !!v)
        .some((v) => v.toLowerCase().includes(q))
    })

    const map = new Map<string, { serverName: string; items: InstanceDetail[] }>()
    for (const c of kept) {
      const key = c.server_id ?? c.server_name ?? 'unknown'
      const g = map.get(key) ?? { serverName: c.server_name ?? '未知服务器', items: [] }
      g.items.push(c)
      map.set(key, g)
    }

    // 组内按状态排序(问题优先,已完成的一次性容器垫底),同状态按名字
    const rank = (c: InstanceDetail) =>
      ({ unhealthy: 0, stopped: 1, running: 2, done: 3 })[bucketOf(c)]
    for (const g of map.values()) {
      g.items.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name))
    }

    return [...map.values()].sort((a, b) => a.serverName.localeCompare(b.serverName))
  }, [containers, query, bucket])

  const shown = groups.reduce((a, g) => a + g.items.length, 0)

  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Boxes className="size-4 shrink-0 text-ink-tertiary" />
          <h2 className="text-[14px] font-semibold text-ink">全部容器</h2>
          <span className="rounded-xs bg-overlay-light px-1.5 py-0.5 text-[11px] text-ink-tertiary">
            {serverCount} 台服务器 · {containers.length} 个容器
          </span>
        </div>
        <span className="text-[11.5px] text-ink-tertiary">
          按服务器分组;点击行内的项目名可下钻
        </span>
      </div>

      {/*
        汇总信息条 + 筛选,合成一行。

        原来这里是"五个大方块"占满一整行(约 60px 高),每个方块里
        一个数字加一行小字 —— 但全部信息就是"23 个容器,20 个在跑,
        2 个要关注",一串文字就说得清。大格子把 60px 高度和整行宽度
        用来展示不足十个字,页面因此被撑长。

        改成单行紧凑条:左边是结论式摘要,右边直接是筛选按钮 ——
        摘要里的数字和筛选项本来就是同一组数,分两行是重复占位。
      */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        {/* 摘要:状态点 + 数字,一眼扫完 */}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          {[
            { n: containers.length, label: '总计', tone: 'text-ink' },
            { n: counts.running, label: '运行中', tone: 'text-ink-success' },
            {
              n: counts.unhealthy + counts.stopped,
              label: '需关注',
              tone: counts.unhealthy + counts.stopped > 0 ? 'text-ink-warning' : 'text-ink-tertiary',
            },
            { n: counts.done, label: '已完成', tone: 'text-ink-tertiary' },
          ].map((s) => (
            <span key={s.label} className="flex items-baseline gap-1">
              <span className={cn('tnum text-[13px] font-semibold', s.tone)}>{s.n}</span>
              <span className="text-[11px] text-ink-tertiary">{s.label}</span>
            </span>
          ))}

          {/* 内存最高的那个容器 —— 比"合计"有用得多 */}
          {topMem ? (
            <span className="hidden items-baseline gap-1 text-[11px] text-ink-tertiary sm:flex">
              <MemoryStick className="size-3 self-center" />
              <span className="truncate" title={`${topMem.name} · ${topMem.server_name ?? ''}`}>
                最高 <span className="tnum text-ink-secondary">{topMem.name}</span>{' '}
                <span className="tnum">{topMem.mem_used_mb} MB</span>
              </span>
            </span>
          ) : null}
        </div>

        {/* 筛选按钮:与上面的数字同源,所以放在同一行 */}
        <div className="ms-auto flex flex-wrap items-center gap-1.5">
          {/* 搜索:同一行内,窄屏时折到下一行 */}
          <div className="relative min-w-0">
            <Search className="pointer-events-none absolute start-2 top-1/2 size-3 -translate-y-1/2 text-ink-tertiary" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="搜索容器 / 项目 / 镜像"
              aria-label="搜索容器"
              className="h-6.5 w-44 rounded-md border border-line bg-primary ps-7 pe-6 text-[11.5px] text-ink outline-none transition-colors placeholder:text-ink-tertiary focus:border-accent"
            />
            {query ? (
              <button
                type="button"
                onClick={() => setQuery('')}
                aria-label="清空搜索"
                className="absolute end-1.5 top-1/2 -translate-y-1/2 cursor-pointer text-ink-tertiary hover:text-ink"
              >
                <X className="size-3" />
              </button>
            ) : null}
          </div>

          {(
            [
              { key: 'all' as const, label: '全部', n: containers.length },
              { key: 'running' as const, label: BUCKET_LABEL.running, n: counts.running },
              { key: 'unhealthy' as const, label: BUCKET_LABEL.unhealthy, n: counts.unhealthy },
              { key: 'stopped' as const, label: BUCKET_LABEL.stopped, n: counts.stopped },
              { key: 'done' as const, label: BUCKET_LABEL.done, n: counts.done },
            ] as const
          ).map((f) => {
            const active = bucket === f.key
            return (
              <button
                key={f.key}
                type="button"
                onClick={() => setBucket(f.key)}
                className={cn(
                  'flex h-6.5 cursor-pointer items-center gap-1 rounded-md border px-2 text-[11px] transition-colors',
                  active
                    ? 'border-line-strong bg-overlay-light font-medium text-ink'
                    : 'border-line bg-primary text-ink-secondary hover:bg-overlay-lighter',
                )}
              >
                {f.label}
                <span className={cn('tnum text-[10px]', active ? 'text-ink' : 'text-ink-tertiary')}>{f.n}</span>
              </button>
            )
          })}
        </div>

        {query || bucket !== 'all' ? (
          <span className="text-[11px] text-ink-tertiary">
            {shown} / {containers.length}
          </span>
        ) : null}
      </div>

      {error ? (
        <p className="rounded-md bg-tint-danger px-3 py-2 text-[12px] text-ink-danger">{error}</p>
      ) : null}

      {containers.length === 0 ? (
        <Card className="py-10 text-center">
          <Boxes className="mx-auto mb-2 size-6 text-ink-tertiary" />
          <p className="text-[13px] text-ink-secondary">还没有采集到任何容器</p>
          <p className="mt-1 text-[11.5px] text-ink-tertiary">
            采集器每 30 秒上报一次;容器只有在「项目」页登记了对应项目后才会被纳入。
          </p>
        </Card>
      ) : shown === 0 ? (
        <Card className="py-10 text-center">
          <p className="text-[13px] text-ink-secondary">没有匹配的容器</p>
          <button
            type="button"
            onClick={() => {
              setQuery('')
              setBucket('all')
            }}
            className="mt-2 cursor-pointer text-[11.5px] text-accent hover:underline"
          >
            清除筛选条件
          </button>
        </Card>
      ) : (
        <div className="flex flex-col gap-3">
          {groups.map((g) => {
            const problem = g.items.filter((c) => {
              const b = bucketOf(c)
              return b === 'unhealthy' || b === 'stopped'
            }).length
            const collapsed = collapsedServers.has(g.serverName)
            return (
              <Card key={g.serverName} padded={false} className="overflow-hidden">
                {/*
                  分组头本身就是折叠开关。
                  不额外放一个"展开/收起"按钮:整条都是标题栏,点哪里都行,
                  比去瞄准一个 12px 的箭头容易得多。
                */}
                <button
                  type="button"
                  onClick={() => toggleServer(g.serverName)}
                  aria-expanded={!collapsed}
                  className="flex w-full cursor-pointer items-center gap-2 border-b border-line bg-secondary/30 px-3.5 py-2 text-left transition-colors hover:bg-overlay-lighter"
                >
                  <ChevronRight
                    className={cn(
                      'size-3.5 shrink-0 text-ink-tertiary transition-transform duration-150',
                      collapsed ? '' : 'rotate-90',
                    )}
                  />
                  <ServerIcon className="size-3.5 shrink-0 text-ink-tertiary" />
                  <span className="truncate text-[12.5px] font-medium text-ink">{g.serverName}</span>
                  <span className="tnum shrink-0 rounded-xs bg-overlay-light px-1.5 text-[10.5px] text-ink-tertiary">
                    {g.items.length}
                  </span>
                  {problem > 0 ? (
                    <span className={cn('ms-auto flex shrink-0 items-center gap-1 text-[11px]', BUCKET_TONE.unhealthy.text)}>
                      <AlertTriangle className="size-3" />
                      {problem} 个需关注
                    </span>
                  ) : (
                    <span className="ms-auto flex shrink-0 items-center gap-1 text-[11px] text-ink-tertiary">
                      <CheckCircle2 className="size-3" />
                      全部正常
                    </span>
                  )}
                </button>

                {collapsed ? null : (
                  <div className="grid grid-cols-2 gap-2 p-2.5 sm:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5">
                    {g.items.map((c) => (
                      <ContainerCard key={c.id} container={c} />
                    ))}
                  </div>
                )}
              </Card>
            )
          })}
        </div>
      )}

      {/* 空状态的语义说明:0 个"不健康"不等于没问题 */}
      {containers.length > 0 && counts.unhealthy === 0 && counts.stopped === 0 ? (
        <p className="flex items-center gap-1.5 text-[11.5px] text-ink-tertiary">
          <CircleSlash className="size-3" />
          当前没有异常容器。缺少内存上限的容器只显示绝对值,不画占比条。
        </p>
      ) : null}
    </section>
  )
}

/**
 * 单个容器的小卡片。
 *
 * 为什么不用表格行:一屏 19 行的表格,每行只有 4 个短字段,
 * 横向却要跨满 1100px —— 视线每读一行都要从左扫到右再折回来,
 * 行与行之间还有大片空白。卡片把这些字段收进一个约 240px 的方块里,
 * 一屏能看到十几张,「哪个红了」是扫一眼就能得到结论的事。
 *
 * 卡片内的信息优先级:名字 > 状态 > 内存 > 项目 > 镜像。
 * 镜像放最后并截断,因为它通常很长,但它又是排查问题时必须能认出来的东西 ——
 * 所以截断而不是省略,完整值挂在 title 上。
 */
function ContainerCard({ container: c }: { container: InstanceDetail }) {
  const b = bucketOf(c)
  const tone = BUCKET_TONE[b]
  const hasLimit = c.mem_limit_mb != null && c.mem_limit_mb > 0
  const memPct =
    hasLimit && c.mem_used_mb != null
      ? Math.min(100, (c.mem_used_mb / (c.mem_limit_mb as number)) * 100)
      : null

  return (
    <div
      className={cn(
        'flex min-w-0 flex-col gap-1.5 rounded-md border-[0.5px] bg-primary px-2.5 py-2 transition-colors',
        b === 'running' ? 'border-line hover:border-line-strong' : 'border-line-warning/50',
      )}
      title={`${c.name}\n${c.image ?? ''}\nstate=${c.state ?? '—'} health=${c.health ?? '—'}`}
    >
      {/* 名称 + 状态灯 */}
      <div className="flex min-w-0 items-center gap-1.5">
        <span className={cn('size-1.5 shrink-0 rounded-full', tone.dot)} />
        <span className="truncate text-[12px] font-medium text-ink">{c.name}</span>
        {/*
          「运行中」不写出来。
          一片卡片里绝大多数是正常运行的,每张都印一遍「运行中」只会让人
          分不清哪张才要关注 —— 安静就是好消息,所以正常时只留那个绿点。
          异常的才用文字 + 颜色喊出来。
        */}
        {b !== 'running' ? (
          <span className={cn('ms-auto shrink-0 text-[10px] font-medium', tone.text)}>
            {BUCKET_LABEL[b]}
          </span>
        ) : null}
      </div>

      {/* 内存:有上限才画占比条 */}
      <div className="flex items-baseline justify-between gap-1 tabular-nums">
        <span className="truncate text-[10.5px] text-ink-tertiary" title={c.image ?? ''}>
          {c.project_name ?? '—'}
        </span>
        <span className="shrink-0 text-[11px] text-ink-secondary">
          {c.mem_used_mb != null ? `${c.mem_used_mb} MB` : '—'}
        </span>
      </div>

      {memPct !== null ? (
        <span className="block h-1 overflow-hidden rounded-full bg-overlay-medium">
          <span
            className={cn(
              'block h-full rounded-full',
              memPct >= 85 ? 'bg-ink-danger' : memPct >= 70 ? 'bg-ink-warning' : 'bg-ink-success',
            )}
            style={{ width: `${memPct}%` }}
          />
        </span>
      ) : null}
    </div>
  )
}
