"""白名单操作的执行接口。"""

import logging
import uuid
from datetime import UTC, datetime

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.actions import ActionRejected, build_command, get_catalog, validate
from app.audit import record_audit
from app.auth import client_ip, require
from app.db import get_db
from app.executor import execute
from app.models import ActionLog, Project, Server, User
from app.schemas.actions import ActionCatalogItem, ActionExecutePayload, ActionLogRead

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/actions", tags=["actions"])


@router.get("/catalog", response_model=list[ActionCatalogItem], summary="可用操作目录")
def action_catalog(_: User = Depends(require("view"))) -> list[dict]:
    """返回白名单内的操作。前端据此渲染按钮,禁用项不应展示为可点击。"""
    return get_catalog()


@router.post("/execute", response_model=ActionLogRead, summary="执行操作")
def execute_action(
    payload: ActionExecutePayload,
    request: Request,
    db: Session = Depends(get_db),
    actor: User = Depends(require("operate")),
) -> ActionLog:
    """执行一个白名单操作。

    安全校验顺序:项目存在 → 操作在白名单内且启用 → 需要确认时已确认 → 构造命令。
    任一步失败都会写入 action_logs(rejected),保证可追溯。
    """
    if payload.triggered_by not in ("manual", "dify"):
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="triggered_by 只能是 manual 或 dify",
        )

    project = db.get(Project, payload.project_id)
    if project is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="项目不存在")

    server = db.get(Server, project.server_id)

    # 先落一条记录,保证即使后续拒绝也有痕迹
    log = ActionLog(
        project_id=project.id,
        project_name=project.name,
        action=payload.action,
        status="rejected",
        triggered_by=payload.triggered_by,
        user_id=actor.id,
        username=actor.username,
    )

    try:
        spec = validate(payload.action, project, confirm=payload.confirm)
        command = build_command(spec, project)
    except ActionRejected as exc:
        log.output = str(exc)
        db.add(log)
        record_audit(
            db,
            user_id=actor.id,
            username=actor.username,
            action="execute",
            target_type="project",
            target_id=str(project.id),
            target_name=project.name,
            ip=client_ip(request),
            success=False,
            detail=f"操作被拒绝: {exc}",
        )
        db.commit()
        db.refresh(log)
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from None

    if server is None:
        log.output = "项目所属服务器不存在"
        db.add(log)
        db.commit()
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="项目所属服务器不存在")

    log.command = command
    log.status = "running"
    db.add(log)
    db.commit()
    db.refresh(log)

    # 执行期间保持事务已提交,避免长事务占用连接
    result = execute(server, command)

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
        detail=f"{spec.label}: {command}",
    )
    db.commit()
    db.refresh(log)

    logger.info(
        "操作完成: %s 在 %s 上 %s,退出码 %d",
        actor.username,
        server.name,
        spec.key,
        result.exit_code,
    )
    return log


@router.get("/logs", response_model=list[ActionLogRead], summary="操作历史")
def action_logs(
    db: Session = Depends(get_db),
    _: User = Depends(require("view")),
    project_id: uuid.UUID | None = Query(default=None),
    limit: int = Query(default=50, ge=1, le=500),
) -> list[ActionLog]:
    """返回操作执行历史,按时间倒序。"""
    stmt = select(ActionLog).order_by(ActionLog.created_at.desc()).limit(limit)
    if project_id is not None:
        stmt = stmt.where(ActionLog.project_id == project_id)
    return list(db.scalars(stmt))
