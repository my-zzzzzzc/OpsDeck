"""服务器资产管理接口。"""

import uuid

from fastapi import APIRouter, Depends, HTTPException, Request, status
from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload

from app.audit import record_audit
from app.auth import client_ip, require
from app.db import get_db
from app.models import Server, User
from app.schemas.assets import (
    ServerCreate,
    ServerRead,
    ServerTokenRead,
    ServerUpdate,
    ServerWithProjects,
)

router = APIRouter(prefix="/servers", tags=["servers"])


def _get_server_or_404(db: Session, server_id: uuid.UUID) -> Server:
    """按 ID 取服务器,不存在则抛 404。"""
    server = db.get(Server, server_id)
    if server is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="服务器不存在")
    return server


@router.get("", response_model=list[ServerRead], summary="服务器列表")
def list_servers(db: Session = Depends(get_db), _: User = Depends(require("view"))) -> list[Server]:
    """返回全部服务器,按名称排序。"""
    return list(db.scalars(select(Server).order_by(Server.name)))


@router.post("", response_model=ServerRead, status_code=status.HTTP_201_CREATED, summary="新增服务器")
def create_server(
    payload: ServerCreate,
    request: Request,
    db: Session = Depends(get_db),
    actor: User = Depends(require("manage")),
) -> Server:
    """新增一台服务器。名称重复时返回 409。"""
    exists = db.scalar(select(Server).where(Server.name == payload.name))
    if exists is not None:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=f"服务器名称已存在: {payload.name}")

    server = Server(**payload.model_dump())
    db.add(server)
    db.flush()

    record_audit(
        db,
        user_id=actor.id,
        username=actor.username,
        action="create",
        target_type="server",
        target_id=str(server.id),
        target_name=server.name,
        ip=client_ip(request),
    )
    db.commit()
    db.refresh(server)
    return server


@router.get("/{server_id}", response_model=ServerWithProjects, summary="服务器详情")
def get_server(server_id: uuid.UUID, db: Session = Depends(get_db), _: User = Depends(require("view"))) -> Server:
    """返回服务器详情及其下的项目列表。"""
    server = db.scalar(select(Server).where(Server.id == server_id).options(selectinload(Server.projects)))
    if server is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="服务器不存在")
    return server


@router.patch("/{server_id}", response_model=ServerRead, summary="更新服务器")
def update_server(
    server_id: uuid.UUID,
    payload: ServerUpdate,
    request: Request,
    db: Session = Depends(get_db),
    actor: User = Depends(require("manage")),
) -> Server:
    """局部更新服务器字段。"""
    server = _get_server_or_404(db, server_id)

    changes = payload.model_dump(exclude_unset=True)
    if "name" in changes and changes["name"] != server.name:
        exists = db.scalar(select(Server).where(Server.name == changes["name"]))
        if exists is not None:
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=f"服务器名称已存在: {changes['name']}")

    for field, value in changes.items():
        setattr(server, field, value)

    record_audit(
        db,
        user_id=actor.id,
        username=actor.username,
        action="update",
        target_type="server",
        target_id=str(server.id),
        target_name=server.name,
        ip=client_ip(request),
        detail=f"更新字段: {', '.join(changes.keys())}",
    )
    db.commit()
    db.refresh(server)
    return server


@router.delete("/{server_id}", status_code=status.HTTP_204_NO_CONTENT, summary="删除服务器")
def delete_server(
    server_id: uuid.UUID,
    request: Request,
    db: Session = Depends(get_db),
    actor: User = Depends(require("manage")),
) -> None:
    """删除服务器,级联删除其下项目。"""
    server = _get_server_or_404(db, server_id)
    record_audit(
        db,
        user_id=actor.id,
        username=actor.username,
        action="delete",
        target_type="server",
        target_id=str(server.id),
        target_name=server.name,
        ip=client_ip(request),
    )
    db.delete(server)
    db.commit()


@router.get("/{server_id}/token", response_model=ServerTokenRead, summary="获取采集器凭证")
def get_server_token(
    server_id: uuid.UUID, db: Session = Depends(get_db), _: User = Depends(require("manage"))
) -> Server:
    """返回该服务器采集器上报所使用的 token。"""
    return _get_server_or_404(db, server_id)


@router.post("/{server_id}/token/rotate", response_model=ServerTokenRead, summary="轮换采集器凭证")
def rotate_server_token(
    server_id: uuid.UUID,
    request: Request,
    db: Session = Depends(get_db),
    actor: User = Depends(require("manage")),
) -> Server:
    """重新生成凭证,旧凭证立即失效。"""
    server = _get_server_or_404(db, server_id)
    server.agent_token = uuid.uuid4().hex
    record_audit(
        db,
        user_id=actor.id,
        username=actor.username,
        action="execute",
        target_type="server",
        target_id=str(server.id),
        target_name=server.name,
        ip=client_ip(request),
        detail="轮换采集凭证",
    )
    db.commit()
    db.refresh(server)
    return server
