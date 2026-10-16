import { useEffect, useState } from 'react'

import { api, type AuditLog } from '../api'
import { useHeaderMeta } from '../header-meta'
import { Badge, Card, Empty } from '../ui'

/**
 * 动作 → 中文。
 *
 * 键取自后端实际写入的值(见 app/api/*.py 的 record_audit 调用)。
 * 漏一个就会在表格里露出 `terminal_authorize_failed` 这样的原始键 ——
 * 既占宽度又看不懂,所以这里与后端保持一一对应。
 */
const ACTION_LABEL: Record<string, string> = {
  login: '登录',
  login_failed: '登录失败',
  logout: '登出',
  create: '新建',
  update: '更新',
  delete: '删除',
  execute: '执行',
  terminal_open: '终端开启',
  terminal_close: '终端关闭',
  terminal_authorize: '终端授权',
  terminal_authorize_failed: '授权失败',
}

const TARGET_LABEL: Record<string, string> = {
  auth: '认证',
  user: '用户',
  server: '服务器',
  project: '项目',
  action: '操作',
  terminal_credential: '终端凭据',
}

/**
 * 把「对象」列的三段拼成一行纯文本。
 *
 * 既用于渲染,也用于 title 提示 —— 同一个来源保证悬停看到的就是被截断的内容。
 * 详情里可能带会话 ID 这类长串,不截断会把表格撑出卡片。
 */
function targetText(l: AuditLog): string {
  const base = l.target_type ? (TARGET_LABEL[l.target_type] ?? l.target_type) : '—'
  const name = l.target_name ? ` ${l.target_name}` : ''
  const detail = l.detail ? ` · ${l.detail}` : ''
  return `${base}${name}${detail}`
}

/** 审计日志面板。仅管理员可见。 */
export function AuditPanel() {
  const [logs, setLogs] = useState<AuditLog[]>([])
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    api
      .auditLogs(100)
      .then(setLogs)
      .catch((err: Error) => setError(err.message))
  }, [])

  // 数量交给页头,内容区不再重复「审计日志」这个页面名
  useHeaderMeta(logs.length > 0 ? `最近 ${logs.length} 条` : null)

  if (error) return <p className="py-16 text-center text-ink-danger">加载失败：{error}</p>

  return (
    <section>
      <Card className="p-0">
        {logs.length === 0 ? (
          <div className="p-5">
            <Empty>暂无记录。</Empty>
          </div>
        ) : (
          /*
           * table-fixed 是这里的重点:自动布局下「对象」列会随内容伸缩,
           * 每行的时间/动作/结果都会左右漂移,而且长详情能把表格撑出卡片。
           * 固定列宽 + 对象列 truncate 之后,列永远对齐,行高也稳定。
           * min-w 保证窄屏下横向滚动而不是把列压扁。
           */
          <div className="w-full overflow-x-auto">
            <table className="w-full min-w-[860px] table-fixed text-[13px]">
              <thead>
                <tr className="border-b border-line text-left text-xs text-ink-tertiary">
                  <th className="w-[168px] px-5 py-2.5 font-medium whitespace-nowrap">时间</th>
                  <th className="w-[84px] px-3 py-2.5 font-medium whitespace-nowrap">操作者</th>
                  <th className="w-[92px] px-3 py-2.5 font-medium whitespace-nowrap">动作</th>
                  <th className="px-3 py-2.5 font-medium whitespace-nowrap">对象</th>
                  <th className="w-[118px] px-3 py-2.5 font-medium whitespace-nowrap">IP</th>
                  <th className="w-[72px] px-5 py-2.5 font-medium whitespace-nowrap">结果</th>
                </tr>
              </thead>
              <tbody>
                {logs.map((l) => (
                  <tr key={l.id} className="border-b border-line last:border-0">
                    <td className="tnum px-5 py-2.5 text-xs whitespace-nowrap text-ink-tertiary">
                      {new Date(l.created_at).toLocaleString('zh-CN')}
                    </td>
                    <td className="mono truncate px-3 py-2.5">{l.username ?? '—'}</td>
                    <td
                      className="truncate px-3 py-2.5"
                      title={ACTION_LABEL[l.action] ?? l.action}
                    >
                      <span className={l.success ? '' : 'text-ink-danger'}>
                        {ACTION_LABEL[l.action] ?? l.action}
                      </span>
                    </td>
                    <td className="px-3 py-2.5 text-ink-tertiary">
                      <div className="truncate" title={targetText(l)}>
                        {l.target_type ? (TARGET_LABEL[l.target_type] ?? l.target_type) : '—'}
                        {l.target_name ? (
                          <span className="text-ink-secondary"> {l.target_name}</span>
                        ) : null}
                        {l.detail ? <span> · {l.detail}</span> : null}
                      </div>
                    </td>
                    <td className="mono px-3 py-2.5 text-xs whitespace-nowrap text-ink-tertiary">
                      {l.ip ?? '—'}
                    </td>
                    <td className="px-5 py-2.5">
                      <Badge tone={l.success ? 'ok' : 'bad'}>{l.success ? '成功' : '失败'}</Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </section>
  )
}
