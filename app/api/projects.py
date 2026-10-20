"""项目管理接口。"""

import base64
import shlex
import uuid
from pathlib import PurePosixPath

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.audit import record_audit
from app.auth import client_ip, require
from app.db import get_db
from app.executor import execute
from app.models import Project, Server, User
from app.schemas.assets import ProjectConfigRead, ProjectConfigUpdate, ProjectCreate, ProjectRead, ProjectUpdate

router = APIRouter(prefix="/projects", tags=["projects"])


def _get_project_or_404(db: Session, project_id: uuid.UUID) -> Project:
    """按 ID 取项目,不存在则抛 404。"""
    project = db.get(Project, project_id)
    if project is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="项目不存在")
    return project


def _compose_name(project: Project) -> str:
    """只允许项目目录下的 Compose 文件，拒绝目录穿越和绝对路径。"""
    name = project.compose_file or "docker-compose.yaml"
    path = PurePosixPath(name)
    if path.is_absolute() or ".." in path.parts or len(path.parts) != 1:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Compose 文件必须位于项目工作目录中")
    return path.name


def _require_compose(project: Project) -> str:
    if project.kind != "docker-compose":
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"{project.kind} 项目没有可编辑的 Compose 配置",
        )
    if not project.work_dir:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="项目未配置工作目录")
    return _compose_name(project)


def _decode_file(output: str) -> str | None:
    """远端读取使用 base64，避免配置内容被 shell 或 JSON 转义破坏。"""
    if not output.strip() or output.startswith("__OPSDECK_MISSING__"):
        return None
    try:
        return base64.b64decode("".join(output.split()), validate=True).decode("utf-8")
    except (ValueError, UnicodeDecodeError) as exc:
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail="远端配置文件读取失败") from exc


def _read_remote_file(server: Server, work_dir: str, filename: str) -> str | None:
    directory = shlex.quote(work_dir)
    path = shlex.quote(filename)
    command = f"cd {directory} && if test -f {path}; then base64 < {path}; else printf __OPSDECK_MISSING__; fi"
    result = execute(server, command, max_output=270_000)
    if not result.ok:
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail=result.output)
    return _decode_file(result.output)


def _write_remote_file(server: Server, work_dir: str, filename: str, content: str) -> None:
    """使用同目录临时文件和 mv 原子替换，避免半写入的 Compose 被部署读取。"""
    encoded = base64.b64encode(content.encode("utf-8")).decode("ascii")
    directory = shlex.quote(work_dir)
    path = shlex.quote(filename)
    command = (
        f"set -eu; cd {directory}; tmp=$(mktemp .opsdeck-config.XXXXXX); "
        f"printf %s {shlex.quote(encoded)} | base64 -d > \"$tmp\"; chmod 600 \"$tmp\"; mv \"$tmp\" {path}"
    )
    result = execute(server, command)
    if not result.ok:
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail=result.output)


@router.get("", response_model=list[ProjectRead], summary="项目列表")
def list_projects(
    db: Session = Depends(get_db),
    _: User = Depends(require("view")),
    server_id: uuid.UUID | None = Query(default=None, description="按服务器筛选"),
    tag: str | None = Query(default=None, description="按标签筛选"),
) -> list[Project]:
    """返回项目列表,可按服务器或标签筛选。"""
    stmt = select(Project).order_by(Project.name)
    if server_id is not None:
        stmt = stmt.where(Project.server_id == server_id)
    if tag is not None:
        stmt = stmt.where(Project.tags.contains([tag]))

    return list(db.scalars(stmt))


@router.post("", response_model=ProjectRead, status_code=status.HTTP_201_CREATED, summary="新增项目")
def create_project(
    payload: ProjectCreate,
    request: Request,
    db: Session = Depends(get_db),
    actor: User = Depends(require("manage")),
) -> Project:
    """新增项目。所属服务器必须存在,同一服务器内名称不能重复。"""
    if db.get(Server, payload.server_id) is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="所属服务器不存在")

    exists = db.scalar(select(Project).where(Project.server_id == payload.server_id, Project.name == payload.name))
    if exists is not None:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=f"该服务器下项目名已存在: {payload.name}")

    project = Project(**payload.model_dump())
    db.add(project)
    db.flush()

    record_audit(
        db,
        user_id=actor.id,
        username=actor.username,
        action="create",
        target_type="project",
        target_id=str(project.id),
        target_name=project.name,
        ip=client_ip(request),
    )
    db.commit()
    db.refresh(project)
    return project


@router.get("/{project_id}", response_model=ProjectRead, summary="项目详情")
def get_project(project_id: uuid.UUID, db: Session = Depends(get_db), _: User = Depends(require("view"))) -> Project:
    """返回项目详情。"""
    return _get_project_or_404(db, project_id)


