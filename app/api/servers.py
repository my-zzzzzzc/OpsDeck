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


@router.post("/{server_id}/ssh-test", summary="测试 SSH 连接")
async def test_ssh(
    server_id: uuid.UUID,
    db: Session = Depends(get_db),
    _: User = Depends(require("manage")),
) -> dict[str, object]:
    """用当前配置的凭据实际连一次目标机,返回成功与否。

    为什么值得单独做一个接口:凭据填错了,症状是"日志/终端一直失败",
    而错误信息往往埋在服务端日志里。让用户在保存前点一下就拿到明确结论
    (认证失败 / 连不上 / 密钥读不到),比事后翻日志省事得多。

    只执行 `true`,不碰 docker,也不改变目标机任何状态。
    """
    import asyncssh

    server = _get_server_or_404(db, server_id)
    target = server.ip or server.hostname
    if not target:
        return {"ok": False, "stage": "config", "message": "服务器未配置 IP 或主机名"}

    key_path = server.ssh_key_path
    if key_path:
        # 路径写错的表现是"认证失败",但真实原因是文件不存在 —— 提前分开报。
        from pathlib import Path

        if not Path(key_path).exists():
            return {"ok": False, "stage": "key", "message": f"私钥文件不存在:{key_path}"}

    try:
        conn = await asyncssh.connect(
            host=target,
            port=server.ssh_port or 22,
            username=server.ssh_user or "root",
            known_hosts=None,
            connect_timeout=10,
            client_keys=[key_path] if key_path else None,
            preferred_auth=["publickey"],
        )
    except asyncssh.PermissionDenied:
        return {
            "ok": False,
            "stage": "auth",
            "message": (
                f"认证失败:用户 {server.ssh_user or 'root'} 无法登录。"
                "请确认目标机已把对应公钥加入该用户的 authorized_keys。"
            ),
        }
    except (OSError, asyncssh.Error) as exc:
        return {"ok": False, "stage": "connect", "message": f"无法连接 {target}:{server.ssh_port} — {exc}"}

    try:
        result = await conn.run("true", check=False)
        if result.exit_status != 0:
            return {"ok": False, "stage": "exec", "message": f"命令执行失败(退出码 {result.exit_status})"}
        # docker 权限单独探一次:能登录不等于能读容器,这两个失败长得完全不一样
        docker = await conn.run("docker ps -q >/dev/null 2>&1 && echo YES || echo NO", check=False)
        has_docker = "YES" in (docker.stdout or "")
    finally:
        conn.close()

    return {
        "ok": True,
        "stage": "done",
        "message": "连接成功" if has_docker else "SSH 连接成功,但该用户无法执行 docker 命令(不在 docker 组或缺少权限)",
        "docker": has_docker,
    }
