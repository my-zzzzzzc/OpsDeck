"""Dify 应用管理与对话代理接口。"""

import json
import logging
import uuid
from collections.abc import AsyncIterator

from fastapi import APIRouter, Depends, HTTPException, Request, status
from fastapi.responses import StreamingResponse
from sqlalchemy import select
from sqlalchemy.orm import Session

from app import dify
from app.audit import record_audit
from app.auth import CurrentUser, client_ip, require
from app.db import get_db
from app.models import ChatConversation, DifyApp, User
from app.schemas.dify import (
    ChatConversationRead,
    ChatRequest,
    DifyAppCreate,
    DifyAppUpdate,
    DifyAppWithKey,
    DifyHealthResult,
)

logger = logging.getLogger(__name__)

router = APIRouter(tags=["dify"])


def mask_key(key: str) -> str:
    """把 API Key 掩码成 app-xxxx****yyyy 形式,用于界面展示。"""
    if len(key) <= 12:
        return key[:4] + "****"
    return f"{key[:8]}****{key[-4:]}"


def _to_with_key(app: DifyApp) -> DifyAppWithKey:
    """构造带掩码 Key 的响应视图。"""
    return DifyAppWithKey(
        id=app.id,
        name=app.name,
        mode=app.mode,
        description=app.description,
        is_default=app.is_default,
        is_active=app.is_active,
        created_at=app.created_at,
        api_key_masked=mask_key(app.api_key),
    )


def _resolve_app(db: Session, app_id: uuid.UUID | None) -> DifyApp:
    """按 ID 取应用;未指定则取默认应用。"""
    if app_id is not None:
        app = db.get(DifyApp, app_id)
        if app is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Dify 应用不存在")
        if not app.is_active:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="该应用已停用")
        return app

    app = db.scalar(select(DifyApp).where(DifyApp.is_default.is_(True), DifyApp.is_active.is_(True)))
    if app is None:
        # 没有显式默认时取最早创建的一个
        app = db.scalar(select(DifyApp).where(DifyApp.is_active.is_(True)).order_by(DifyApp.created_at))
    if app is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="尚未登记任何 Dify 应用,请先在设置中添加",
        )
    return app


# ---------------------------------------------------------------- 应用管理


@router.get("/dify/apps", response_model=list[DifyAppWithKey], summary="Dify 应用列表")
def list_dify_apps(
    db: Session = Depends(get_db),
    _: User = Depends(require("view")),
) -> list[DifyAppWithKey]:
    """列出已登记的 Dify 应用(Key 已掩码)。"""
    apps = db.scalars(select(DifyApp).order_by(DifyApp.created_at))
    return [_to_with_key(a) for a in apps]


@router.post(
    "/dify/apps",
    response_model=DifyAppWithKey,
    status_code=status.HTTP_201_CREATED,
    summary="登记 Dify 应用",
)
def create_dify_app(
    payload: DifyAppCreate,
    request: Request,
    db: Session = Depends(get_db),
    actor: User = Depends(require("manage")),
) -> DifyAppWithKey:
    """登记一个 Dify 应用。名称重复返回 409。"""
    if db.scalar(select(DifyApp).where(DifyApp.name == payload.name)) is not None:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=f"应用名已存在: {payload.name}")

    # 首个应用自动设为默认,省去一次手工设置
    is_first = db.scalar(select(DifyApp.id).limit(1)) is None
    is_default = payload.is_default or is_first

    if is_default:
        _clear_default(db)

    app = DifyApp(
        name=payload.name,
        api_key=payload.api_key,
        mode=payload.mode,
        description=payload.description,
        is_default=is_default,
    )
    db.add(app)
    db.flush()

    record_audit(
        db,
        user_id=actor.id,
        username=actor.username,
        action="create",
        target_type="dify_app",
        target_id=str(app.id),
        target_name=app.name,
        ip=client_ip(request),
        detail=f"模式 {app.mode}",
    )
    db.commit()
    db.refresh(app)
    return _to_with_key(app)


@router.patch("/dify/apps/{app_id}", response_model=DifyAppWithKey, summary="更新 Dify 应用")
def update_dify_app(
    app_id: uuid.UUID,
    payload: DifyAppUpdate,
    request: Request,
    db: Session = Depends(get_db),
    actor: User = Depends(require("manage")),
) -> DifyAppWithKey:
    """更新应用。api_key 留空则保持原值。"""
    app = db.get(DifyApp, app_id)
    if app is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Dify 应用不存在")

    changes = payload.model_dump(exclude_unset=True)

    if changes.get("is_default") is True:
        _clear_default(db)

    # 空字符串表示"不修改 Key",避免误清空
    if not changes.get("api_key"):
        changes.pop("api_key", None)

    for field, value in changes.items():
        setattr(app, field, value)

    record_audit(
        db,
        user_id=actor.id,
        username=actor.username,
        action="update",
        target_type="dify_app",
        target_id=str(app.id),
        target_name=app.name,
        ip=client_ip(request),
        detail=f"更新字段: {', '.join(changes.keys()) or '无'}",
    )
    db.commit()
    db.refresh(app)
    return _to_with_key(app)


