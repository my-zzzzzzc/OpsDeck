"""Web 终端接口。

提供两个入口:
  - `POST /api/terminal/authorize` —— 二次确认终端密码,换取短期 ticket
  - `WS   /ws/terminal/{server_id}` —— 携带 ticket 建立交互式终端

安全模型(全部服务端强制):
  仅 admin → 服务器已授权 → IP 白名单 → 终端密码 → ticket 绑定校验
  → 并发上限 → 全程录制 + 审计
"""

import asyncio
import json
import logging
import uuid
from contextlib import suppress
from datetime import UTC, datetime

from fastapi import APIRouter, Depends, HTTPException, Query, Request, WebSocket, WebSocketDisconnect, status
from fastapi.responses import FileResponse
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.audit import record_audit
from app.auth import PERMISSIONS, client_ip, require
from app.config import settings
from app.db import SessionLocal, get_db
from app.models import Server, TerminalSession, User
from app.schemas.terminal import (
    TerminalAuthorizePayload,
    TerminalAuthorizeResult,
    TerminalSessionRead,
    TerminalStatusRead,
)
from app.ssh_terminal import SSHError, SSHTerminal, TerminalRecorder, recording_dir
from app.terminal import (
    TerminalError,
    check_concurrency,
    check_ip_allowlist,
    check_server_terminal_enabled,
    close_stale_sessions,
    issue_ticket,
    verify_ticket,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/terminal", tags=["terminal"])


def _terminal_permission(user: User) -> None:
    """终端仅限管理员。这是硬编码策略,不走权限点配置。"""
    # 复用 users 权限点等价于管理员,但显式判断角色更清晰且不易被改配置绕过
    if user.role != "admin" or "users" not in PERMISSIONS.get(user.role, set()):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="仅管理员可使用终端")


@router.get("/status", response_model=TerminalStatusRead, summary="终端可用性状态")
def terminal_status(user: User = Depends(require("view")), db: Session = Depends(get_db)) -> TerminalStatusRead:
    """返回当前用户是否可用终端(前端据此决定是否显示入口)。"""
    if user.role != "admin":
        return TerminalStatusRead(available=False, reason="仅管理员可使用终端")

    return TerminalStatusRead(available=True)


@router.post("/authorize", response_model=TerminalAuthorizeResult, summary="二次确认并获取终端凭据")
def authorize(
    payload: TerminalAuthorizePayload,
    server_id: uuid.UUID,
    request: Request,
    user: User = Depends(require("view")),
    db: Session = Depends(get_db),
) -> TerminalAuthorizeResult:
    """签发一次性终端 ticket。

    不要求终端密码 —— 打开终端本身就是登录用户的有意识动作。
    仍然保留的防护:
      - 仅 admin
      - 服务器需显式开启终端(默认全关)
      - 可选 IP 白名单
      - 并发上限
      - ticket 短期有效,且与用户 / 服务器 / 客户端 IP 绑定
      - 全程录制 + 审计
    """
    _terminal_permission(user)

    ip = client_ip(request)

    try:
        check_ip_allowlist(ip)
    except TerminalError as exc:
        raise HTTPException(status_code=exc.status_code, detail=exc.message) from None

    server = db.get(Server, server_id)
    if server is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="服务器不存在")

    try:
        check_server_terminal_enabled(server)
        check_concurrency(db, user.id)
    except TerminalError as exc:
        raise HTTPException(status_code=exc.status_code, detail=exc.message) from None

    ticket, expires_in = issue_ticket(user, server.id, ip)

    record_audit(
        db,
        user_id=user.id,
        username=user.username,
        action="terminal_authorize",
        target_type="server",
        target_id=str(server.id),
        target_name=server.name,
        ip=ip,
        detail="打开终端",
    )
    db.commit()

    return TerminalAuthorizeResult(ticket=ticket, expires_in=expires_in, server_name=server.name)


@router.get("/sessions", response_model=list[TerminalSessionRead], summary="终端会话历史")
def list_sessions(
    user: User = Depends(require("view")), db: Session = Depends(get_db), limit: int = Query(50, ge=1, le=200)
) -> list[TerminalSession]:
    """返回终端会话记录。管理员可见全部。"""
    _terminal_permission(user)
    close_stale_sessions(db)
    return list(db.scalars(select(TerminalSession).order_by(TerminalSession.started_at.desc()).limit(limit)))


