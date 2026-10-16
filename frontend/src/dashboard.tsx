import type { ReactNode } from 'react'

import type { Metric } from './api'
import { MetricAreaChart, SERIES_COLOR } from './charts'
import { CountUp } from './CountUp'
import { HEALTH, levelOf, mean, ratio } from './health'
import { Card, STAT_TONE, type StatTone } from './ui'

/*
 * 首页「运行概览」的四块积木。
 *
 * 版式取自 DockPanel 的 dashboard:一条身份/规格带 → 三块大水位读数 →
 * 三张 24 小时曲线 → 一张密集读数网格。
 *
 * 参考稿是**单机**面板,这里面对的是机队,所以每一处都显式交代
 * 「这是均值还是合计」—— 把多台机器的平均数读成某一台的具体数,
 * 是这类看板最容易撒的谎,而且撒得毫无痕迹。
 *
 * 三样东西刻意不抄:
 *   内核版本 / 温度 / 进程数、磁盘 IO、带宽。
 *   DockPanel 有,OpsDeck 的采集器不下发。编不出来就不画 ——
 *   一格「—」比一个假数字诚实,这条在 ui.tsx 里已经写过一次了。
 */

/**
 * 机队序列上的一个时间点。
 *
 * 写成 `Record & {...}` 而不是 interface:interface **不参与** TS 的
 * 「隐式索引签名」推导,`FleetPoint[]` 传不进 `ChartPoint[]` 参数,
 * 报的错还是「缺少索引签名」这种看不出因果的话。
 */
export type FleetPoint = Record<string, number | null> & {
  created: number
  cpu: number | null
  mem: number | null
  disk: number | null
}

/**
 * 把「每台机器一条 24 小时序列」压成「机队一条序列」。
 *
 * 按**下标**对齐,而不是按时间戳:各台的桶由同一轮请求生成、窗口相同,
 * 但桶内采样时刻会差几秒 —— 按时间戳对齐会把同一条曲线错开成两条。
 *
 * 空桶(后端在没采到的时段返回各指标为 null)在求均值时被跳过;
 * 若整桶所有机器都是 null,结果仍是 null —— 曲线在那里断开,
 * 而不是掉到 0。「没采集到」和「一切正常」必须长得不一样。
 */
export function fleetSeries(histories: Map<string, Metric[]>): FleetPoint[] {
  const lists = [...histories.values()].filter((l) => l.length > 0)
  if (lists.length === 0) return []

  const len = Math.max(...lists.map((l) => l.length))
  const out: FleetPoint[] = []

  for (let i = 0; i < len; i += 1) {
    const at: number[] = []
    const cpu: Array<number | null> = []
    const mem: Array<number | null> = []
    const disk: Array<number | null> = []

    for (const list of lists) {
      const m = list[i]
      if (!m) continue

      const t = new Date(m.captured_at).getTime()
      // 时间戳坏掉的点整条丢掉:留着会把 X 轴拉成 NaN
      if (Number.isFinite(t)) at.push(t)

      cpu.push(m.cpu_percent)
      mem.push(ratio(m.mem_used_mb, m.mem_total_mb))
      disk.push(ratio(m.disk_used_gb, m.disk_total_gb))
    }

    out.push({
      created: at.length > 0 ? Math.max(...at) : 0,
      cpu: mean(cpu),
      mem: mean(mem),
      disk: mean(disk),
    })
  }

  return out
}

export interface SpecCell {
  label: string
  value: ReactNode
  sub?: ReactNode
  tone?: StatTone
}

/**
 * 身份 / 规格带。
 *
 * 参考稿那一排是「HOSTNAME / OS / KERNEL / PROCESSOR / TEMPERATURE / PROCESSES」,
 * 这里换成本机队的同义事实:几台机器、什么系统、多少核、多少内存、容器跑着几个、
 * 数据有多新。
 *
 * 分隔线用 `gap-px` + 底色画,而不是给每个格子挂 border:后者在换行时
 * 会给第二行的第一个格子也描一条左边线,得靠 first-child / nth-child 去补,
 * 断点一多就补不干净。让**底色从缝里透出来**就没有这个问题。
 */
