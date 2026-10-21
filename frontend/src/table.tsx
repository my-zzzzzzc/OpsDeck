import type { ReactNode } from 'react'

/*
 * 紧凑数据表。
 *
 * 结构用原生语义标签(便于无障碍与键盘导航),视觉规格来自 Beszel:
 *   - 行高 32px,表头同高
 *   - 表头用独立的浅色表面,滚动时列名始终可见
 *   - 行 hover 用暖灰 accent 面,而不是描边
 *
 * 这套规格让信息密度比"卡片式"布局高一倍以上。
 */

/**
 * 表格容器。负责横向滚动与圆角裁切。
 *
 * 固定布局是刻意的:auto 布局下浏览器会按内容重新分配列宽,列会逐行漂移,
 * 而且 `white-space: nowrap` 的文本其 min-content 就是整串文字的宽度 ——
 * 单元格再怎么写 truncate 也压不下去,表格只会顶出一条横向滚动条。
 * 固定布局后 TH 上的 width 才是真正生效的,配合 truncate 才能稳定截断。
 * 前提是每张表都要给出显式列宽,留一列不写让它吃掉剩余空间。
 */
export function DataTable({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <div className={`w-full overflow-x-auto ${className}`}>
      <table className="w-full table-fixed border-collapse text-[13px]">{children}</table>
    </div>
  )
}

/** 表头行。 */
export function THead({ children }: { children: ReactNode }) {
  return <thead>{children}</thead>
}

/** 表头单元格。 */
export function TH({
  children,
  align = 'left',
  width,
}: {
  children: ReactNode
  align?: 'left' | 'right' | 'center'
  width?: string
}) {
  const justify = align === 'right' ? 'justify-end' : align === 'center' ? 'justify-center' : ''
  return (
    <th
      scope="col"
      style={width ? { width } : undefined}
      className="h-8 border-b border-line bg-table-header px-2 text-left align-middle text-[11px] font-medium whitespace-nowrap text-ink-tertiary"
    >
      <span className={`flex items-center gap-1 ${justify}`}>{children}</span>
    </th>
  )
}

/** 表体。 */
export function TBody({ children }: { children: ReactNode }) {
  return <tbody>{children}</tbody>
}

/**
 * 数据行。
 * 悬停时整行高亮,点击区域覆盖整行 —— 符合表格的交互预期。
 */
export function TR({
  children,
  onClick,
  dimmed = false,
}: {
  children: ReactNode
  onClick?: () => void
  dimmed?: boolean
}) {
  return (
    <tr
      onClick={onClick}
      className={`h-8 max-h-8 border-b border-line transition-colors duration-100 last:border-b-0
        ${onClick ? 'cursor-pointer hover:bg-accent-soft' : 'hover:bg-accent-soft'}
        ${dimmed ? 'opacity-45' : ''}`}
    >
      {children}
    </tr>
  )
}

/** 数据单元格。 */
export function TD({
  children,
  align = 'left',
  mono = false,
  className = '',
}: {
  children: ReactNode
  align?: 'left' | 'right' | 'center'
  mono?: boolean
  className?: string
}) {
  const justify = align === 'right' ? 'justify-end' : align === 'center' ? 'justify-center' : ''
  return (
    <td className={`h-8 max-h-8 px-2 align-middle ${className}`}>
      {/*
        `[&>*]:min-w-0` 一次性给所有直接子项放开收缩权。
        flex 子项默认 min-width:auto,不允许窄于内容 —— 这会让单元格里的
        truncate 全部失效(它们只是被 overflow 裁掉,而不是变成省略号)。
        显式写了 shrink-0 的(状态点、徽标)不受影响。
      */}
      <div
        className={`flex h-8 items-center gap-1.5 overflow-hidden [&>*]:min-w-0 ${justify} ${mono ? 'mono text-[12px]' : ''}`}
      >
        {children}
      </div>
    </td>
  )
}

/**
 * 表内次要文字。
 *
 * `min-w-0` 不能省:flex 子项默认 min-width:auto,不允许收缩到内容宽度以下,
 * 于是 `truncate` 永远不生效 —— 单元格只是被 overflow 裁掉,同时把整张表的
 * 最小宽度顶大,表格底部就会多出一条横向滚动条。
 */
export function TDMuted({ children }: { children: ReactNode }) {
  return <span className="min-w-0 truncate text-[12px] text-ink-tertiary">{children}</span>
}