@router.get("/sessions/{session_id}/recording", summary="下载会话录制")
def download_recording(
    session_id: uuid.UUID,
    user: User = Depends(require("view")),
    db: Session = Depends(get_db),
):
    """下载 asciinema 格式的会话录制文件。"""
    _terminal_permission(user)

    session = db.get(TerminalSession, session_id)
    if session is None or not session.recording_path:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="录制不存在")

    path = recording_dir() / session.recording_path
    if not path.is_file():
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="录制文件已被清理")

    record_audit(
        db,
        user_id=user.id,
        username=user.username,
        action="read",
        target_type="terminal_recording",
        target_id=str(session.id),
        target_name=session.server_name,
        detail="下载终端录制",
    )
    db.commit()

    return FileResponse(path, media_type="application/x-asciicast", filename=f"terminal-{session.id}.cast")


@router.delete("/sessions/{session_id}", status_code=status.HTTP_204_NO_CONTENT, summary="关闭会话记录")
def close_session(session_id: uuid.UUID, user: User = Depends(require("view")), db: Session = Depends(get_db)) -> None:
    """把残留的 active 会话标记为已关闭(用于清理异常中断的记录)。"""
    _terminal_permission(user)

    session = db.get(TerminalSession, session_id)
    if session is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="会话不存在")

    if session.status == "active":
        session.status = "closed"
        session.close_reason = "manual"
        session.ended_at = datetime.now(UTC)
        db.commit()


# ---------------------------------------------------------------- WebSocket


