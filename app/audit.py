"""审计日志写入。

审计只在业务操作成功后记录,写入失败仅记日志、不影响主流程 ——
审计不应成为业务可用性的单点。
"""

import logging
import uuid
from contextlib import suppress

from sqlalchemy.orm import Session

from app.models import AuditLog

logger = logging.getLogger(__name__)


def record_audit(
    db: Session,
    *,
    action: str,
    user_id: uuid.UUID | None = None,
    username: str | None = None,
    target_type: str | None = None,
    target_id: str | None = None,
    target_name: str | None = None,
    detail: str | None = None,
    ip: str | None = None,
    success: bool = True,
    commit: bool = False,
) -> None:
    """写入一条审计记录。

    默认只 add 到会话,由调用方在业务变更的同一事务中 commit —— 这样不会出现
    "操作成功但无审计"。

    但失败路径(如登录失败)会立刻抛异常、没有后续 commit,此时必须传
    `commit=True` 立即落库,否则该记录会随事务回滚丢失。失败登录恰恰是安全审计
    最需要留痕的事件。
    """
    try:
        db.add(
            AuditLog(
                user_id=user_id,
                username=username,
                action=action,
                target_type=target_type,
                target_id=target_id,
                target_name=target_name,
                detail=detail,
                ip=ip,
                success=success,
            )
        )
        if commit:
            db.commit()
    except Exception:
        # 审计失败不应阻断业务,但必须留下痕迹
        logger.exception("写入审计记录失败: action=%s target=%s", action, target_name)
        with suppress(Exception):
            db.rollback()
