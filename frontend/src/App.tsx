import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import {
  api,
  type ActionCatalogItem,
  type EventItem,
  type InstanceDetail,
  type Metric,
  type Server,
  type User,
} from './api'
import { CHART_TIMES, type ChartPoint, type ChartTime } from './charts'
import { ContainerBoard } from './ContainerBoard'
import { DashboardHero, TrendCard } from './dashboard'
import { Card, GhostButton, IconButton, PageHeader } from './ui'
import { AuditPanel } from './panels/AuditPanel'
import { ChatPanel } from './panels/ChatPanel'
import { DifyPanel } from './panels/DifyPanel'
import { ContainersPanel } from './panels/ContainersPanel'
import { ProjectsPanel } from './panels/ProjectsPanel'
import { ServersPanel } from './panels/ServersPanel'
import { UsersPanel } from './panels/UsersPanel'
import {
  IconActivity,
  IconAlertOctagon,
  IconGauge,
  IconLogout,
  IconMenu,
  IconMoon,
  IconRefresh,
  IconSearch,
  IconSun,
  IconSunMoon,
} from './icons'
import { FadeIn, PageSkeleton } from './motion'
import { HeaderMetaProvider } from './header-meta'
import { NAV_GROUPS, NAV_ITEMS, TAB_META, type Tab } from './nav'
import { BlankPanel } from './panels/BlankPanel'
import { ServerDetail } from './panels/ServerDetail'
import { RemoteTerminalDialog } from './panels/RemoteTerminalDialog'
import { NotificationBell } from './NotificationBell'
import { Sidebar, SidebarDrawer } from './Sidebar'
import { THEME_ORDER, useTheme } from './theme'
import { ratio } from './health'

/*
 * 页签的定义搬到了 `nav.tsx`。
 *
 * 原来 Tab / TAB_META / ADMIN_TABS 三份东西都写在这个文件里,侧边栏和
 * 命令面板各读一遍 —— 加一个页签要改三处,漏一处就会出现
 * 「侧边栏有、搜不到」。现在导航注册表是唯一来源,这里只消费。
 */

/** 看板向应用层汇报的元信息,用于渲染页头的"实时 / 待处理 / 更新于 / 刷新"。 */
interface DashboardMeta {  lastUpdated: Date | null
  busy: boolean
  refresh: () => void
  /**
   * 最近一次拉取是否失败。
   *
   * 单独一个字段而不是复用 error 字符串:页头只需要知道"还能不能说实时",
   * 把整条错误消息搬上去只会让页头变成第二个错误提示区。
   */
  stale: boolean
}

/** 一条指标记录 → 图表数据点。内存/磁盘同时保留绝对值和百分比。 */
function toChartPoint(m: Metric): ChartPoint {
  return {
    created: new Date(m.captured_at).getTime(),
    cpu: m.cpu_percent,
    mem: m.mem_used_mb != null ? m.mem_used_mb / 1024 : null,
    mem_pct: ratio(m.mem_used_mb, m.mem_total_mb),
    swap: m.swap_used_mb != null ? m.swap_used_mb / 1024 : null,
    disk: m.disk_used_gb,
    disk_pct: ratio(m.disk_used_gb, m.disk_total_gb),
    load_1: m.load_1,
    load_5: m.load_5,
    load_15: m.load_15,
  }
}

/**
 * 首页看板。
 *
 * 三层,按回答顺序排:
 *   1. 状态卡(DashboardHero)——「有没有事」,锁定部署机,同时给出四项当前水位;
 *   2. 资源趋势(TrendCard)——「有多紧」,左侧服务器栏可切到任意一台;
 *   3. 容器状态(ContainerBoard)——「哪里有事」,汇总所有机器。
 *
 * 为什么部署机仍然是默认焦点:
 * 这一页首先要回答"我自己的服务跑得怎么样"。所以本机钉在服务器栏第一位、
 * 默认被选中;但趋势不再只画它 —— 另一台机器 CPU 打满也必须能被一键看到。
 * 机队均值会把一台快撑爆的磁盘平均成 40%,那种聚合不在这里做。
 */