@router.delete("/dify/apps/{app_id}", status_code=status.HTTP_204_NO_CONTENT, summary="删除 Dify 应用")
def delete_dify_app(
    app_id: uuid.UUID,
    request: Request,
    db: Session = Depends(get_db),
    actor: User = Depends(require("manage")),
) -> None:
    """删除应用。"""
    app = db.get(DifyApp, app_id)
    if app is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Dify 应用不存在")

    record_audit(
        db,
        user_id=actor.id,
        username=actor.username,
        action="delete",
        target_type="dify_app",
        target_id=str(app.id),
        target_name=app.name,
        ip=client_ip(request),
    )
    db.delete(app)
    db.commit()


@router.post("/dify/apps/{app_id}/ping", response_model=DifyHealthResult, summary="探测应用连通性")
async def ping_dify_app(
    app_id: uuid.UUID,
    db: Session = Depends(get_db),
    _: User = Depends(require("manage")),
) -> DifyHealthResult:
    """用一次最简对话验证 API Key 是否有效。"""
    app = db.get(DifyApp, app_id)
    if app is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Dify 应用不存在")

    result = await dify.ping(app.api_key)
    return DifyHealthResult(**result)


def _clear_default(db: Session) -> None:
    """把现有默认应用取消,保证全局只有一个默认。"""
    for existing in db.scalars(select(DifyApp).where(DifyApp.is_default.is_(True))):
        existing.is_default = False


# ---------------------------------------------------------------- 对话


@router.post(
    "/chat/stream",
    summary="流式对话(SSE)",
    description=(
        "代理 Dify 的流式响应。返回 `text/event-stream`,逐块透传 Dify 原始 SSE 事件,"
        "前端按 Dify 的 `message` / `message_end` / `error` 事件协议解析即可。"
        "API Key 保留在服务端,不会下发给前端。"
    ),
)
async def chat_stream(
    payload: ChatRequest,
    db: Session = Depends(get_db),
    user: User = Depends(require("view")),
) -> StreamingResponse:
    """把前端请求转发给 Dify,并把 SSE 流原样透传回去。"""
    app = _resolve_app(db, payload.app_id)

    if not app.api_key:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="该应用未配置 API Key")

    # 用 OpsDeck 用户 ID 作为 Dify 的终端用户标识,便于在 Dify 侧区分来源
    dify_user = f"opsdeck-{user.id}"

    # 记录会话,首轮对话时创建本地记录
    conversation = None
    if payload.conversation_id:
        conversation = db.scalar(
            select(ChatConversation).where(
                ChatConversation.dify_conversation_id == payload.conversation_id,
                ChatConversation.user_id == user.id,
            )
        )
    if conversation is None:
        conversation = ChatConversation(
            user_id=user.id,
            dify_app_id=app.id,
            dify_conversation_id=payload.conversation_id or None,
            title=payload.query[:60],
        )
        db.add(conversation)
        db.commit()

    async def event_stream() -> AsyncIterator[bytes]:
        """透传 Dify 事件流。上游错误转换为 SSE error 事件,避免连接直接断开。"""
        try:
            async for chunk in dify.stream_chat(
                api_key=app.api_key,
                query=payload.query,
                user=dify_user,
                inputs=payload.inputs,
                conversation_id=payload.conversation_id,
            ):
                yield chunk
        except dify.DifyError as exc:
            logger.warning("对话失败: %s", exc.message)
            error_event = {
                "event": "error",
                "message": exc.message,
            }
            yield f"data: {json.dumps(error_event, ensure_ascii=False)}\n\n".encode()
        except Exception:
            logger.exception("对话流异常中断")
            error_event = {"event": "error", "message": "服务内部错误,请查看后端日志"}
            yield f"data: {json.dumps(error_event, ensure_ascii=False)}\n\n".encode()

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            # 关闭 Nginx/Caddy 的响应缓冲,否则流式输出会被攒批
            "X-Accel-Buffering": "no",
        },
    )


@router.get("/chat/conversations", response_model=list[ChatConversationRead], summary="我的会话列表")
def list_my_conversations(
    user: CurrentUser,
    db: Session = Depends(get_db),
) -> list[ChatConversation]:
    """返回当前用户在本地的会话记录,按最近活跃排序。"""
    return list(
        db.scalars(
            select(ChatConversation)
            .where(ChatConversation.user_id == user.id)
            .order_by(ChatConversation.updated_at.desc())
            .limit(50)
        )
    )


@router.delete(
    "/chat/conversations/{conversation_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    summary="删除会话",
)
def delete_conversation(
    conversation_id: uuid.UUID,
    user: CurrentUser,
    db: Session = Depends(get_db),
) -> None:
    """删除自己的会话记录。"""
    conversation = db.get(ChatConversation, conversation_id)
    if conversation is None or conversation.user_id != user.id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="会话不存在")
    db.delete(conversation)
    db.commit()
