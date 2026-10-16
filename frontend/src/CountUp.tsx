'use client'

import { useInView, useMotionValue, useSpring } from 'motion/react'
import { useCallback, useEffect, useRef } from 'react'

/**
 * 数字滚动。
 *
 * 改编自 react-bits 的 CountUp(MIT 风格的开源实现),做了三点收敛:
 *   - 改为 TypeScript,并补齐类型
 *   - 进入视口才播放,避免长列表里几十个数字同时跳动
 *   - 尊重系统的"减少动态效果"偏好,直接显示终值
 *
 * 用于指标与统计卡片:数值变化时滚动到新值,让"刚刚涨上去了"这件事被注意到。
 */
export function CountUp({
  to,
  from = 0,
  duration = 1.4,
  decimals,
  separator = '',
  className = '',
  suffix = '',
}: {
  to: number
  from?: number
  duration?: number
  decimals?: number
  separator?: string
  className?: string
  suffix?: string
}) {
  const ref = useRef<HTMLSpanElement>(null)
  const motionValue = useMotionValue(from)

  // 弹簧参数:时长越短越"跟手",但要避免过冲导致数字抖动
  const spring = useSpring(motionValue, {
    damping: 24 + 36 * (1 / duration),
    stiffness: 90 * (1 / duration),
  })

  const inView = useInView(ref, { once: true, margin: '0px' })

  // 小数位:未显式指定时,从入参与目标值推断
  const places = decimals ?? Math.max(decimalsOf(from), decimalsOf(to))

  const format = useCallback(
    (value: number) => {
      const text = Intl.NumberFormat('en-US', {
        useGrouping: Boolean(separator),
        minimumFractionDigits: places,
        maximumFractionDigits: places,
      }).format(value)
      return separator ? text.replace(/,/g, separator) : text
    },
    [places, separator],
  )

  // 初始值写入,避免首帧显示 0 造成跳动
  useEffect(() => {
    if (ref.current) ref.current.textContent = format(from)
  }, [from, format])

  // 进入视口后开始滚动
  useEffect(() => {
    if (inView) motionValue.set(to)
  }, [inView, motionValue, to])

  // 订阅弹簧值并写入 DOM(避免每帧触发 React 渲染)
  useEffect(() => {
    const unsubscribe = spring.on('change', (latest) => {
      if (ref.current) ref.current.textContent = format(latest)
    })
    return () => unsubscribe()
  }, [spring, format])

  // 用户偏好减少动效时,直接落到终值
  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)')
    if (!mq.matches) return
    motionValue.jump(to)
    if (ref.current) ref.current.textContent = format(to)
  }, [motionValue, to, format])

  return (
    <span ref={ref} className={`tnum ${className}`}>
      {format(from)}
      {suffix ? <span className="ml-0.5">{suffix}</span> : null}
    </span>
  )
}

/** 取数字的小数位数,用于决定展示精度。 */
function decimalsOf(value: number): number {
  const text = value.toString()
  if (!text.includes('.')) return 0
  const decimals = text.split('.')[1]
  return Number.parseInt(decimals, 10) !== 0 ? decimals.length : 0
}
