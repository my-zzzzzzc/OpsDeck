"""项目更新接口。

权限划分:
  - 查看更新状态:view
  - 自动识别 / 检查 / 执行更新:operate
  - 保存更新来源配置:manage(会改变后续自动升级的目标)
"""

import logging
import threading
import uuid
from datetime import UTC, datetime

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.audit import record_audit
from app.auth import client_ip, require
from app.db import get_db
from app.executor import execute
from app.models import ActionLog, Instance, Project, ProjectUpdateConfig, Server, User
from app.schemas.actions import ActionLogRead
from app.schemas.updates import (
    UpdateApplyPayload,
    UpdateApplyResult,
    UpdateConfigPayload,
    UpdateConfigRead,
    UpdateProjectRead,
    UpdateSuggestion,
)
from app.updates import (
    UPDATE_TIMEOUT,
    UpdateError,
    build_update_command,
    check_update,
    detect_update_source,
    normalize_github_repo,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/updates", tags=["updates"])

# 同一项目的更新不允许并发:两个请求同时 build 会互相覆盖镜像与容器。
_apply_locks: dict[uuid.UUID, threading.Lock] = {}
_apply_locks_guard = threading.Lock()


def _lock_for(project_id: uuid.UUID) -> threading.Lock:
    with _apply_locks_guard:
        return _apply_locks.setdefault(project_id, threading.Lock())


def _get_project_or_404(db: Session, project_id: uuid.UUID) -> Project:
    project = db.get(Project, project_id)
    if project is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="项目不存在")
    return project


def _get_server(db: Session, project: Project) -> Server:
    server = db.get(Server, project.server_id)
    if server is None:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="项目所属服务器不存在")
    return server


def _get_config(db: Session, project_id: uuid.UUID) -> ProjectUpdateConfig | None:
    return db.scalar(select(ProjectUpdateConfig).where(ProjectUpdateConfig.project_id == project_id))


def _images_for(db: Session, project_id: uuid.UUID) -> list[str]:
    """项目已采集的镜像(去重、保持采集顺序)。"""
    rows = db.scalars(select(Instance).where(Instance.project_id == project_id).order_by(Instance.name))
    images: list[str] = []
    for row in rows:
        if row.image and row.image not in images:
            images.append(row.image)
    return images


@router.get("", response_model=list[UpdateProjectRead], summary="项目的更新状态")
def list_updates(db: Session = Depends(get_db), _: User = Depends(require("view"))) -> list[UpdateProjectRead]:
    """返回全部项目及各自的更新配置。未配置的项目 config 为 null。"""
    projects = list(db.scalars(select(Project).order_by(Project.name)))
    servers = {server.id: server for server in db.scalars(select(Server))}
    configs = {config.project_id: config for config in db.scalars(select(ProjectUpdateConfig))}

    images_by_project: dict[uuid.UUID, list[str]] = {}
    for row in db.scalars(select(Instance).order_by(Instance.name)):
        if not row.image:
            continue
        bucket = images_by_project.setdefault(row.project_id, [])
        if row.image not in bucket:
            bucket.append(row.image)

    return [
        UpdateProjectRead(
            project_id=project.id,
            project_name=project.name,
            server_id=project.server_id,
            server_name=servers[project.server_id].name if project.server_id in servers else None,
            kind=project.kind,
            work_dir=project.work_dir,
            images=images_by_project.get(project.id, []),
            config=UpdateConfigRead.model_validate(configs[project.id]) if project.id in configs else None,
        )
        for project in projects
    ]


@router.get("/history", response_model=list[ActionLogRead], summary="更新执行历史")
def update_history(
    db: Session = Depends(get_db),
    _: User = Depends(require("view")),
    limit: int = Query(default=30, ge=1, le=200),
) -> list[ActionLog]:
    stmt = (
        select(ActionLog)
        .where(ActionLog.action == "update")
        .order_by(ActionLog.created_at.desc())
        .limit(limit)
    )
    return list(db.scalars(stmt))


@router.put("/{project_id}", response_model=UpdateConfigRead, summary="保存更新来源")
def save_config(
    project_id: uuid.UUID,
    payload: UpdateConfigPayload,
    request: Request,
    db: Session = Depends(get_db),
    actor: User = Depends(require("manage")),
) -> ProjectUpdateConfig:
    """保存并确认一个项目的更新来源。保存后需要手动检查一次。"""
    project = _get_project_or_404(db, project_id)

    if payload.source_type == "git" and not project.work_dir:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Git 来源要求项目配置工作目录")
    if payload.source_type == "registry" and not payload.image_ref:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Registry 来源要求填写镜像引用")

    upstream = payload.upstream_repo
    if payload.source_type == "release":
        try:
            upstream = normalize_github_repo(payload.upstream_repo)
        except UpdateError as exc:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from None

    config = _get_config(db, project.id)
    created = config is None
    if config is None:
        config = ProjectUpdateConfig(project_id=project.id)
        db.add(config)

    config.source_type = payload.source_type
    config.confirmed = True
    config.auto_detected = False
    config.current_version = (payload.current_version or "").strip() or None
    config.repo_url = None
    config.branch = None
    config.image_ref = None
    config.upstream_repo = None

    if payload.source_type == "git":
        config.repo_url = (payload.repo_url or "").strip() or None
        config.branch = (payload.branch or "").strip() or None
    elif payload.source_type == "registry":
        config.image_ref = (payload.image_ref or "").strip()
    elif payload.source_type == "release":
        config.upstream_repo = upstream
        config.repo_url = f"https://github.com/{upstream}"

    config.latest_version = None
    config.release_url = None
    config.extra = None
    config.last_checked_at = None
    config.last_success_at = None
    config.status = "manual" if payload.source_type == "manual" else "unknown"
    config.detail = "手动更新来源,不自动检查" if payload.source_type == "manual" else None

    record_audit(
        db,
        user_id=actor.id,
        username=actor.username,
        action="create" if created else "update",
        target_type="project",
        target_id=str(project.id),
        target_name=project.name,
        ip=client_ip(request),
        detail=f"更新来源: {payload.source_type}",
    )
    db.commit()
    db.refresh(config)
    return config