export function SpecStrip({ cells }: { cells: SpecCell[] }) {
  return (
    <Card padded={false} className="overflow-hidden">
      <div className="grid grid-cols-2 gap-px bg-line sm:grid-cols-3 lg:grid-cols-6">
        {cells.map((c) => (
          <div key={c.label} className="min-w-0 bg-primary px-3.5 py-2.5">
            <div className="truncate text-[11px] tracking-wider text-ink-tertiary">{c.label}</div>
            <div
              className={`mt-1 truncate text-[13.5px] font-medium ${STAT_TONE[c.tone ?? 'neutral']}`}
            >
              {c.value}
            </div>
            {c.sub ? (
              <div className="mt-0.5 truncate text-[11px] text-ink-tertiary">{c.sub}</div>
            ) : null}
          </div>
        ))}
      </div>
    </Card>
  )
}

/**
 * 大号水位读数。
 *
 * 参考稿里最醒目的一块:标签 + 一个很大的数字 + 一条水位 + 一行量纲。
 *
 * 和 ui.tsx 的 `Stat` 的区别是**尺寸与站位**:Stat 是成组出现的小方块
 * (一屏四块,谁都不该抢谁),HeroGauge 一行只有三块、是首屏主读数,
 * 所以数字放大到 34px、水位加粗到 6px。
 *
 * 水位颜色走阈值(health.ts),不走上面的分类线色:
 * 这里回答的是「满没满」,不是「这是哪一项」。
 */
export function HeroGauge({
  label,
  icon,
  value,
  unit = '%',
  decimals = 0,
  hint,
  tone = 'neutral',
  bar,
  averaged = false,
}: {
  label: string
  icon: ReactNode
  value: number | null
  unit?: string
  decimals?: number
  hint?: ReactNode
  tone?: StatTone
  bar?: number | null
  /** 多台机器聚合出来的读数。标出来,免得被当成某一台的具体数。 */
  averaged?: boolean
}) {
  const has = value !== null && Number.isFinite(value)
  const barHas = bar !== null && bar !== undefined && Number.isFinite(bar)
  const pct = barHas ? Math.max(0, Math.min(100, bar as number)) : 0

  return (
    <Card padded={false} className="flex flex-col p-3.5">
      <div className="flex items-center gap-1.5">
        <span className="shrink-0 text-ink-tertiary">{icon}</span>
        <span className="truncate text-[11.5px] font-medium text-ink-secondary">{label}</span>
        {averaged ? (
          <span
            className="shrink-0 rounded-xs bg-overlay-light px-1 text-[10px] text-ink-tertiary"
            title="多台机器的平均值"
          >
            均
          </span>
        ) : null}
      </div>

      <div className="mt-2 flex items-baseline gap-1">
        {has ? (
          <CountUp
            to={value}
            decimals={decimals}
            duration={1.1}
            className={`tnum text-[34px] leading-none font-semibold tracking-tight ${STAT_TONE[tone]}`}
          />
        ) : (
          <span className="text-[34px] leading-none font-semibold text-ink-tertiary">—</span>
        )}
        {/* 缺数据时不挂单位:写成「— %」比只写「—」更让人费解 */}
        {has && unit ? <span className="text-[13px] text-ink-tertiary">{unit}</span> : null}
      </div>

      {/*
        mt-auto:三块被 grid 拉成等高之后,把「量纲 + 水位」压到同一条基线上。
        不对齐的话三块并排看着像三张不同的卡,而不是一组读数。
        量纲放在条的上方 —— 它说明的是这条条在量什么,脱离条就只是个飘着的数字。
      */}
      <div className="mt-auto flex flex-col gap-2 pt-3">
        {hint ? <span className="truncate text-[11px] text-ink-tertiary">{hint}</span> : null}
        <span className="block h-[6px] overflow-hidden rounded-full bg-overlay-medium">
          <span
            className={`block h-full rounded-full transition-[width] duration-500 ease-out ${
              barHas ? HEALTH[levelOf(pct)].bar : ''
            }`}
            style={{ width: `${pct}%` }}
          />
        </span>
      </div>
    </Card>
  )
}