@router.patch("/{project_id}", response_model=ProjectRead, summary="更新项目")
def update_project(
    project_id: uuid.UUID,
    payload: ProjectUpdate,
    request: Request,
    db: Session = Depends(get_db),
    actor: User = Depends(require("manage")),
) -> Project:
    """局部更新项目字段。"""
    project = _get_project_or_404(db, project_id)

    changes = payload.model_dump(exclude_unset=True)
    new_name = changes.get("name")
    if new_name is not None and new_name != project.name:
        exists = db.scalar(
            select(Project).where(
                Project.server_id == project.server_id,
                Project.name == new_name,
                Project.id != project.id,
            )
        )
        if exists is not None:
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=f"该服务器下项目名已存在: {new_name}")

    for field, value in changes.items():
        setattr(project, field, value)

    record_audit(
        db,
        user_id=actor.id,
        username=actor.username,
        action="update",
        target_type="project",
        target_id=str(project.id),
        target_name=project.name,
        ip=client_ip(request),
        detail=f"更新字段: {', '.join(changes.keys())}",
    )
    db.commit()
    db.refresh(project)
    return project


@router.get("/{project_id}/config", response_model=ProjectConfigRead, summary="读取项目配置")
def read_project_config(
    project_id: uuid.UUID,
    db: Session = Depends(get_db),
    _: User = Depends(require("manage")),
) -> ProjectConfigRead:
    """读取已登记 Compose 项目的 YAML 与 .env。

    配置中可能有密钥，读取权限比普通项目查看更高；其它项目类型只返回明确的不可编辑说明。
    """
    project = _get_project_or_404(db, project_id)
    if project.kind != "docker-compose":
        return ProjectConfigRead(kind=project.kind, editable=False, message="此项目类型没有 Compose 配置文件")

    compose_name = _require_compose(project)
    server = db.get(Server, project.server_id)
    if server is None:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="项目所属服务器不存在")

    return ProjectConfigRead(
        kind=project.kind,
        compose_file=compose_name,
        compose_content=_read_remote_file(server, project.work_dir or "", compose_name),
        env_content=_read_remote_file(server, project.work_dir or "", ".env"),
        editable=True,
    )


@router.put("/{project_id}/config", response_model=ProjectConfigRead, summary="保存项目配置")
def write_project_config(
    project_id: uuid.UUID,
    payload: ProjectConfigUpdate,
    request: Request,
    db: Session = Depends(get_db),
    actor: User = Depends(require("manage")),
) -> ProjectConfigRead:
    """原子保存已登记 Compose 项目的 YAML / .env，并留下审计记录。"""
    project = _get_project_or_404(db, project_id)
    compose_name = _require_compose(project)
    if payload.compose_content is None and payload.env_content is None:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="至少提供一个需要保存的配置文件")
    if payload.compose_content is not None and not payload.compose_content.strip():
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="Compose 文件不能为空")

    server = db.get(Server, project.server_id)
    if server is None:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="项目所属服务器不存在")

    changed: list[str] = []
    if payload.compose_content is not None:
        _write_remote_file(server, project.work_dir or "", compose_name, payload.compose_content)
        changed.append(compose_name)
    if payload.env_content is not None:
        _write_remote_file(server, project.work_dir or "", ".env", payload.env_content)
        changed.append(".env")

    record_audit(
        db,
        user_id=actor.id,
        username=actor.username,
        action="update_config",
        target_type="project",
        target_id=str(project.id),
        target_name=project.name,
        ip=client_ip(request),
        detail=f"更新配置文件: {', '.join(changed)}",
    )
    db.commit()
    work_dir = project.work_dir or ""
    return ProjectConfigRead(
        kind=project.kind,
        compose_file=compose_name,
        compose_content=(
            payload.compose_content
            if payload.compose_content is not None
            else _read_remote_file(server, work_dir, compose_name)
        ),
        env_content=(
            payload.env_content
            if payload.env_content is not None
            else _read_remote_file(server, work_dir, ".env")
        ),
        editable=True,
    )


@router.delete("/{project_id}", status_code=status.HTTP_204_NO_CONTENT, summary="删除项目")
def delete_project(
    project_id: uuid.UUID,
    request: Request,
    db: Session = Depends(get_db),
    actor: User = Depends(require("manage")),
) -> None:
    """删除项目。"""
    project = _get_project_or_404(db, project_id)
    record_audit(
        db,
        user_id=actor.id,
        username=actor.username,
        action="delete",
        target_type="project",
        target_id=str(project.id),
        target_name=project.name,
        ip=client_ip(request),
    )
    db.delete(project)
    db.commit()