function Dashboard({
  onMeta,
  alerts,
  onOpenContainers,
}: {
  onMeta: (meta: DashboardMeta) => void
  alerts: ReturnType<typeof useAlerts>
  onOpenContainers: () => void
}) {
  const { servers, unacked: unackedEvents } = alerts

  /*
   * 部署机的判定:先找 IP 命中 42.193.241.34 的,再退化到名字里带这个 IP 的。
   *
   * 不硬编码服务器 ID:资产表里的 ID 是 UUID,换库就变;
   * 而"哪台机器部署了本系统"这件事,写死在配置里比写死在代码里更合适。
   * 两个都匹配不到时,退化成"按 online 优先排序的第一台",并且界面上
   * 会明确写出当前选中的是哪一台 —— 绝不假装它就是部署机。
   */
  const DEPLOY_IP = '42.193.241.34'
  const host = useMemo(() => {
    const byIp = servers.find((s) => (s.ip ?? '').includes(DEPLOY_IP))
    if (byIp) return byIp
    const byName = servers.find((s) => s.name.includes(DEPLOY_IP))
    if (byName) return byName
    return (
      [...servers].sort((a, b) => {
        if (a.status === b.status) return a.name.localeCompare(b.name)
        return a.status === 'online' ? -1 : 1
      })[0] ?? null
    )
  }, [servers])

  const [metrics, setMetrics] = useState<Metric[]>([])
  const [containers, setContainers] = useState<InstanceDetail[]>([])
  const [containersError, setContainersError] = useState<string | null>(null)
  /**
   * 每台服务器的指标历史,按 server_id 索引。
   *
   * 趋势图不再只画部署机:运维看首页时,另一台机器的 CPU 打满同样需要被看见。
   * 这里按服务器分别拉取,共用同一个时间档位;单台失败不会清空其它台的历史。
   */
  const [histories, setHistories] = useState<Map<string, Metric[]>>(new Map())
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null)
  const [detailServer, setDetailServer] = useState<Server | null>(null)
  const [terminalServer, setTerminalServer] = useState<Server | null>(null)
  const [range, setRange] = useState<ChartTime>('24h')

  /**
   * 拉取看板所需的全部数据。
   *
   * showBusy 只在手动刷新时为真 —— 15 秒一次的轮询若也点亮加载态,
   * 页面会不停闪动,反而让人以为出问题了。
   *
   * 事件与服务器列表不在这里拉:它们来自应用层的 `useAlerts`,
   * 与页头铃铛同源。看板再拉一份就会出现"角标 3 条、读数格 2 条"。
   */
  const load = useCallback(async (showBusy = false) => {
    if (showBusy) setBusy(true)
    try {
      // 容器与指标各自失败不应拖垮另一半:容器看板是这次新加的,
      // 它挂了不该让整页变成错误页。
      const [m, c] = await Promise.allSettled([api.latestMetrics(), api.instancesDetail()])

      if (m.status === 'fulfilled') {
        setMetrics(m.value)
        setError(null)
        setLastUpdated(new Date())
      } else {
        setError((m.reason as Error).message)
      }

      if (c.status === 'fulfilled') {
        setContainers(c.value)
        setContainersError(null)
      } else {
        setContainersError((c.reason as Error).message)
      }
    } finally {
      if (showBusy) setBusy(false)
      setLoading(false)
    }
  }, [])

  /*
   * 服务器 id 的稳定签名。
   *
   * `servers` 每 15 秒会随告警轮询拿到一个新数组;直接把数组放进 useCallback
   * 依赖里,趋势历史就会从「5 分钟拉一次」变成「15 秒拉 N 次」。
   * 这里只依赖 id 集合,机器增删时才重新拉历史。
   */
  const serverIdsKey = useMemo(
    () => servers.map((s) => s.id).sort().join('|'),
    [servers],
  )

  /**
   * 拉取所有服务器的指标历史。
   *
   * 单独一条链路、单独一个节奏:趋势图 5 分钟更新一次就够了,
   * 跟 15 秒的轮询绑在一起是白拉几十倍的字节。
   * 用 allSettled 而不是 all:一台超时不该把另一台的曲线也清掉。
   */
  const loadHistories = useCallback(async () => {
    const ids = serverIdsKey ? serverIdsKey.split('|') : []
    if (ids.length === 0) return

    const points: Record<ChartTime, number> = { '1h': 60, '12h': 72, '24h': 96, '7d': 84, '30d': 90 }
    const results = await Promise.allSettled(
      ids.map((id) => api.metricHistory(id, CHART_TIMES[range].hours, points[range])),
    )

    setHistories((prev) => {
      const next = new Map(prev)
      results.forEach((r, i) => {
        if (r.status === 'fulfilled') next.set(ids[i], r.value)
      })
      return next
    })
  }, [serverIdsKey, range])

  useEffect(() => {
    void load(true)
    const timer = setInterval(() => void load(), 15_000)
    return () => clearInterval(timer)
  }, [load])

  useEffect(() => {
    void loadHistories()
    const timer = setInterval(() => void loadHistories(), 300_000)
    return () => clearInterval(timer)
  }, [loadHistories])

  // 把刷新能力交给页头,避免页头与内容区各放一个刷新按钮
  useEffect(() => {
    onMeta({
      lastUpdated,
      busy,
      refresh: () => {
        void load(true)
        void loadHistories()
      },
      // 拉取失败时页头不能继续说「实时」—— 那正是最需要它闭嘴的时候
      stale: error !== null,
    })
  }, [onMeta, lastUpdated, busy, load, loadHistories, error])

  /*
   * 下面两个 useMemo 必须在任何提前 return 之前。
   *
   * 这里踩过一次规则 Hooks 的坑:把 useMemo 放在 `if (loading)` 后面,
   * 加载态比就绪态少调用两个 Hook,React 会直接抛「Rendered more hooks
   * than during the previous render」并整页白屏,而 tsc / vite build 都不报错。
   */
  // 最新指标按服务器索引:趋势卡切换机器时,读数和曲线必须同一台
  const latestByServer = useMemo(
    () => new Map(metrics.map((m) => [m.server_id, m])),
    [metrics],
  )

  // 每台服务器的曲线数据。null 必须原样透传 —— 画成 0 会把"没采集到"读成"完全空闲"
  const pointsByServer = useMemo(() => {
    const map = new Map<string, ChartPoint[]>()
    for (const [id, list] of histories) map.set(id, list.map(toChartPoint))
    return map
  }, [histories])

  if (loading) return <PageSkeleton />

  /*
   * 只有「一次都没成功过」才整页报错。
   *
   * 轮询中途失败必须保留上一版数据:原来这里是无条件整页替换,
   * 于是 15 秒一次的轮询只要抖一下,整块看板就变成一张错误页 ——
   * 而那正是最需要看板的时候。现在失败退化成页头的一枚「已断开」标
   * 加一条说明条,数字仍是上一版的,并写清楚它是什么时候的。
   */
  if (error && lastUpdated === null) {
    return (
      <div className="flex flex-col items-center gap-2 py-16">
        <IconAlertOctagon size={20} className="text-ink-danger" />
        <p className="text-[13px] text-ink-secondary">加载失败:{error}</p>
        <GhostButton onClick={() => void load(true)}>重试</GhostButton>
      </div>
    )
  }

  if (detailServer) {
    return (
      <ServerDetail
        server={detailServer}
        onBack={() => setDetailServer(null)}
        onOpenTerminal={() => setTerminalServer(detailServer)}
      />
    )
  }

  const metric = host ? latestByServer.get(host.id) : undefined
  const hostEvents = unackedEvents.filter((e) => e.server_id === host?.id)

  // 部署机自己的容器读数。bad = 非 running 或 health 为 unhealthy
  const hostContainers = (() => {
    const mine = containers.filter((c) => c.server_id === host?.id)
    const running = mine.filter((c) => c.state === 'running').length
    const bad = mine.filter((c) => c.state !== 'running' || c.health === 'unhealthy').length
    return { total: mine.length, running, bad }
  })()

  const hostPoints = host ? (pointsByServer.get(host.id) ?? []) : []
  const capturedAt = metric?.captured_at
    ? new Date(metric.captured_at).toLocaleTimeString('zh-CN', {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      })
    : null

  return (
    <div className="flex flex-col gap-3.5">
      {/*
        刷新失败但仍留着上一版数据时的说明条。
        必须显式写出来:数字看起来和平时一模一样,不说清楚就会被当成实时值读。
      */}
      {error && lastUpdated ? (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-md border border-line-danger bg-tint-danger px-4 py-2.5 text-[12.5px] text-ink-danger">
          <IconAlertOctagon size={14} className="shrink-0" />
          <span>
            最近一次刷新失败({error})。以下为 <RelativeTime at={lastUpdated} /> 的数据,可能已经过期。
          </span>
        </div>
      ) : null}


      {/* ============================ 部署机专区 ============================ */}
      {host ? (
        <>
          {/*
            两段式:
              1. 状态卡回答「有没有事」,并把部署机身份与四项当前水位收在一起;
              2. 趋势(左)与容器(右)各自成为独立工作区,不再用四张等大图表抢焦点。
          */}
          <DashboardHero
            host={host}
            metric={metric}
            points={hostPoints}
            containers={hostContainers}
            alertCount={hostEvents.length}
            criticalCount={hostEvents.filter((e) => e.level === 'critical').length}
            capturedAt={capturedAt}
            onOpenTerminal={
              host.terminal_enabled ? () => setTerminalServer(host) : undefined
            }
          />

          {/*
            容器在左、趋势在右:容器表需要宽列才能同时放下状态 / 名称 / 项目 /
            服务器 / 内存;趋势图两条线在较窄的列里仍然可读。窄屏按 DOM 顺序
            上下排列,容器优先,符合"先看清哪里有事"的使用顺序。
          */}
          <div className="grid gap-3 min-[1360px]:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)] min-[1360px]:items-stretch">
            <ContainerBoard
              containers={containers}
              error={containersError}
              onOpenAll={onOpenContainers}
            />
            <TrendCard
              servers={servers}
              metricsByServer={latestByServer}
              pointsByServer={pointsByServer}
              range={range}
              onRangeChange={setRange}
            />
          </div>
        </>
      ) : (
        <Card className="py-10 text-center">
          <p className="text-[13px] text-ink-secondary">还没有接入任何服务器</p>
          <p className="mt-1 text-[11.5px] text-ink-tertiary">到「服务器」页登记一台,并把采集器指向本系统。</p>
        </Card>
      )}

      {/* 终端弹窗 */}
      {terminalServer ? (
        <RemoteTerminalDialog
          server={terminalServer}
          onClose={() => {
            setTerminalServer(null)
            void load()
          }}
        />
      ) : null}
    </div>
  )
}