export interface StatCell {
  label: string
  value: ReactNode
  unit?: string
  tone?: StatTone
  hint?: ReactNode
}

/**
 * 密集读数网格。
 *
 * 参考稿里那一片「UPTIME 7d 22h / SITES 0 / DATABASES 0 …」的小格子。
 *
 * 服务器健康被提到网格**上方独占一行**:它回答的是「哪几台有事」,
 * 和下面那十二格纯数字不是一类东西,塞进一格会被淹没。
 * 十二格 = 3 行 × 4 列,正好把 4 列网格铺满,不留半行。
 */
export function StatGrid({ header, cells }: { header?: ReactNode; cells: StatCell[] }) {
  return (
    <Card padded={false} className="overflow-hidden">
      {header ? <div className="border-b border-line px-3.5 py-2.5">{header}</div> : null}
      <div className="grid grid-cols-2 gap-px bg-line sm:grid-cols-3 lg:grid-cols-4">
        {cells.map((c) => (
          <div key={c.label} className="min-w-0 bg-primary px-3.5 py-2.5">
            <div className="truncate text-[11px] text-ink-tertiary">{c.label}</div>
            <div className="mt-1 flex items-baseline gap-1">
              <span
                className={`truncate text-[15px] leading-none font-semibold ${
                  STAT_TONE[c.tone ?? 'neutral']
                }`}
              >
                {c.value}
              </span>
              {c.unit ? <span className="text-[11px] text-ink-tertiary">{c.unit}</span> : null}
            </div>
            {c.hint ? (
              <div className="mt-0.5 truncate text-[11px] text-ink-tertiary">{c.hint}</div>
            ) : null}
          </div>
        ))}
      </div>
    </Card>
  )
}

/**
 * 一张紧凑的 24 小时曲线卡。
 *
 * 不复用 charts.tsx 的 `ChartCard`:那个外壳是给「一页一两张大图」设计的
 * (标题 1.4rem,在小卡里会顶满整行),而且它带一条
 * `odd:last-of-type:col-span-full` —— 三张并排时第三张正好命中,
 * 会整行占满、把三列网格撑成两行。这里另起一个 40px 标题行的小外壳。
 */
export function FleetChart({
  title,
  icon,
  data,
  seriesKey,
  label,
  averaged = false,
}: {
  title: string
  icon: ReactNode
  data: FleetPoint[]
  seriesKey: keyof typeof SERIES_COLOR
  label: string
  averaged?: boolean
}) {
  // 标题行右上角那个读数:取最后一个非空点,而不是 data[last] ——
  // 末尾常有一两个空桶,直接取会把「—」写在一条明显有数据的曲线旁边
  const last = [...data].reverse().find((p) => p[seriesKey] !== null)?.[seriesKey] ?? null

  return (
    <Card padded={false} className="flex flex-col overflow-hidden">
      <div className="flex items-center gap-1.5 border-b border-line px-3 py-2">
        <span className="shrink-0 text-ink-tertiary">{icon}</span>
        <span className="truncate text-[11.5px] font-medium text-ink-secondary">{title}</span>
        {averaged ? (
          <span
            className="shrink-0 rounded-xs bg-overlay-light px-1 text-[10px] text-ink-tertiary"
            title="多台机器的平均值"
          >
            均
          </span>
        ) : null}
        <span className="ms-auto shrink-0 tnum text-[12px] text-ink">
          {last === null ? '—' : `${last.toFixed(1)}%`}
        </span>
      </div>

      {/* 图表必须有个定高的父容器 —— MetricAreaChart 内部是 h-full */}
      <div className="h-32 px-1 py-1.5">
        <MetricAreaChart
          data={data}
          time="24h"
          series={[{ key: seriesKey, label, color: SERIES_COLOR[seriesKey], opacity: 0.22 }]}
          domain={[0, 100]}
          tickFormatter={(v) => `${v}%`}
          valueFormatter={(v) => `${v.toFixed(1)}%`}
        />
      </div>
    </Card>
  )
}
