/**
 * 类名合并。
 *
 * 项目里目前没有条件类名的复杂场景,因此不引入 clsx + tailwind-merge,
 * 只做最简单的拼接 —— 保持依赖精简。
 * 若后续出现 Tailwind 类冲突(如 p-2 与 p-4 同时存在),
 * 再引入 tailwind-merge 处理。
 */
export function cn(...classes: Array<string | false | null | undefined>): string {
  return classes.filter(Boolean).join(' ')
}
