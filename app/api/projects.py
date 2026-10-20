"""项目管理接口。"""

import uuid

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.audit import record_audit
from app.auth import client_ip, require
from app.db import get_db
from app.models import ActionLog, Project, ProjectUpdateConfig, Server, User
from app.schemas.assets import ProjectCreate, ProjectRead, ProjectUpdate

router = APIRouter(prefix="/projects", tags=["projects"])


def _get_project_or_404(db: Session, project_id: uuid.UUID) -> Project:
    """按 ID 取项目,不存在则抛 404。"""
    project = db.get(Project, project_id)
    if project is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="项目不存在")
    return project


def _with_card_meta(db: Session, projects: list[Project]) -> list[ProjectRead]:
    """给项目补上卡片需要的服务器名、最近部署与更新摘要。

    最近部署只认 project_id 关联:按项目名反查会在多服务器同名时张冠李戴。
    """
    if not projects:
        return []

    project_ids = [project.id for project in projects]
    server_names = dict(
        db.execute(select(Server.id, Server.name).where(Server.id.in_({p.server_id for p in projects}))).all()
    )

    latest_deploys: dict[uuid.UUID, ActionLog] = {}
    deploy_logs = db.scalars(
        select(ActionLog)
        .where(ActionLog.project_id.in_(project_ids), ActionLog.action == "deploy")
        .order_by(ActionLog.created_at.desc(), ActionLog.id.desc())
    )
    for log in deploy_logs:
        if log.project_id is not None:
            latest_deploys.setdefault(log.project_id, log)

    configs = {
        config.project_id: config
        for config in db.scalars(
            select(ProjectUpdateConfig).where(ProjectUpdateConfig.project_id.in_(project_ids))
        )
    }

    reads: list[ProjectRead] = []
    for project in projects:
        log = latest_deploys.get(project.id)
        config = configs.get(project.id)
        reads.append(
            ProjectRead.model_validate(project).model_copy(
                update={
                    "server_name": server_names.get(project.server_id),
                    "last_deploy_at": log.created_at if log else None,
                    "last_deploy_status": log.status if log else None,
                    "last_deploy_username": log.username if log else None,
                    "update_source": config.source_type if config else None,
                    "update_status": config.status if config else None,
                    "update_branch": config.branch if config else None,
                }
            )
        )
    return reads


@router.get("", response_model=list[ProjectRead], summary="项目列表")
def list_projects(
    db: Session = Depends(get_db),
    _: User = Depends(require("view")),
    server_id: uuid.UUID | None = Query(default=None, description="按服务器筛选"),
    tag: str | None = Query(default=None, description="按标签筛选"),
) -> list[ProjectRead]:
    """返回项目列表,可按服务器或标签筛选。附带卡片摘要。"""
    stmt = select(Project).order_by(Project.name)
    if server_id is not None:
        stmt = stmt.where(Project.server_id == server_id)
    if tag is not None:
        stmt = stmt.where(Project.tags.contains([tag]))

    return _with_card_meta(db, list(db.scalars(stmt)))


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
