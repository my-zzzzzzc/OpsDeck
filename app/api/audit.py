"""审计日志查询。"""

import uuid

from fastapi import APIRouter, Depends, Query
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.auth import require
from app.db import get_db
from app.models import AuditLog, User
from app.schemas.auth import AuditLogRead

router = APIRouter(prefix="/audit-logs", tags=["audit"])


@router.get("", response_model=list[AuditLogRead], summary="审计日志")
def list_audit_logs(
    db: Session = Depends(get_db),
    _: User = Depends(require("users")),
    user_id: uuid.UUID | None = Query(default=None, description="按操作者筛选"),
    action: str | None = Query(default=None, description="按动作筛选,如 login / delete"),
    target_type: str | None = Query(default=None, description="按对象类型筛选"),
    limit: int = Query(default=100, ge=1, le=1000),
) -> list[AuditLog]:
    """返回审计记录,按时间倒序。仅管理员可读。"""
    stmt = select(AuditLog).order_by(AuditLog.created_at.desc()).limit(limit)
    if user_id is not None:
        stmt = stmt.where(AuditLog.user_id == user_id)
    if action is not None:
        stmt = stmt.where(AuditLog.action == action)
    if target_type is not None:
        stmt = stmt.where(AuditLog.target_type == target_type)
    return list(db.scalars(stmt))