/**
 * 相对时间。
 *
 * 运维场景关心的是"多久以前",而不是"具体几点几分"。
 * 自带 30 秒计时器,避免为了刷新文案而让整个页面重渲染。
 */
function RelativeTime({ at }: { at: string | Date }) {
  const iso = typeof at === 'string' ? at : at.toISOString()
  const [text, setText] = useState(() => formatRelative(iso))

  useEffect(() => {
    const timer = setInterval(() => setText(formatRelative(iso)), 30_000)
    return () => clearInterval(timer)
  }, [iso])

  return (
    <span
      className="tnum whitespace-nowrap"
      title={new Date(iso).toLocaleString('zh-CN', {
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
      })}
    >
      {text}
    </span>
  )
}

function formatRelative(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime()
  const minutes = Math.floor(Math.max(0, diff) / 60_000)
  if (minutes < 1) return '刚刚'
  if (minutes < 60) return `${minutes} 分钟前`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} 小时前`
  const days = Math.floor(hours / 24)
  if (days < 30) return `${days} 天前`
  return new Date(iso).toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' })
}

/**
 * 「实时 / 已断开」标。
 *
 * 参考稿标题旁边那枚「Live」。它不是装饰:这一页每 15 秒轮询一次,
 * 标在,说明看到的数最多差 15 秒;拉取失败时它翻成「已断开」——
 * 一个永远亮着的绿灯,比没有灯更危险。
 */
function LiveBadge({ stale }: { stale: boolean }) {
  return (
    <span
      className={`flex shrink-0 items-center gap-1.5 rounded-full px-2 py-[3px] text-[11px] font-medium ${
        stale ? 'bg-tint-danger text-ink-danger' : 'bg-tint-success text-ink-success'
      }`}
    >
      <span className="relative flex size-1.5">
        {stale ? null : (
          <span className="absolute inline-flex size-full animate-ping rounded-full bg-ink-success opacity-60" />
        )}
        <span
          className={`relative inline-flex size-1.5 rounded-full ${
            stale ? 'bg-ink-danger' : 'bg-ink-success'
          }`}
        />
      </span>
      {stale ? '已断开' : '实时'}
    </span>
  )
}

/**
 * 告警数据的唯一来源。
 *
 * 提升到应用层而不是留在看板里,有两个理由:
 *
 * 1. **通知入口要跨页可用。** 铃铛挂在页头,用户在「服务器」「部署」页时
 *    同样需要看到"有几条没读"。数据如果锁在 Dashboard 里,换个页签就瞎了。
 * 2. **两个消费者必须同源。** 页头铃铛的角标和通知面板里的列表都读这一个
 *    `events` —— 各拉各的迟早会出现"角标写 3、列出来只有 2 条"。
 *
 * 轮询节奏跟看板一致(15 秒)。这是告警,不是趋势图,慢一拍就没有意义。
 */
function useAlerts() {
  const [events, setEvents] = useState<EventItem[]>([])
  const [servers, setServers] = useState<Server[]>([])
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const [e, s] = await Promise.all([api.events(50), api.servers()])
      setEvents(e)
      setServers(s)
      setError(null)
    } catch (err) {
      setError((err as Error).message)
    }
  }, [])

  useEffect(() => {
    void load()
    const timer = setInterval(() => void load(), 15_000)
    return () => clearInterval(timer)
  }, [load])

  const ack = useCallback(
    async (id: number) => {
      // 乐观更新:先本地置为已读,请求失败再整体重拉回来。
      // 等一个来回才消角标,点击会显得没反应。
      setEvents((prev) => prev.map((e) => (e.id === id ? { ...e, acknowledged: true } : e)))
      try {
        await api.ackEvent(id)
      } catch {
        /* 失败不额外报错:下面的重拉会把真实状态覆盖回来 */
      }
      await load()
    },
    [load],
  )

  const unacked = useMemo(() => events.filter((e) => !e.acknowledged), [events])
  const critical = useMemo(() => unacked.filter((e) => e.level === 'critical').length, [unacked])

  return { events, servers, error, unacked, critical, ack, reload: load }
}

/** 应用外壳:顶栏 + 左侧分组导航 + 主内容区。 */
export function App({ user, onLogout }: { user: User; onLogout: () => void }) {
  const [tab, setTab] = useState<Tab>('dashboard')
  const [catalog, setCatalog] = useState<ActionCatalogItem[]>([])
  const [meta, setMeta] = useState<DashboardMeta>({
    lastUpdated: null,
    busy: false,
    refresh: () => {},
    stale: false,
  })
  // 各面板上报给页头的摘要文字(如「1 台」),避免内容区重复页面名
  const [panelMeta, setPanelMeta] = useState<string | null>(null)
  // 窄屏抽屉。桌面侧边栏常驻,这一层只在 lg 以下用得上
  const [navOpen, setNavOpen] = useState(false)
  const isAdmin = user.role === 'admin'

  // 告警数据全体共享:页头铃铛、通知面板、看板读数格读的都是这一份
  const alerts = useAlerts()

  useEffect(() => {
    // 操作目录由后端定义,前端只做展示与禁用
    api
      .actionCatalog()
      .then(setCatalog)
      .catch(() => setCatalog([]))
  }, [])

  // 身份稳定,避免看板每次上报元信息都触发父级重渲染
  const handleMeta = useCallback((next: DashboardMeta) => setMeta(next), [])

  /*
   * 可见性由注册表上的 adminOnly 决定,不再维护一份 ADMIN_TABS 名单 ——
   * 以后加管理员页签只需在 nav.tsx 那一行加个标记,不会漏。
   * 不可见的页签直接从导航里消失,而不是灰掉:一个点不动的入口只是噪声。
   */
  const canSee = useCallback((key: Tab) => !TAB_META[key].adminOnly || isAdmin, [isAdmin])

  // 换页统一走这里,顺带收起移动抽屉
  const go = useCallback((next: Tab) => {
    setTab(next)
    setNavOpen(false)
  }, [])

  const current = TAB_META[tab]

  return (
    <div className="min-h-screen bg-tertiary">
      <div className="mx-auto flex min-h-screen max-w-[1500px] flex-col px-4">
        <TopNav
          tab={tab}
          setTab={go}
          user={user}
          onLogout={onLogout}
          onOpenNav={() => setNavOpen(true)}
          canSee={canSee}
        />

        {/* 不要给这一行加 items-start:侧边栏靠 sticky 跟随滚动,
            而 sticky 的容器必须比它高 —— 一旦按内容收缩,侧边栏就没得跟了。 */}
        <div className="flex min-h-0 flex-1 gap-6">
          <Sidebar tab={tab} setTab={go} canSee={canSee} />

          <main className="min-w-0 flex-1 pb-10">
            {/* 页头:滚动长列表时仍能确认自己在哪一页、数据有多新 */}
            <header className="pb-4">
              <PageHeader
                title={current.label}
                description={current.description}
                /*
                  只有首页挂「实时」标:它 15 秒轮询一次,这个标是它的运行方式说明书。
                  其它页是按需拉取,挂上去就是假的。
                */
                badge={
                  tab === 'dashboard' && meta.lastUpdated ? (
                    <LiveBadge stale={meta.stale} />
                  ) : null
                }
                meta={
                  tab === 'dashboard' && meta.lastUpdated ? (
                    <span className="flex items-center gap-3">
                      <span className="flex items-center gap-1.5 text-[11.5px] text-ink-tertiary">
                        <IconActivity size={12} />
                        更新于 <RelativeTime at={meta.lastUpdated} />
                      </span>
                    </span>
                  ) : panelMeta ? (
                    <span className="text-[11.5px] text-ink-tertiary">{panelMeta}</span>
                  ) : null
                }
                actions={
                  <span className="flex items-center gap-2">
                    {/*
                      通知入口。常驻在页头 —— 告警不属于某一页,
                      翻到「服务器」「部署」时同样需要知道有几条没读。
                    */}
                    <NotificationBell
                      events={alerts.events}
                      servers={alerts.servers}
                      unacked={alerts.unacked}
                      critical={alerts.critical}
                      onAck={alerts.ack}
                      onAckAll={async () => {
                        await api.ackAllEvents()
                        alerts.reload()
                      }}
                    />
                    {tab === 'dashboard' ? (
                      <IconButton
                        label="刷新数据"
                        onClick={meta.refresh}
                        disabled={meta.busy}
                        spinning={meta.busy}
                      >
                        <IconRefresh size={14} />
                      </IconButton>
                    ) : null}
                  </span>
                }
              />
            </header>

            <HeaderMetaProvider value={setPanelMeta}>
              <FadeIn key={tab}>
                {tab === 'dashboard' ? <Dashboard onMeta={handleMeta} alerts={alerts} onOpenContainers={() => go('containers')} /> : null}
                {tab === 'containers' ? <ContainersPanel user={user} /> : null}
                {tab === 'servers' ? <ServersPanel user={user} /> : null}
                {tab === 'deployments' ? <ProjectsPanel user={user} catalog={catalog} /> : null}
                {tab === 'chat' ? <ChatPanel /> : null}
                {tab === 'dify' && isAdmin ? <DifyPanel /> : null}
                {tab === 'users' && isAdmin ? <UsersPanel currentUser={user} /> : null}
                {tab === 'audit' && isAdmin ? <AuditPanel /> : null}
                {/* 注册表里 ready:false 的页签统一落到占位页,不用在这里逐个列 */}
                {!current.ready ? <BlankPanel item={current} onBack={go} /> : null}
              </FadeIn>
            </HeaderMetaProvider>
          </main>
        </div>
      </div>

      <SidebarDrawer
        open={navOpen}
        onClose={() => setNavOpen(false)}
        tab={tab}
        setTab={go}
        canSee={canSee}
      />
    </div>
  )
}

/**
 * 顶栏。
 *
 * 导航搬进侧边栏之后,顶栏只留三件事:品牌、搜索、右侧的主题与账号。
 *
 * 版式取自 Komodo 的 topbar —— 三列网格:左品牌、**中间放全局搜索**、
 * 右侧一排动作。搜索能占中间,正是因为导航下移到了侧边栏:
 * 横栏上的图标一多,中间必然空出来;与其留白,不如把最高频的动作放进去。
 *
 * 窄屏(小于 lg)侧边栏收成抽屉,这里补一个汉堡按钮把入口还回来 ——
 * 否则手机上就没有任何导航入口了。
 */
function TopNav({
  tab,
  setTab,
  user,
  onLogout,
  onOpenNav,
  canSee,
}: {
  tab: Tab
  setTab: (t: Tab) => void
  user: User
  onLogout: () => void
  onOpenNav: () => void
  canSee: (k: Tab) => boolean
}) {
  const { theme, setTheme } = useTheme()
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [userMenu, setUserMenu] = useState(false)
  const [query, setQuery] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  // 命令面板的候选与侧边栏同源,只是这里按可见性过一遍
  const tabs = NAV_ITEMS.filter((i) => canSee(i.key))

  // ⌘K / Ctrl+K 开关命令面板,Esc 关闭
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setPaletteOpen((o) => !o)
      } else if (e.key === 'Escape') {
        setPaletteOpen(false)
        setUserMenu(false)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  useEffect(() => {
    if (!paletteOpen) return
    setQuery('')
    // 等面板挂载后再聚焦,否则 ref 还是 null
    const id = requestAnimationFrame(() => inputRef.current?.focus())
    return () => cancelAnimationFrame(id)
  }, [paletteOpen])

  const q = query.trim().toLowerCase()
  const matches = q
    ? tabs.filter(
        (i) => i.label.toLowerCase().includes(q) || i.description.toLowerCase().includes(q),
      )
    : tabs

  /*
   * 按侧边栏的分组顺序铺开,让搜索结果的层次和导航一致。
   * 21 个页签平铺成一张长列表时,读者得自己判断"这条属于哪一类";
   * 带上分组标题,记忆负担就回到导航上。
   */
  const grouped = NAV_GROUPS.map((g) => ({
    key: g.key,
    label: g.label,
    items: matches.filter((i) => g.items.includes(i)),
  })).filter((g) => g.items.length > 0)

  const isMac = /mac/i.test(navigator.platform)
  const ThemeIcon = theme === 'light' ? IconSun : theme === 'dark' ? IconMoon : IconSunMoon
  const themeLabel = theme === 'light' ? '浅色' : theme === 'dark' ? '深色' : '跟随系统'
  const roleLabel = user.role === 'admin' ? '管理员' : user.role === 'operator' ? '运维' : '只读'

  return (
    <>
      <nav className="my-4 flex h-14 items-center gap-3 rounded-lg border border-line bg-primary px-4 pe-3 sm:h-16 sm:px-6">
        {/* 汉堡:窄屏侧边栏收成抽屉,入口得留在这里 */}
        <button
          type="button"
          onClick={onOpenNav}
          aria-label="打开导航"
          title="导航"
          className="-ms-1 flex size-9 shrink-0 cursor-pointer items-center justify-center rounded-md text-ink-tertiary transition-colors hover:bg-overlay-light hover:text-ink lg:hidden"
        >
          <IconMenu size={18} />
        </button>

        {/* 品牌 */}
        <button
          type="button"
          onClick={() => setTab('dashboard')}
          aria-label="OpsDeck 首页"
          className="flex shrink-0 cursor-pointer items-center gap-2.5 p-2 ps-0"
        >
          <span className="flex size-6 items-center justify-center rounded-md bg-accent text-on-accent">
            <IconGauge size={14} />
          </span>
          <span className="text-[15px] font-semibold tracking-tight text-ink">OpsDeck</span>
        </button>

        {/*
          搜索。Beszel 用 ⌘K 唤出命令面板;这里做成真能跳页签,而不是摆设。
          放在横栏中间 —— 导航下移到侧边栏后,这里正好空出来。
        */}
        <div className="flex min-w-0 flex-1 justify-center">
          <button
            type="button"
            onClick={() => setPaletteOpen(true)}
            className="hidden w-full max-w-sm cursor-pointer items-center gap-1.5 rounded-md border border-line px-4 py-1.5 text-sm text-ink-tertiary transition-colors hover:bg-overlay-light hover:text-ink sm:flex"
          >
            <IconSearch size={15} />
            搜索
            <span className="ms-3.5 flex items-center gap-1">
              <Kbd>{isMac ? '⌘' : 'Ctrl'}</Kbd>
              <Kbd>K</Kbd>
            </span>
          </button>
        </div>

        {/* 右侧:主题 + 用户 */}
        <div className="flex shrink-0 items-center gap-1">
          <button
            type="button"
            onClick={() => setTheme(THEME_ORDER[(THEME_ORDER.indexOf(theme) + 1) % THEME_ORDER.length])}
            aria-label={`主题:${themeLabel}`}
            title={`主题:${themeLabel}`}
            className="flex size-9 cursor-pointer items-center justify-center rounded-md text-ink-tertiary transition-colors hover:bg-overlay-light hover:text-ink"
          >
            <ThemeIcon size={17} />
          </button>

          <div className="relative">
            <button
              type="button"
              onClick={() => setUserMenu((o) => !o)}
              aria-label="用户菜单"
              title={user.display_name || user.username}
              className="ms-1 flex cursor-pointer items-center rounded-md p-1 transition-colors hover:bg-overlay-light"
            >
              <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-tint-blue text-[11px] font-semibold text-accent">
                {(user.display_name || user.username).slice(0, 1).toUpperCase()}
              </span>
            </button>
            {userMenu ? (
              <>
                <div className="fixed inset-0 z-40" onClick={() => setUserMenu(false)} aria-hidden />
                <div className="absolute end-0 top-full z-50 mt-1 min-w-44 rounded-md border border-line bg-primary p-1 shadow-lg">
                  <div className="px-2.5 py-1.5">
                    <div className="truncate text-[13px] text-ink">
                      {user.display_name || user.username}
                    </div>
                    <div className="text-[11px] text-ink-tertiary">{roleLabel}</div>
                  </div>
                  <div className="my-1 h-px bg-overlay-medium" />
                  <button
                    type="button"
                    onClick={onLogout}
                    className="flex w-full cursor-pointer items-center gap-2 rounded-sm px-2.5 py-1.5 text-left text-[13px] text-ink-secondary transition-colors hover:bg-overlay-light hover:text-ink-danger"
                  >
                    <IconLogout size={14} />
                    退出登录
                  </button>
                </div>
              </>
            ) : null}
          </div>
        </div>
      </nav>

      {/* 命令面板 */}
      {paletteOpen ? (
        <div
          className="fixed inset-0 z-[60] flex items-start justify-center bg-black/40 p-4 pt-[12vh]"
          onClick={() => setPaletteOpen(false)}
        >
          <div
            className="w-full max-w-md overflow-hidden rounded-lg border border-line bg-primary shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-2 border-b border-line px-3.5 py-3">
              <span className="text-ink-tertiary">
                <IconSearch size={16} />
              </span>
              <input
                ref={inputRef}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && matches[0]) {
                    setTab(matches[0].key)
                    setPaletteOpen(false)
                  }
                }}
                placeholder="跳转到…"
                aria-label="跳转到页面"
                className="w-full bg-transparent text-[14px] text-ink outline-none placeholder:text-ink-tertiary"
              />
            </div>
            <div className="max-h-72 overflow-y-auto p-1">
              {matches.length === 0 ? (
                <div className="px-3 py-6 text-center text-[13px] text-ink-tertiary">没有匹配的页面</div>
              ) : (
                grouped.map((group) => (
                  <div key={group.key}>
                    {/* 有标题的分组给标题,没有的画一条素线把两组断开 */}
                    {group.label ? (
                      <div className="px-3 pt-2 pb-1 text-[11px] text-ink-tertiary">{group.label}</div>
                    ) : (
                      <div className="my-1 h-px bg-overlay-light" />
                    )}
                    {group.items.map((item) => {
                      const { Icon } = item
                      const active = tab === item.key
                      return (
                        <button
                          key={item.key}
                          type="button"
                          onClick={() => {
                            setTab(item.key)
                            setPaletteOpen(false)
                          }}
                          aria-current={active ? 'page' : undefined}
                          className={`flex w-full cursor-pointer items-center gap-2.5 rounded-sm px-3 py-2 text-left transition-colors hover:bg-overlay-light ${
                            active ? 'bg-tint-blue' : ''
                          }`}
                        >
                          <span className={active ? 'text-accent' : 'text-ink-tertiary'}>
                            <Icon size={15} />
                          </span>
                          <span
                            className={`text-[13px] ${active ? 'font-medium text-accent' : 'text-ink'}`}
                          >
                            {item.label}
                          </span>
                          <span className="ms-auto truncate text-[11px] text-ink-tertiary">
                            {item.description}
                          </span>
                        </button>
                      )
                    })}
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      ) : null}
    </>
  )
}

/** 键盘按键提示。照 Beszel 的 Kbd。 */
function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="inline-flex h-5 items-center rounded border border-line bg-sunken px-1.5 font-mono text-[10px] font-medium text-ink-tertiary select-none">
      {children}
    </kbd>
  )
}