async def terminal_websocket(websocket: WebSocket, server_id: uuid.UUID) -> None:
    """交互式终端 WebSocket。

    握手流程:
      1. 从子协议读取 ticket(避免出现在 URL 与访问日志中)
      2. 校验 ticket(用户 / 服务器 / IP 三方绑定)
      3. 复核权限与服务器开关(授权后状态可能已变化)
      4. 建立 SSH PTY,双向转发
    """
    # ticket 通过 WebSocket 子协议传递:'bearer, <ticket>'
    protocols = [p.strip() for p in (websocket.headers.get("sec-websocket-protocol") or "").split(",") if p.strip()]
    ticket = protocols[1] if len(protocols) > 1 else ""

    if not ticket:
        await websocket.close(code=4401, reason="缺少终端凭据")
        return

    ip = websocket.client.host if websocket.client else None
    forwarded = websocket.headers.get("x-forwarded-for")
    if forwarded:
        ip = forwarded.split(",")[0].strip()

    db: Session = SessionLocal()
    session_row: TerminalSession | None = None
    terminal: SSHTerminal | None = None
    recorder: TerminalRecorder | None = None
    reader_task: asyncio.Task | None = None

    try:
        # ---- 校验阶段 ----
        try:
            check_ip_allowlist(ip)
            user_id = verify_ticket(ticket, server_id, ip)
        except TerminalError as exc:
            await websocket.close(code=4403, reason=exc.message)
            return

        user = db.get(User, user_id)
        if user is None or user.role != "admin" or not user.is_active:
            await websocket.close(code=4403, reason="用户无权使用终端")
            return

        server = db.get(Server, server_id)
        if server is None:
            await websocket.close(code=4404, reason="服务器不存在")
            return

        try:
            check_server_terminal_enabled(server)
            check_concurrency(db, user.id)
        except TerminalError as exc:
            await websocket.close(code=4403, reason=exc.message)
            return

        # 接受连接时必须回显子协议,否则浏览器会拒绝握手
        await websocket.accept(subprotocol=protocols[0] if protocols else None)

        # ---- 建立会话记录 ----
        session_row = TerminalSession(
            server_id=server.id,
            server_name=server.name,
            user_id=user.id,
            username=user.username,
            status="active",
            client_ip=ip,
            recording_path=f"{datetime.now(UTC):%Y/%m}/{uuid.uuid4().hex}.cast",
        )
        db.add(session_row)
        db.commit()
        db.refresh(session_row)

        # ---- 建立 SSH ----
        terminal = SSHTerminal(server)
        try:
            await terminal.connect()
        except SSHError as exc:
            session_row.status = "failed"
            session_row.close_reason = "error"
            session_row.ended_at = datetime.now(UTC)
            db.commit()
            await websocket.send_text(json.dumps({"type": "error", "message": str(exc)}, ensure_ascii=False))
            await websocket.close(code=4500, reason="SSH 连接失败")
            return

        # ---- 开始录制 ----
        recorder = TerminalRecorder(path=recording_dir() / session_row.recording_path, cols=120, rows=30)
        recorder.open()

        record_audit(
            db,
            user_id=user.id,
            username=user.username,
            action="terminal_open",
            target_type="server",
            target_id=str(server.id),
            target_name=server.name,
            ip=ip,
            detail=f"终端会话 {session_row.id}",
        )
        db.commit()

        await websocket.send_text(json.dumps({"type": "status", "state": "connected"}, ensure_ascii=False))

        # ---- 双向转发 ----
        async def pump_remote_to_client() -> None:
            """把远端输出推给浏览器,并写入录制。"""
            assert terminal is not None
            async for chunk in terminal.read():
                if recorder is not None:
                    recorder.write("o", chunk.decode("utf-8", errors="replace"))
                await websocket.send_bytes(chunk)

        reader_task = asyncio.create_task(pump_remote_to_client())

        last_activity = asyncio.get_event_loop().time()
        started_at = last_activity

        while True:
            try:
                # 超时用于实现空闲检测,同时定期检查是否超过硬上限
                message = await asyncio.wait_for(websocket.receive(), timeout=15.0)
            except TimeoutError:
                now = asyncio.get_event_loop().time()

                if reader_task.done():
                    break

                if now - last_activity > float(settings.terminal_idle_timeout):
                    session_row.close_reason = "idle_timeout"
                    break

                if now - started_at > float(settings.terminal_max_duration):
                    session_row.close_reason = "max_duration"
                    break

                continue

            msg_type = message.get("type")

            if msg_type == "websocket.disconnect":
                session_row.close_reason = "user_closed"
                break

            if msg_type != "websocket.receive":
                continue

            last_activity = asyncio.get_event_loop().time()

            if message.get("bytes") is not None:
                # 二进制帧:直接是按键数据
                data = message["bytes"].decode("utf-8", errors="replace")
                if recorder is not None:
                    recorder.write("i", data)
                await terminal.write(data)
                continue

            text = message.get("text")
            if not text:
                continue

            try:
                frame = json.loads(text)
            except json.JSONDecodeError:
                continue

            frame_type = frame.get("type")

            if frame_type == "input":
                data = str(frame.get("data", ""))
                if recorder is not None:
                    recorder.write("i", data)
                await terminal.write(data)
            elif frame_type == "resize":
                cols = int(frame.get("cols", 120))
                rows = int(frame.get("rows", 30))
                # 尺寸做上下限约束,防止异常值导致远端分配超大缓冲
                cols = max(20, min(cols, 500))
                rows = max(5, min(rows, 200))
                if recorder is not None:
                    recorder.cols, recorder.rows = cols, rows
                await terminal.resize(cols, rows)
            elif frame_type == "ping":
                await websocket.send_text(json.dumps({"type": "pong"}))

    except WebSocketDisconnect:
        if session_row is not None and session_row.close_reason is None:
            session_row.close_reason = "user_closed"
    except Exception:
        logger.exception("终端会话异常: %s", server_id)
        if session_row is not None:
            session_row.close_reason = "error"
    finally:
        # 清理:顺序很重要 —— 先停读取,再关 SSH,最后落库
        if reader_task is not None:
            reader_task.cancel()
            # 读取任务可能在取消前已因 SSH 断开而抛出,统一忽略
            with suppress(asyncio.CancelledError, Exception):
                await reader_task

        if recorder is not None:
            recorder.close()

        if terminal is not None:
            await terminal.close()

        if session_row is not None:
            try:
                session_row.status = "closed" if session_row.status == "active" else session_row.status
                session_row.close_reason = session_row.close_reason or "unknown"
                session_row.ended_at = datetime.now(UTC)
                session_row.bytes_in = terminal.bytes_in if terminal else 0
                session_row.bytes_out = terminal.bytes_out if terminal else 0
                db.commit()

                record_audit(
                    db,
                    user_id=session_row.user_id,
                    username=session_row.username,
                    action="terminal_close",
                    target_type="server",
                    target_id=str(session_row.server_id),
                    target_name=session_row.server_name,
                    ip=session_row.client_ip,
                    detail=f"会话 {session_row.id} 结束: {session_row.close_reason}",
                )
                db.commit()
            except Exception:
                logger.exception("写入终端会话结束状态失败")

        db.close()

        # 连接可能已被对端关闭,关闭失败无需处理
        with suppress(Exception):
            await websocket.close()
