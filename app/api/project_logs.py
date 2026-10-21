"""项目级 Compose 日志接口。

与容器日志不同,这里面向整个 Compose 项目:

    docker compose -f <file> logs --timestamps --no-color --tail N [--follow]

几个约束:

1. **只读,不写操作记录**。原来的项目日志走白名单操作,每看一次就多一条
   ActionLog;查看日志不应该污染操作历史,也不该占用操作引擎的 SSH 超时。
2. **沿用 operate 权限**。这与原先「查看日志」操作一致;容器级日志因为
   直接暴露单个服务的密钥与用户内容,仍保持 admin 限制。
3. **工作目录经过 shell 转义**,且必须是绝对路径;`--since` 走白名单校验。
"""

import asyncio
import logging
import shlex
import uuid
from contextlib import suppress

import asyncssh
from fastapi import APIRouter, Depends, HTTPException, Query, WebSocket, WebSocketDisconnect, status
from sqlalchemy.orm import Session

from app.auth import decode_access_token, require
from app.db import SessionLocal, get_db
from app.discovery import validate_bare_compose_file
from app.log_stream import (
    LogError,
    bearer_token,
    close_stream,
    iter_log_lines,
    open_log_stream,
    validate_since,
)
from app.models import Project, Server, User

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/projects", tags=["projects"])

MAX_TAIL_LINES = 2000


def _require_operator(db: Session, user_id: uuid.UUID) -> User:
    """确认是启用状态的 operator/admin。

    与原先 logs 操作的 operate 权限保持一致:看项目日志不是资产管理,
    但也不应该对只读账号开放全部容器的输出。
    """
    user = db.get(User, user_id)
    if user is None or not user.is_active or user.role not in ("admin", "operator"):
        raise LogError("需要操作权限才能查看项目日志")
    return user


def _resolve_project(db: Session, project_id: uuid.UUID) -> tuple[Project, Server]:
    """未接管/已忽略的项目按不存在处理,避免猜 ID 读到别人的容器输出。"""
    project = db.get(Project, project_id)
    if project is None or project.lifecycle != "managed":
        raise LogError("项目不存在或尚未接管")
    if project.kind != "docker-compose":
        raise LogError(f"{project.kind} 项目没有 Compose 项目级日志")
    server = db.get(Server, project.server_id)
    if server is None:
        raise LogError("项目所属服务器不存在")
    return project, server


def _build_command(project: Project, *, since: str | None, tail: int, follow: bool) -> str:
    """构造 compose logs 命令。

    优先在工作目录里执行;自动发现的项目可能还没学到工作目录,此时用
    Compose 项目标签(`-p`)定位容器 —— `logs` 不需要 compose 文件,
    这条路径能让"没配置路径"的项目同样看到全部容器日志。

    路径经 shlex.quote;since 只接受相对时长或 RFC3339;tail 是整数。
    所有变量都不含空格与引号,整条命令可以安全地交给 SSH。
    """
    work_dir = (project.work_dir or "").strip()
    if work_dir:
        if not work_dir.startswith("/"):
            raise LogError("项目工作目录不是绝对路径,无法读取日志")
        parts = [f"cd {shlex.quote(work_dir)} && docker compose"]
        if project.compose_file:
            # 与项目配置接口使用同一套文件名规则,防止历史数据里的路径穿越。
            try:
                compose_file = validate_bare_compose_file(project.compose_file)
            except ValueError as exc:
                raise LogError(str(exc)) from None
            parts.append(f"-f {shlex.quote(compose_file)}")
    elif project.compose_project:
        # 固定 cd /,避免 SSH 登录目录里恰好有 compose 文件扰乱项目解析。
        parts = [f"cd / && docker compose -p {shlex.quote(project.compose_project)}"]
    else:
        raise LogError("项目未配置工作目录,请先在项目概览中补全后再查看日志")

    parts += ["logs", "--timestamps", "--no-color"]
    if since:
        parts += ["--since", validate_since(since)]
    # tail=0 表示只跟新行,不重放历史 —— 首屏历史由 REST 负责,避免重复。
    parts += ["--tail", str(max(0, min(tail, MAX_TAIL_LINES)))]
    if follow:
        parts.append("--follow")
    return " ".join(parts)


@router.get("/{project_id}/logs", summary="项目日志(一次性)")
async def project_logs(
    project_id: uuid.UUID,
    since: str | None = Query(default=None, description="时间范围,如 15m / 1h / 2026-01-01T00:00:00Z"),
    tail: int = Query(default=200, ge=1, le=MAX_TAIL_LINES, description="最多返回行数"),
    db: Session = Depends(get_db),
    _: User = Depends(require("operate")),
) -> dict[str, object]:
    """取一段项目日志(不跟随)。用于打开面板时先铺一屏历史。"""
    try:
        project, server = _resolve_project(db, project_id)
        command = _build_command(project, since=since, tail=tail, follow=False)
    except LogError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from None

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
        await close_stream(conn, None)

    return {
        "project": project.name,
        "server": server.name,
        "lines": lines,
    }


async def project_logs_websocket(websocket: WebSocket, project_id: uuid.UUID) -> None:
    """项目日志实时流。

    握手:token 通过 WebSocket 子协议传('bearer, <jwt>')。
    时间范围通过 ?since=15m 传入,一条流同时负责历史回放与实时跟随,
    不需要 REST 再拉一次(避免重复或缺口)。

    服务端消息:{"type":"ready"} / {"type":"line","text":"..."} / {"type":"end"}
                / {"type":"error","message":"..."}
    """
    token = bearer_token(websocket)

    if not token:
        await websocket.close(code=4401, reason="缺少凭据")
        return

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
        # 先完成握手,后面的鉴权/路径错误才能以 JSON 消息告诉前端,
        # 而不是让浏览器只看到一次无说明的断开。
        await websocket.accept(subprotocol="bearer")
        _require_operator(db, user_id)
        project, server = _resolve_project(db, project_id)

        since = websocket.query_params.get("since")
        command = _build_command(project, since=since, tail=200 if since else 0, follow=True)
        # 后续是长时间跟随,不再需要数据库连接,提前归还连接池。
        db.close()

        conn = await open_log_stream(server, command)
        process = await conn.create_process(command, encoding=None, stderr=asyncssh.STDOUT)
        with suppress(Exception):
            await websocket.send_json({"type": "ready"})

        async def pump() -> None:
            async for line in iter_log_lines(process):
                await websocket.send_json({"type": "line", "text": line})
            # 项目没有运行中的容器时 --follow 会立即结束,告诉前端别再显示"实时"。
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
        logger.exception("项目日志流异常")
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
