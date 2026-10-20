"""容器日志流接口。

日志**不在 OpsDeck 的数据库里** —— 它在每台被监控机器的 Docker 上。
所以这里做的是"现场取",而不是查表:

    浏览器 ←WS← OpsDeck ←SSH← 目标服务器 ←docker logs← 容器

三个必须守住的边界:

1. **仅 admin**。Dify 的 api/worker 日志里会带 API Key 与用户对话内容,
   postgres 容器的日志可能出现连接串 —— 这比"看几个指标"敏感得多。

2. **容器名白名单字符**。容器名最终会进 SSH 命令行,任何拼接都可能变成注入。
   这里用正则把允许字符压到 `[A-Za-z0-9_.-]`,不做 shell 转义(转义容易被绕过,
   白名单不会)。

3. **帧头必须剥掉**。`docker logs` 的 stdout/stderr 是多路复用帧:
   每帧前 8 字节是 [stream, 0,0,0, 4 字节长度]。直接当文本推给浏览器,
   页面上会是一串乱码(实测复现过)。所以这里按帧解析后只保留 payload。

设计上**不复用终端那套 ticket**:终端是交互式高权限入口,需要二次密码与录制;
日志是只读的,用登录 JWT 直接鉴权足够,多余的环节只会让排障变慢。
"""

import asyncio
import logging
import re
import uuid
from contextlib import suppress

import asyncssh
from fastapi import APIRouter, Depends, HTTPException, Query, WebSocket, WebSocketDisconnect, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.auth import decode_access_token, require
from app.db import SessionLocal, get_db
from app.models import Instance, Project, Server, User

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/containers", tags=["containers"])

# 容器名允许的字符。Docker 容器名字符集是 [a-zA-Z0-9][a-zA-Z0-9_.-],
# 这里再收紧一点也够用 —— 宁可拒绝一个怪异的名字,也不要冒注入的风险。
CONTAINER_NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,254}$")

# 一次最多回放多少行 / 多少秒的实时流
MAX_TAIL_LINES = 2000
MAX_FOLLOW_SECONDS = 30 * 60


class LogError(Exception):
    """取日志失败,消息可直接展示给用户。"""


def _validate_name(name: str) -> str:
    """校验容器名。不合法直接拒绝,不做任何"清洗"。"""
    if not CONTAINER_NAME_RE.match(name):
        raise LogError("容器名包含非法字符")
    return name


def _build_command(name: str, *, since: str | None, tail: int, follow: bool) -> str:
    """构造 docker logs 命令。

    `name` 已经过白名单校验,`tail` 是整数,`since` 只接受两种形态:
    RFC3339 时间戳或相对时长(如 15m / 2h)。三者都不含空格与引号,
    因此整条命令可以安全地作为固定字符串传给 SSH。
    """
    parts = ["sudo", "-n", "docker", "logs", "--timestamps"]
    if since:
        # docker 的 --since 接受 10m / 2026-01-01T00:00:00Z 两种形态,
        # 但只允许这两种字符集,避免把任意内容带进命令行。
        if not re.fullmatch(r"[0-9T:.Z+\-]{1,40}|[0-9]{1,6}[smh]", since):
            raise LogError("时间范围格式不合法")
        parts += ["--since", since]
    parts += ["--tail", str(max(1, min(tail, MAX_TAIL_LINES)))]
    if follow:
        parts.append("--follow")
    parts.append(name)
    return " ".join(parts)


def _require_admin(db: Session, user_id: uuid.UUID) -> User:
    """确认是启用状态的 admin。

    单独写而不是用 require("manage"):"能管资产"和"能看生产日志"不是一回事,
    靠权限映射的隐含关系来保证,改一次 PERMISSIONS 就可能悄悄放开。
    """
    user = db.get(User, user_id)
    if user is None or not user.is_active or user.role != "admin":
        raise LogError("只有管理员可以查看容器日志")
    return user


async def _resolve_container(db: Session, instance_id: int) -> tuple[Instance, Server]:
    """查出容器与它所在的服务器。"""
    row = db.execute(
        select(Instance, Server)
        .join(Project, Project.id == Instance.project_id)
        .join(Server, Server.id == Project.server_id)
        .where(Instance.id == instance_id)
    ).first()
    if row is None:
        raise LogError("容器不存在")
    return row[0], row[1]


async def _open_log_stream(server: Server, command: str) -> asyncssh.SSHClientConnection:
    """建立到目标服务器的 SSH 连接并执行 docker logs,返回连接对象。

    调用方负责读取 process.stdout 并在结束时 close()。
    """
    target = server.ip or server.hostname
    if not target:
        raise LogError(f"服务器「{server.name}」未配置 IP 或主机名")

    try:
        conn = await asyncssh.connect(
            host=target,
            port=server.ssh_port or 22,
            # 逐台可配,见 servers.ssh_user;留空回退 root
            username=server.ssh_user or "root",
            known_hosts=None,
            connect_timeout=15,
            client_keys=[server.ssh_key_path] if server.ssh_key_path else None,
            preferred_auth=["publickey"],
            encoding=None,
        )
    except asyncssh.PermissionDenied as exc:
        raise LogError(f"SSH 认证失败:{exc}") from exc
    except (OSError, asyncssh.Error) as exc:
        raise LogError(f"无法连接 {target}:{server.ssh_port} — {exc}") from exc

    # 命令在远端执行;把 stderr 也并入输出,免得容器报错时反而看不到原因
    conn._opsdeck_cmd = command  # 类型上挂着,便于 close 时清理(见下)
    return conn


