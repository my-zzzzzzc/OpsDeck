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
from app.log_stream import (
    LogError,
    bearer_token,
    close_stream,
    iter_log_lines,
    open_log_stream,
    validate_since,
)
from app.models import Instance, Project, Server, User

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/containers", tags=["containers"])

# 容器名允许的字符。Docker 容器名字符集是 [a-zA-Z0-9][a-zA-Z0-9_.-],
# 这里再收紧一点也够用 —— 宁可拒绝一个怪异的名字,也不要冒注入的风险。
CONTAINER_NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,254}$")

# 一次最多回放多少行 / 多少秒的实时流
MAX_TAIL_LINES = 2000


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
        parts += ["--since", validate_since(since)]
    # tail=0 表示只跟新行,不重放历史 —— 首屏历史由 REST 负责,避免重复。
    parts += ["--tail", str(max(0, min(tail, MAX_TAIL_LINES)))]
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
    """查出容器与它所在的服务器。未接管项目的容器按不存在处理。"""
    row = db.execute(
        select(Instance, Server)
        .join(Project, Project.id == Instance.project_id)
        .join(Server, Server.id == Project.server_id)
        .where(Instance.id == instance_id, Project.lifecycle == "managed")
    ).first()
    if row is None:
        raise LogError("容器不存在")
    return row[0], row[1]


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

    # open_log_stream 抛的是 LogError(认证失败 / 连不上),不是 HTTPException。
    # 不在这里接住就会变成 500 + 一页堆栈,而用户真正需要的是"root 登不上"这句话。
    try:
        conn = await open_log_stream(server, command)
    except LogError as exc:
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail=str(exc)) from None

    lines: list[str] = []
    try:
        process = await conn.create_process(command, encoding=None, stderr=asyncssh.STDOUT)
        async for line in iter_log_lines(process):
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
    放在 URL 里会进访问日志与浏览器历史。时间范围通过 ?since=15m 传入,
    一条流同时负责历史回放与实时跟随,不需要 REST 再拉一次(避免重复或缺口)。

    服务端消息(JSON):
      {"type":"ready"}  {"type":"line","text":"..."}  {"type":"end"}
      {"type":"error","message":"..."}
    """
    token = bearer_token(websocket)

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
        # 先完成握手,后面的鉴权/容器/时间范围错误才能以 JSON 消息告诉前端,
        # 而不是让浏览器只看到一次无说明的断开。
        await websocket.accept(subprotocol="bearer")
        _require_admin(db, user_id)

        instance, server = await _resolve_container(db, instance_id)
        name = _validate_name(instance.name)

        since = websocket.query_params.get("since")
        # 有 since 就回放一段历史再跟随;没有就只跟新行。
        command = _build_command(name, since=since, tail=200 if since else 0, follow=True)
        # 后续是长时间跟随,不再需要数据库连接,提前归还连接池。
        db.close()

        conn = await open_log_stream(server, command)
        process = await conn.create_process(command, encoding=None, stderr=asyncssh.STDOUT)
        with suppress(Exception):
            await websocket.send_json({"type": "ready"})

        async def pump() -> None:
            """把远端输出逐行推给浏览器。"""
            async for line in iter_log_lines(process):
                await websocket.send_json({"type": "line", "text": line})
            # 远端流结束(容器停止)时告诉前端,避免状态一直停在"实时"。
            with suppress(Exception):
                await websocket.send_json({"type": "end"})

        reader_task = asyncio.create_task(pump())

        # 保持连接:直到客户端关闭或远端流结束
        while reader_task is not None and not reader_task.done():
            try:
                await asyncio.wait_for(websocket.receive_text(), timeout=1.0)
            except TimeoutError:
                continue
            except Exception:
                break

        if reader_task is not None:
            with suppress(asyncio.CancelledError, Exception):
                await reader_task
        with suppress(Exception):
            await websocket.close()

    except LogError as exc:
        with suppress(Exception):
            await websocket.send_json({"type": "error", "message": str(exc)})
            # 只发消息不 close 时,uvicorn 会直接断开 TCP,客户端只看到 1006
            # 而收不到错误内容 —— 显式关闭让前端能稳定显示原因。
            await websocket.close(code=1011)
    except WebSocketDisconnect:
        pass
    except Exception as exc:
        logger.exception("容器日志流异常")
        with suppress(Exception):
            await websocket.send_json({"type": "error", "message": f"日志流异常:{exc}"})
            await websocket.close(code=1011)
    finally:
        if reader_task is not None:
            reader_task.cancel()
            with suppress(asyncio.CancelledError, Exception):
                await reader_task
        await close_stream(conn, process)
        db.close()
