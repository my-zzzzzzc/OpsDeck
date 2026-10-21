"""供 Dify 调用的工具接口。

Dify 的「自定义工具」通过 OpenAPI schema 发现能力。这里提供一组只读端点,
让 AI 能查询 OpsDeck 的真实数据(服务器状态、容器、事件、项目信息),
从而回答"现在内存多少""worker 为什么重启"这类问题。

鉴权:使用 `X-Tool-Token` 请求头(DIFY_TOOL_TOKEN)。它与用户 JWT 分离,
因为 Dify 是机器调用方,不应持有某个用户的长期凭据。
"""

import uuid
from datetime import UTC, datetime, timedelta

from fastapi import APIRouter, Depends, Header, HTTPException, Query, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.config import settings
from app.db import get_db
from app.models import Event, Instance, Metric, Project, Server

router = APIRouter(prefix="/dify-tools", tags=["dify-tools"])


def verify_tool_token(x_tool_token: str | None = Header(default=None, alias="X-Tool-Token")) -> None:
    """校验 Dify 工具令牌。未配置或未开启工具时直接拒绝。"""
    if not settings.dify_tools_enabled:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="工具接口未开启")

    if not settings.dify_tool_token:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="未配置 DIFY_TOOL_TOKEN,工具接口不可用",
        )

    # 常量时间比较,避免时序侧信道
    import hmac

    if not x_tool_token or not hmac.compare_digest(x_tool_token, settings.dify_tool_token):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="工具令牌无效")


# 所有工具端点共享的鉴权依赖
ToolAuth = Depends(verify_tool_token)


@router.get(
    "/servers",
    summary="查询所有服务器状态",
    description="返回每台服务器的在线状态、CPU、内存、Swap、磁盘占用。用于回答资源使用情况。",
)
def tool_list_servers(db: Session = Depends(get_db), _: None = ToolAuth) -> list[dict]:
    """返回服务器及其最新指标。"""
    servers = list(db.scalars(select(Server).order_by(Server.name)))

    # 每台服务器取最新一条指标
    latest: dict[uuid.UUID, Metric] = {}
    for metric in db.scalars(select(Metric).order_by(Metric.captured_at.desc())):
        latest.setdefault(metric.server_id, metric)

    result = []
    for s in servers:
        m = latest.get(s.id)
        item: dict = {
            "name": s.name,
            "status": s.status,
            "ip": s.ip,
            "hostname": s.hostname,
            "os": s.os_info,
            "cpu_cores": s.cpu_cores,
            "mem_total_mb": s.mem_total_mb,
            "last_seen_at": s.last_seen_at.isoformat() if s.last_seen_at else None,
        }
        if m:
            item.update(
                {
                    "cpu_percent": round(m.cpu_percent, 1) if m.cpu_percent is not None else None,
                    "mem_used_mb": m.mem_used_mb,
                    "mem_percent": (
                        round(m.mem_used_mb / m.mem_total_mb * 100, 1) if m.mem_used_mb and m.mem_total_mb else None
                    ),
                    "swap_used_mb": m.swap_used_mb,
                    "swap_total_mb": m.swap_total_mb,
                    "swap_percent": (
                        round(m.swap_used_mb / m.swap_total_mb * 100, 1) if m.swap_used_mb and m.swap_total_mb else None
                    ),
                    "disk_used_gb": m.disk_used_gb,
                    "disk_total_gb": m.disk_total_gb,
                    "load_1": m.load_1,
                    "measured_at": m.captured_at.isoformat(),
                }
            )
        result.append(item)
    return result


@router.get(
    "/containers",
    summary="查询容器状态",
    description="返回容器列表,可按服务器名或状态筛选。用于回答'哪些容器挂了''某服务在运行吗'。",
)
def tool_list_containers(
    db: Session = Depends(get_db),
    _: None = ToolAuth,
    server_name: str | None = Query(default=None, description="按服务器名筛选"),
    state: str | None = Query(default=None, description="按状态筛选: running / exited"),
    project: str | None = Query(default=None, description="按项目名筛选"),
) -> list[dict]:
    """返回容器实例及其内存占用。"""
    stmt = (
        select(Instance, Project, Server)
        .join(Project, Instance.project_id == Project.id)
        .join(Server, Project.server_id == Server.id)
        .where(Project.lifecycle == "managed")
    )

    if state:
        stmt = stmt.where(Instance.state == state)
    if project:
        stmt = stmt.where(Project.name == project)
    if server_name:
        stmt = stmt.where(Server.name == server_name)

    rows = db.execute(stmt.order_by(Instance.name)).all()

    return [
        {
            "name": inst.name,
            "project": proj.name,
            "server": srv.name,
            "state": inst.state,
            "health": inst.health,
            "image": inst.image,
            "mem_used_mb": inst.mem_used_mb,
            "mem_limit_mb": inst.mem_limit_mb,
            "mem_percent": (
                round(inst.mem_used_mb / inst.mem_limit_mb * 100, 1) if inst.mem_used_mb and inst.mem_limit_mb else None
            ),
        }
        for inst, proj, srv in rows
    ]


