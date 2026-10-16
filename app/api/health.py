"""健康检查与概览统计。"""

from fastapi import APIRouter, Depends
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.auth import require
from app.db import get_db
from app.models import Project, Server, User

router = APIRouter(tags=["system"])


@router.get("/health", summary="健康检查")
def health() -> dict[str, str]:
    """返回服务存活状态,供探针和前端启动检查使用。此端点不鉴权,不暴露任何业务数据。"""
    return {"status": "ok"}


@router.get("/overview", summary="总览统计")
def overview(db: Session = Depends(get_db), _: User = Depends(require("view"))) -> dict[str, int]:
    """返回资产总量统计,供看板顶部展示。"""
    server_total = db.scalar(select(func.count()).select_from(Server)) or 0
    project_total = db.scalar(select(func.count()).select_from(Project)) or 0
    online_total = db.scalar(select(func.count()).select_from(Server).where(Server.status == "online")) or 0

    return {
        "servers_total": server_total,
        "servers_online": online_total,
        "servers_offline": server_total - online_total,
        "projects_total": project_total,
    }
