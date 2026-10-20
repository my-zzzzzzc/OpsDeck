import { CheckCircle2, Loader2, X, XCircle } from 'lucide-react'
import { useEffect, useState } from 'react'

import { api, type Server } from '../api'
import { cn } from '../cn'
import { GhostButton, PrimaryButton } from '../ui'

/**
 * SSH 凭据编辑对话框。
 *
 * 为什么单做这个:
 * 终端、容器日志、白名单操作全部依赖 SSH 回连,而此前登录用户名在代码里
 * 写死为 root —— 只允许 ubuntu 登录的云镜像会在这些功能上全线失败,
 * 且界面上没有任何地方能看到或改这个值。这个对话框把它变成可配置。
 *
 * 「测试连接」是这个对话框最重要的部分:凭据填错时的症状是"日志打不开",
 * 而真正的原因藏在服务端日志里。让用户保存前就拿到明确结论
 * (认证失败 / 连不上 / 私钥文件不存在),比事后排查便宜得多。
 */
export function SshCredentialDialog({ server, onClose }: { server: Server; onClose: () => void }) {
  const [sshUser, setSshUser] = useState(server.ssh_user || 'root')
  const [sshPort, setSshPort] = useState(String(server.ssh_port || 22))
  const [keyPath, setKeyPath] = useState(server.ssh_key_path ?? '')
  const [terminalEnabled, setTerminalEnabled] = useState(server.terminal_enabled)

  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<
    { ok: boolean; message: string; stage?: string } | null
  >(null)
  const [error, setError] = useState<string | null>(null)

  // Esc 关闭。与终端对话框保持一致。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const save = async () => {
    setSaving(true)
    setError(null)
    try {
      const port = Number(sshPort)
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error('端口必须是 1–65535 之间的整数')
      }
      await api.updateServer(server.id, {
        ssh_user: sshUser.trim() || 'root',
        ssh_port: port,
        // 空字符串要发 null,而不是 "" —— 后端用这个字段判断"是否指定专用密钥"
        ssh_key_path: keyPath.trim() || null,
        terminal_enabled: terminalEnabled,
      })
      onClose()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setSaving(false)
    }
  }

  const test = async () => {
    setTesting(true)
    setTestResult(null)
    setError(null)
    try {
      // 先保存再测:测试接口用的是数据库里的值,不保存就会测到旧配置
      const port = Number(sshPort)
      await api.updateServer(server.id, {
        ssh_user: sshUser.trim() || 'root',
        ssh_port: Number.isInteger(port) ? port : server.ssh_port,
        ssh_key_path: keyPath.trim() || null,
      })
      const res = await api.testServerSsh(server.id)
      setTestResult(res)
    } catch (err) {
      setTestResult({ ok: false, message: (err as Error).message })
    } finally {
      setTesting(false)
    }
  }

  const field =
    'h-8 w-full rounded-md border border-line bg-secondary px-2.5 text-[12.5px] text-ink outline-none transition-colors placeholder:text-ink-tertiary focus:border-accent'

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`${server.name} 的 SSH 凭据`}
        className="w-full max-w-[520px] overflow-hidden rounded-lg border border-line bg-primary shadow-xl"
      >
        {/* 标题 */}
        <div className="flex items-center gap-2 border-b border-line px-4 py-3">
          <h2 className="text-[14px] font-semibold text-ink">SSH 凭据</h2>
          <span className="truncate text-[11.5px] text-ink-tertiary">· {server.name}</span>
          <button
            type="button"
            onClick={onClose}
            aria-label="关闭"
            className="ms-auto cursor-pointer rounded-sm p-1 text-ink-tertiary transition-colors hover:bg-overlay-light hover:text-ink"
          >
            <X className="size-4" />
          </button>
        </div>

        <div className="flex flex-col gap-3.5 px-4 py-4">
          {/* 连接地址(只读) */}
          <div className="flex items-center gap-3 text-[12px]">
            <span className="w-20 shrink-0 text-ink-tertiary">连接地址</span>
            <span className="mono truncate text-ink-secondary">
              {server.ip ?? server.hostname ?? '未配置'}
            </span>
          </div>

          <div className="grid grid-cols-[1fr_100px] gap-3">
            <label className="flex flex-col gap-1">
              <span className="text-[11.5px] text-ink-tertiary">用户名</span>
              <input
                value={sshUser}
                onChange={(e) => setSshUser(e.target.value)}
                placeholder="root"
                className={field}
                autoComplete="off"
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-[11.5px] text-ink-tertiary">端口</span>
              <input
                value={sshPort}
                onChange={(e) => setSshPort(e.target.value)}
                inputMode="numeric"
                className={field}
              />
            </label>
          </div>

          <label className="flex flex-col gap-1">
            <span className="text-[11.5px] text-ink-tertiary">私钥路径</span>
            <input
              value={keyPath}
              onChange={(e) => setKeyPath(e.target.value)}
              placeholder="/root/.ssh/id_ed25519"
              className={cn(field, 'mono')}
              autoComplete="off"
            />
            <span className="text-[10.5px] text-ink-tertiary">
              留空则使用默认密钥(~/.ssh/id_ed25519)。路径是 <b>OpsDeck 容器内</b>的路径,
              不是目标机上的路径 —— 私钥需挂载进容器。
            </span>
          </label>

          {/* 终端开关 */}
          <label className="flex items-center gap-2.5 rounded-md bg-sunken px-3 py-2.5">
            <input
              type="checkbox"
              checked={terminalEnabled}
              onChange={(e) => setTerminalEnabled(e.target.checked)}
              className="size-3.5 cursor-pointer accent-[var(--t-accent)]"
            />
            <span className="text-[12px] text-ink">允许通过 Web 终端登录</span>
            <span className="ms-auto text-[10.5px] text-ink-tertiary">高危,需逐台开启</span>
          </label>

          {/* 测试结果 */}
          {testResult ? (
            <div
              className={cn(
                'flex items-start gap-2 rounded-md px-3 py-2 text-[12px]',
                testResult.ok ? 'bg-tint-success text-ink-success' : 'bg-tint-danger text-ink-danger',
              )}
            >
              {testResult.ok ? (
                <CheckCircle2 className="mt-0.5 size-3.5 shrink-0" />
              ) : (
                <XCircle className="mt-0.5 size-3.5 shrink-0" />
              )}
              <span className="min-w-0 break-words">{testResult.message}</span>
            </div>
          ) : null}

          {error ? (
            <p className="rounded-md bg-tint-danger px-3 py-2 text-[12px] text-ink-danger">{error}</p>
          ) : null}
        </div>

        {/* 底部操作 */}
        <div className="flex items-center gap-2 border-t border-line px-4 py-3">
          <GhostButton onClick={() => void test()} disabled={testing}>
            <span className="flex items-center gap-1.5">
              {testing ? <Loader2 className="size-3 animate-spin" /> : null}
              {testing ? '测试中…' : '测试连接'}
            </span>
          </GhostButton>
          <div className="ms-auto flex items-center gap-2">
            <GhostButton onClick={onClose}>取消</GhostButton>
            <PrimaryButton onClick={() => void save()} disabled={saving}>
              {saving ? '保存中…' : '保存'}
            </PrimaryButton>
          </div>
        </div>
      </div>
    </div>
  )
}
