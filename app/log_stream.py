"""SSH 日志流公共设施。

容器日志与项目日志走同一条链路:

    浏览器 ←WS← OpsDeck ←SSH← 目标服务器 ←docker logs← 容器

这里只放与日志来源无关的部分:错误类型、时间范围校验、SSH 连接与按行读取。
"""

import re
from collections.abc import AsyncIterator
from contextlib import suppress

import asyncssh
from fastapi import WebSocket

from app.models import Server
from app.ssh_keys import resolve_ssh_key


class LogError(Exception):
    """取日志失败,消息可直接展示给用户。"""


# docker 的 --since 接受相对时长(15m / 2h)或 RFC3339 时间戳。
# 只允许这两种字符集,避免把任意内容带进 SSH 命令行。
SINCE_RE = re.compile(r"[0-9T:.Z+\-]{1,40}|[0-9]{1,6}[smh]")


def validate_since(since: str) -> str:
    """校验时间范围并原样返回;不合法直接拒绝,不做"清洗"。"""
    if not SINCE_RE.fullmatch(since):
        raise LogError("时间范围格式不合法")
    return since


def bearer_token(websocket: WebSocket) -> str:
    """从 WebSocket 子协议里取 token。

    客户端以 ['bearer', token] 建连;放在 URL 里会进访问日志与浏览器历史。
    """
    protocols = [p.strip() for p in (websocket.headers.get("sec-websocket-protocol") or "").split(",") if p.strip()]
    return protocols[1] if len(protocols) > 1 else ""


async def open_log_stream(server: Server, command: str) -> asyncssh.SSHClientConnection:
    """建立到目标服务器的 SSH 连接,返回连接对象。

    调用方负责 create_process 读取输出,并在结束时 close()。
    """
    target = server.ip or server.hostname
    if not target:
        raise LogError(f"服务器「{server.name}」未配置 IP 或主机名")

    key = resolve_ssh_key(server.ssh_key_path)

    try:
        conn = await asyncssh.connect(
            host=target,
            port=server.ssh_port or 22,
            # 逐台可配,见 servers.ssh_user;留空回退 root
            username=server.ssh_user or "root",
            known_hosts=None,
            connect_timeout=15,
            # asyncssh 把 None 当作"没有可用密钥";空元组才会加载默认密钥文件。
            client_keys=[key] if key else (),
            preferred_auth=["publickey"],
            encoding=None,
        )
    except asyncssh.PermissionDenied as exc:
        raise LogError(f"SSH 认证失败:{exc}") from exc
    except (OSError, asyncssh.Error) as exc:
        raise LogError(f"无法连接 {target}:{server.ssh_port} — {exc}") from exc

    return conn


async def iter_log_lines(process: asyncssh.SSHClientProcess) -> AsyncIterator[str]:
    """按行产出日志。

    Docker 的日志流是多路复用帧,但**经由 `docker logs` 命令**出来时,
    Docker CLI 已经在本地把帧解析成了纯文本流 —— 所以这里按行读即可。
    (只有直接请求 Docker HTTP API 才需要手工剥 8 字节帧头。)
    """
    buffer = b""
    while True:
        chunk = await process.stdout.read(65536)
        if not chunk:
            break
        buffer += chunk
        while b"\n" in buffer:
            line, buffer = buffer.split(b"\n", 1)
            yield line.decode("utf-8", errors="replace").rstrip("\r")
    if buffer:
        yield buffer.decode("utf-8", errors="replace").rstrip("\r")


async def close_stream(
    conn: asyncssh.SSHClientConnection | None,
    process: asyncssh.SSHClientProcess | None,
) -> None:
    """安静地关闭远端进程与连接,异常一律忽略。"""
    if process is not None:
        with suppress(Exception):
            process.terminate()
    if conn is not None:
        conn.close()
        with suppress(Exception):
            await conn.wait_closed()