@router.get(
    "/events",
    summary="查询最近的事件与告警",
    description="返回最近的告警事件(离线、容器退出、资源超限)。用于回答'最近有什么异常'。",
)
def tool_list_events(
    db: Session = Depends(get_db),
    _: None = ToolAuth,
    hours: int = Query(default=24, ge=1, le=720, description="回溯小时数"),
    level: str | None = Query(default=None, description="按级别筛选: info / warning / critical"),
    unacknowledged_only: bool = Query(default=False, description="只看未处理的"),
) -> list[dict]:
    """返回事件列表。"""
    since = datetime.now(UTC) - timedelta(hours=hours)
    stmt = select(Event).where(Event.created_at >= since).order_by(Event.created_at.desc()).limit(100)

    if level:
        stmt = stmt.where(Event.level == level)
    if unacknowledged_only:
        stmt = stmt.where(Event.acknowledged.is_(False))

    servers = {s.id: s.name for s in db.scalars(select(Server))}

    return [
        {
            "level": e.level,
            "kind": e.kind,
            "title": e.title,
            "detail": e.detail,
            "server": servers.get(e.server_id) if e.server_id else None,
            "acknowledged": e.acknowledged,
            "created_at": e.created_at.isoformat(),
        }
        for e in db.scalars(stmt)
    ]


@router.get(
    "/project",
    summary="查询项目详情",
    description="返回项目的部署路径、端口、URL、重启命令、依赖与备注。用于回答'某服务怎么重启''它部署在哪'。",
)
def tool_get_project(
    db: Session = Depends(get_db),
    _: None = ToolAuth,
    name: str = Query(description="项目名"),
) -> dict:
    """返回单个项目的完整信息。只暴露已接管项目。"""
    project = db.scalar(select(Project).where(Project.name == name, Project.lifecycle == "managed"))
    if project is None:
        available = [
            p.name for p in db.scalars(select(Project).where(Project.lifecycle == "managed"))
        ]
        return {"error": f"未找到项目 {name}", "available_projects": available}

    server = db.get(Server, project.server_id)

    return {
        "name": project.name,
        "server": server.name if server else None,
        "kind": project.kind,
        "work_dir": project.work_dir,
        "compose_file": project.compose_file,
        "ports": project.ports,
        "url": project.url,
        "restart_cmd": project.restart_cmd,
        "upgrade_cmd": project.upgrade_cmd,
        "depends_on": project.depends_on,
        "tags": project.tags,
        "note": project.note,
    }


@router.get(
    "/projects",
    summary="查询所有项目",
    description="返回全部已登记项目的概要列表。",
)
def tool_list_projects(db: Session = Depends(get_db), _: None = ToolAuth) -> list[dict]:
    """返回已接管项目的概要。"""
    servers = {s.id: s.name for s in db.scalars(select(Server))}
    return [
        {
            "name": p.name,
            "server": servers.get(p.server_id),
            "kind": p.kind,
            "work_dir": p.work_dir,
            "url": p.url,
            "tags": p.tags,
        }
        for p in db.scalars(select(Project).where(Project.lifecycle == "managed").order_by(Project.name))
    ]


@router.get(
    "/summary",
    summary="系统整体概览",
    description="返回服务器、容器、告警的汇总统计。适合作为回答'现在整体情况如何'的入口。",
)
def tool_summary(db: Session = Depends(get_db), _: None = ToolAuth) -> dict:
    """返回整体健康度摘要。容器只统计已接管项目。"""
    servers = list(db.scalars(select(Server)))
    instances = list(
        db.scalars(
            select(Instance)
            .join(Project, Project.id == Instance.project_id)
            .where(Project.lifecycle == "managed")
        )
    )

    since = datetime.now(UTC) - timedelta(hours=24)
    recent_events = list(
        db.scalars(
            select(Event)
            .where(Event.created_at >= since, Event.acknowledged.is_(False))
            .order_by(Event.created_at.desc())
        )
    )

    return {
        "servers": {
            "total": len(servers),
            "online": sum(1 for s in servers if s.status == "online"),
            "offline": [s.name for s in servers if s.status == "offline"],
        },
        "containers": {
            "total": len(instances),
            "running": sum(1 for i in instances if i.state == "running"),
            "stopped": [i.name for i in instances if i.state != "running"],
        },
        "unresolved_events_24h": [{"level": e.level, "title": e.title, "detail": e.detail} for e in recent_events[:10]],
        "generated_at": datetime.now(UTC).isoformat(),
    }


@router.get("/openapi", summary="工具接口的 OpenAPI schema")
def tool_openapi() -> dict:
    """返回精简的 OpenAPI 描述,便于在 Dify 的「自定义工具」中直接导入。"""
    from app.main import app

    spec = app.openapi()
    # 只保留工具相关路径,避免把内部管理接口暴露给 Dify
    tool_paths = {k: v for k, v in spec["paths"].items() if k.startswith("/api/dify-tools")}
    return {
        "openapi": spec["openapi"],
        "info": {
            "title": "OpsDeck Tools",
            "version": spec["info"]["version"],
            "description": "让 Dify 应用查询 OpsDeck 的服务器、容器、事件与项目数据。",
        },
        "servers": [{"url": spec.get("servers", [{}])[0].get("url", "") if spec.get("servers") else ""}],
        "paths": tool_paths,
        "components": spec.get("components", {}),
    }
