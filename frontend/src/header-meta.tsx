import { createContext, useContext, useEffect } from 'react'

/*
 * 页头摘要插槽。
 *
 * 页头已经写了页面名(「服务器」「审计日志」…),内容区再写一遍就是重复。
 * 但数量这类信息又确实有用,于是把它上提到页头右侧 ——
 * 内容区从"标题 + 数据"变成只剩数据,页面少一层噪声。
 *
 * 只传字符串是有意为之:字符串按值比较,useEffect 的依赖不会因为
 * 每次渲染新建一个 JSX 元素而反复触发,也就不会形成
 * "子组件 setState → 父组件重渲染 → 子组件再 setState" 的循环。
 */

const HeaderMetaContext = createContext<((text: string | null) => void) | null>(null)

export const HeaderMetaProvider = HeaderMetaContext.Provider

/** 面板调用它,把一句话摘要挂到页头右侧。传 null 表示不显示。 */
export function useHeaderMeta(text: string | null) {
  const set = useContext(HeaderMetaContext)

  useEffect(() => {
    set?.(text)
    return () => set?.(null)
  }, [set, text])
}