@router.post("/{project_id}/detect", response_model=UpdateSuggestion, summary="自动识别更新来源")
def detect_source(
    project_id: uuid.UUID,
    db: Session = Depends(get_db),
    _: User = Depends(require("operate")),
) -> UpdateSuggestion:
    """只读探测:Git 远端 / 镜像上游 / Registry。结果不落库,需人工确认。"""
    project = _get_project_or_404(db, project_id)
    server = _get_server(db, project)
    suggestion = detect_update_source(project, server, _images_for(db, project.id))
    return UpdateSuggestion(**suggestion)


@router.post("/{project_id}/check", response_model=UpdateConfigRead, summary="检查一个项目的更新")
def check_project(
    project_id: uuid.UUID,
    db: Session = Depends(get_db),
    _: User = Depends(require("operate")),
) -> ProjectUpdateConfig:
    """执行一次只读检测,并把结果写回配置。检测失败也返回 200 + check_failed。"""
    project = _get_project_or_404(db, project_id)
    config = _get_config(db, project.id)
    if config is None:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="请先配置更新来源")
    if not config.confirmed:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="更新来源尚未确认")

    server = _get_server(db, project)
    result = check_update(config, project, server, _images_for(db, project.id))
    now = datetime.now(UTC)

    config.status = result.status
    if result.current_version is not None:
        config.current_version = result.current_version
    config.latest_version = result.latest_version
    config.detail = result.detail
    config.release_url = result.release_url
    config.extra = result.extra
    config.last_checked_at = now
    if result.status != "check_failed":
        config.last_success_at = now

    db.commit()
    db.refresh(config)
    return config


@router.post("/{project_id}/apply", response_model=UpdateApplyResult, summary="执行受控更新")
def apply_update(
    project_id: uuid.UUID,
    payload: UpdateApplyPayload,
    request: Request,
    db: Session = Depends(get_db),
    actor: User = Depends(require("operate")),
) -> UpdateApplyResult:
    """按来源执行升级命令。

    仅 git / registry 可自动执行;release 与 manual 一律拒绝,
    因为版本升级可能伴随数据库迁移,必须由人按发布说明操作。
    """
    if not payload.confirm:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="执行更新需要显式确认")

    project = _get_project_or_404(db, project_id)
    config = _get_config(db, project.id)
    if config is None or not config.confirmed:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="请先配置并确认更新来源")
    if config.status != "update_available":
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="当前没有检测到可执行的更新,请先检查更新",
        )

    try:
        command = build_update_command(config, project)
    except UpdateError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from None

    lock = _lock_for(project.id)
    if not lock.acquire(blocking=False):
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="该项目正在执行更新,请稍后再试")

    try:
        server = _get_server(db, project)

        log = ActionLog(
            project_id=project.id,
            project_name=project.name,
            action="update",
            command=command,
            status="running",
            triggered_by="manual",
            user_id=actor.id,
            username=actor.username,
        )
        db.add(log)
        db.commit()
        db.refresh(log)

        # 执行期间不持有数据库事务;构建可能持续数分钟。
        result = execute(server, command, timeout=UPDATE_TIMEOUT)

        log.status = "success" if result.ok else "failed"
        log.output = result.output
        log.exit_code = result.exit_code
        log.finished_at = datetime.now(UTC)

        record_audit(
            db,
            user_id=actor.id,
            username=actor.username,
            action="execute",
            target_type="project",
            target_id=str(project.id),
            target_name=project.name,
            ip=client_ip(request),
            success=result.ok,
            detail=f"更新({config.source_type}): {command}",
        )
        db.commit()

        if not result.ok:
            return UpdateApplyResult(
                ok=False,
                message="更新命令执行失败,请查看输出",
                output=result.output,
                command=command,
            )

        # 成功后再检测一次,把版本从"旧"推进到"新"。
        images = _images_for(db, project.id)
        checked = check_update(config, project, server, images)
        now = datetime.now(UTC)
        config.status = checked.status
        if checked.current_version is not None:
            config.current_version = checked.current_version
        config.latest_version = checked.latest_version
        config.detail = checked.detail
        config.release_url = checked.release_url
        config.extra = checked.extra
        config.last_checked_at = now
        config.last_success_at = now
        db.commit()
        db.refresh(config)

        message = "更新完成"
        if checked.status == "check_failed":
            message = f"更新命令已执行,但复核失败:{checked.detail}"
        elif checked.status == "update_available":
            message = "更新命令已执行,但仍检测到可更新内容,请检查分支或镜像引用"

        logger.info("项目 %s 更新完成,操作人 %s", project.name, actor.username)
        return UpdateApplyResult(
            ok=True,
            message=message,
            output=result.output,
            command=command,
            config=UpdateConfigRead.model_validate(config),
        )
    finally:
        lock.release()