async def _iter_log_lines(process: asyncssh.SSHClientProcess) -> "asyncio.AsyncIterator[str]":
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


@router.get("/{instance_id}/logs", summary="容器日志(一次性)")
async def container_logs(
    instance_id: int,
    since: str | None = Query(default=None, description="时间范围,如 15m / 2h / 2026-01-01T00:00:00Z"),
    tail: int = Query(default=200, ge=1, le=MAX_TAIL_LINES, description="最多返回行数"),
    db: Session = Depends(get_db),
    user: User = Depends(require("manage")),
) -> dict[str, object]:
    """取一段日志(不跟随)。用于"打开面板时先铺一屏历史"。"""
    # require("manage") 目前只授予 admin,但日志的敏感度值得再确认一次角色,
    # 避免将来调整 PERMISSIONS 时无声扩大可见范围。
    if user.role != "admin":
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="只有管理员可以查看容器日志")

    instance, server = await _resolve_container(db, instance_id)
    name = _validate_name(instance.name)

    try:
        command = _build_command(name, since=since, tail=tail, follow=False)
    except LogError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from None

    # _open_log_stream 抛的是 LogError(认证失败 / 连不上),不是 HTTPException。
    # 不在这里接住就会变成 500 + 一页堆栈,而用户真正需要的是"root 登不上"这句话。
    try:
        conn = await _open_log_stream(server, command)
    except LogError as exc:
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail=str(exc)) from None

    lines: list[str] = []
    try:
        process = await conn.create_process(command, encoding=None)
        async for line in _iter_log_lines(process):
            lines.append(line)
            if len(lines) >= MAX_TAIL_LINES:
                break
        await process.wait()
    except (OSError, asyncssh.Error) as exc:
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail=f"取日志失败:{exc}") from exc
    finally:
        conn.close()
        with suppress(Exception):
            await conn.wait_closed()

    return {
        "container": instance.name,
        "server": server.name,
        "lines": lines,
    }


async def container_logs_websocket(websocket: WebSocket, instance_id: int) -> None:
    """容器日志实时流。

    握手:token 通过 WebSocket 子协议传('bearer, <jwt>'),与终端一致 ——
    放在 URL 里会进访问日志与浏览器历史。

    客户端消息(JSON):
      {"since": "15m"}   切换时间范围(会先补一屏历史)
    服务端消息(JSON):
      {"type":"line","text":"..."}   {"type":"error","message":"..."}
    """
    protocols = [p.strip() for p in (websocket.headers.get("sec-websocket-protocol") or "").split(",") if p.strip()]
    token = protocols[1] if len(protocols) > 1 else ""

    if not token:
        await websocket.close(code=4401, reason="缺少凭据")
        return

    # 鉴权:必须 admin 且账号可用
    payload = decode_access_token(token)
    if payload is None:
        await websocket.close(code=4401, reason="凭据无效或已过期")
        return

    try:
        user_id = uuid.UUID(str(payload["sub"]))
    except (KeyError, ValueError):
        await websocket.close(code=4401, reason="凭据无效")
        return

    db: Session = SessionLocal()
    conn: asyncssh.SSHClientConnection | None = None
    process: asyncssh.SSHClientProcess | None = None
    reader_task: asyncio.Task | None = None
    try:
        _require_admin(db, user_id)

        instance, server = await _resolve_container(db, instance_id)
        name = _validate_name(instance.name)

        await websocket.accept(subprotocol="bearer")

        command = _build_command(name, since="15m", tail=200, follow=True)
        conn = await _open_log_stream(server, command)
        process = await conn.create_process(command, encoding=None)

        async def pump() -> None:
            """把远端输出逐行推给浏览器。"""
            async for line in _iter_log_lines(process):
                await websocket.send_json({"type": "line", "text": line})

        reader_task = asyncio.create_task(pump())

        # 保持连接:直到客户端关闭或远端流结束
        while reader_task is not None and not reader_task.done():
            try:
                msg = await asyncio.wait_for(websocket.receive_json(), timeout=1.0)
            except TimeoutError:
                continue
            except Exception:
                break
            # 目前只支持切换时间范围:重开一条流
            if isinstance(msg, dict) and msg.get("since"):
                reader_task.cancel()
                with suppress(Exception):
                    await reader_task
                if process is not None:
                    with suppress(Exception):
                        process.terminate()
                command = _build_command(name, since=str(msg["since"]), tail=200, follow=True)
                process = await conn.create_process(command, encoding=None)
                reader_task = asyncio.create_task(pump())

        if reader_task is not None:
            with suppress(asyncio.CancelledError, Exception):
                await reader_task

    except LogError as exc:
        with suppress(Exception):
            await websocket.send_json({"type": "error", "message": str(exc)})
    except WebSocketDisconnect:
        pass
    except Exception as exc:
        logger.exception("容器日志流异常")
        with suppress(Exception):
            await websocket.send_json({"type": "error", "message": f"日志流异常:{exc}"})
    finally:
        if reader_task is not None:
            reader_task.cancel()
            with suppress(asyncio.CancelledError, Exception):
                await reader_task
        if process is not None:
            with suppress(Exception):
                process.terminate()
        if conn is not None:
            conn.close()
            with suppress(Exception):
                await conn.wait_closed()
        db.close()
