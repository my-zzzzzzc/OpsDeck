"""单容器操作接口(重启 / 停止 / 启动)。

安全边界与项目级操作一致:
  - 动作由后端白名单定义,请求只能指定动作名;
  - 容器名经字符白名单校验后才进入 SSH 命令;
  - 每次执行(含拒绝)都写 action_logs 与审计日志。

与项目级操作的区别:这里只动一个容器,不影响同项目的其它服务。
镜像升级不在容器级提供 —— 那会绕过 Compose,必须走项目级流程。
"""

import logging
from datetime import UTC, datetime

from fastapi import APIRouter, Depends, HTTPException, Request, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.actions import (
    ActionRejected,
    build_container_command,
    validate_container_action,
)
from app.audit import record_audit
from app.auth import client_ip, require
from app.db import get_db
from app.executor import execute
from app.models import ActionLog, Instance, Project, Server, User
from app.schemas.actions import ActionLogRead, ContainerActionPayload

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/containers", tags=["containers"])


@router.post(
    "/{instance_id}/actions",
    response_model=ActionLogRead,
    summary="对单个容器执行操作",
)
def container_action(
    instance_id: int,
    payload: ContainerActionPayload,
    request: Request,
    db: Session = Depends(get_db),
    actor: User = Depends(require("operate")),
) -> ActionLog:
    """执行一个单容器白名单操作。未接管项目的容器按不存在处理。"""
    row = db.execute(
        select(Instance, Project, Server)
        .join(Project, Project.id == Instance.project_id)
        .join(Server, Server.id == Project.server_id)
        .where(Instance.id == instance_id, Project.lifecycle == "managed")
    ).first()
    if row is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="容器不存在")
    instance, project, server = row

    # 先落记录,保证即使被拒绝也能追溯
    log = ActionLog(
        project_id=project.id,
        project_name=project.name,
        action=payload.action,
        status="rejected",
        triggered_by="manual",
        user_id=actor.id,
        username=actor.username,
    )

    try:
        spec = validate_container_action(payload.action, confirm=payload.confirm)
        # root 登录时 Docker 通常可直接使用;其余用户沿用与日志相同的免密 sudo。
        use_sudo = (server.ssh_user or "root").strip() != "root"
        command = build_container_command(spec, instance.name, use_sudo=use_sudo)
    except ActionRejected as exc:
        log.output = str(exc)
        db.add(log)
        record_audit(
            db,
            user_id=actor.id,
            username=actor.username,
            action="execute",
            target_type="container",
            target_id=str(instance.id),
            target_name=instance.name,
            ip=client_ip(request),
            success=False,
            detail=f"容器操作被拒绝: {exc}",
        )
        db.commit()
        db.refresh(log)
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from None

    log.command = command
    log.status = "running"
    db.add(log)
    db.commit()
    db.refresh(log)

    # 执行期间事务已提交,避免 SSH 操作把数据库连接占在长事务里
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
        target_type="container",
        target_id=str(instance.id),
        target_name=instance.name,
        ip=client_ip(request),
        success=result.ok,
        detail=f"{spec.label}: {command}",
    )
    db.commit()
    db.refresh(log)

    logger.info(
        "容器操作完成: %s 在 %s 上 %s %s,退出码 %d",
        actor.username,
        server.name,
        spec.verb,
        instance.name,
        result.exit_code,
    )
    return log
