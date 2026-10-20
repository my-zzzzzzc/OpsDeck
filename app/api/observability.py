"""采集器上报接口与观测数据查询。"""

import uuid
from collections.abc import Iterable
from datetime import UTC, datetime, timedelta

from fastapi import APIRouter, Depends, Header, HTTPException, Query, status
from sqlalchemy import func, select, update
from sqlalchemy.orm import Session

from app.auth import require
from app.db import get_db
from app.detection import run_detection
from app.models import Event, Instance, Metric, Project, Server, User
from app.schemas.observability import (
    EventRead,
    IngestResult,
    InstanceDetailRead,
    InstanceRead,
    MetricRead,
    ReportPayload,
)

router = APIRouter(tags=["observability"])


# ---------------------------------------------------------------- 上报


@router.post(
    "/ingest/report",
    response_model=IngestResult,
    summary="接收采集器上报",
    description="采集器使用 `X-Agent-Token` 鉴权。同一容器的状态按 (project_id, name) 幂等更新。",
)
def ingest_report(
    payload: ReportPayload,
    db: Session = Depends(get_db),
    x_agent_token: str | None = Header(default=None, alias="X-Agent-Token"),
) -> IngestResult:
    """接收一次采集快照:更新服务器状态、写入指标、同步实例。"""
    if not x_agent_token:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="缺少 X-Agent-Token")

    server = db.scalar(select(Server).where(Server.agent_token == x_agent_token))
    if server is None:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="采集凭证无效")

    now = datetime.now(UTC)

    # 1. 回填服务器静态信息并标记在线
    server.status = "online"
    server.last_seen_at = now
    if payload.host.hostname:
        server.hostname = payload.host.hostname
    if payload.host.os_info:
        server.os_info = payload.host.os_info
    if payload.host.cpu_cores:
        server.cpu_cores = payload.host.cpu_cores
    if payload.host.mem_total_mb:
        server.mem_total_mb = payload.host.mem_total_mb

    # 2. 写入指标快照
    db.add(
        Metric(
            server_id=server.id,
            captured_at=payload.captured_at or now,
            cpu_percent=payload.metrics.cpu_percent,
            mem_used_mb=payload.metrics.mem_used_mb,
            mem_total_mb=payload.metrics.mem_total_mb,
            swap_used_mb=payload.metrics.swap_used_mb,
            swap_total_mb=payload.metrics.swap_total_mb,
            disk_used_gb=payload.metrics.disk_used_gb,
            disk_total_gb=payload.metrics.disk_total_gb,
            load_1=payload.metrics.load_1,
            load_5=payload.metrics.load_5,
            load_15=payload.metrics.load_15,
        )
    )

    # 3. 同步实例:按 compose 项目名匹配已登记项目,幂等 upsert
    projects = {p.name: p for p in db.scalars(select(Project).where(Project.server_id == server.id))}

    synced = 0
    for item in payload.instances:
        project = projects.get(item.project)
        if project is None:
            # 未登记的项目:跳过,由人工在资产里补录后再纳入监控
            continue

        existing = db.scalar(select(Instance).where(Instance.project_id == project.id, Instance.name == item.name))
        if existing is None:
            existing = Instance(project_id=project.id, name=item.name)
            db.add(existing)

        existing.image = item.image or existing.image
        existing.state = item.state or existing.state
        existing.health = item.health or existing.health
        # 内存直接覆盖,不能用 `or` 兜底:采集器对"未设上限"和"没采集到"都给 0,
        # 用 `or` 会把 0 当成缺失,于是容器停掉之后还一直挂着上一次运行时的占用。
        existing.mem_used_mb = item.mem_used_mb or None
        existing.mem_limit_mb = item.mem_limit_mb or None
        synced += 1

    # 4. 记录离线容器为事件(仅 exited,且避免重复刷屏)
    #
    # 一次性任务容器(init_permissions / migrate / 建表脚本这类)跑完退出
    # 是它的正常生命周期,不是故障 —— 给它们发告警只会训练用户忽略告警。
    #
    # 判断依据只能是名字:采集器目前不给 exit_code 赋值(永远是 Go 的零值 0),
    # 所以"退出码为 0 就算正常"这种写法会把**所有**退出一律过滤掉,包括真故障。
    # 名字启发式会漏掉个别非常规命名,但它的错误方向是"少报一次正常退出",
    # 而不是"漏掉一次真实宕机"。
    def _is_one_shot(name: str) -> bool:
        lowered = name.lower()
        return any(marker in lowered for marker in ("init", "migrat", "setup", "provision"))

    exited = [
        i for i in payload.instances if i.state == "exited" and i.project in projects and not _is_one_shot(i.name)
    ]
    for item in exited:
        project = projects[item.project]
        title = f"容器已退出: {item.name}"
        # 去重必须精确到**这一个容器**:只按 project_id 判重的话,
        # 同一项目下只要有一条 exit 事件,其余容器都会被当成"已告警"而漏报,
        # 反过来又会在 30 分钟窗口过后为每个容器各补一条 —— 两个方向都是错的。
        recent = db.scalar(
            select(Event).where(
                Event.project_id == project.id,
                Event.kind == "exit",
                Event.title == title,
                Event.created_at > now - timedelta(minutes=30),
            )
        )
        if recent is None:
            db.add(
                Event(
                    server_id=server.id,
                    project_id=project.id,
                    level="warning",
                    kind="exit",
                    title=title,
                    detail=f"项目 {project.name} 的容器 {item.name} 处于 exited 状态。",
                )
            )

    db.commit()

    return IngestResult(
        server_id=server.id,
        server_name=server.name,
        instances_synced=synced,
        instances_ignored=len(payload.instances) - synced,
    )


# ---------------------------------------------------------------- 查询


@router.get("/metrics/latest", response_model=list[MetricRead], summary="最新指标")
def latest_metrics(
    db: Session = Depends(get_db),
    _: User = Depends(require("view")),
    server_id: uuid.UUID | None = Query(default=None),
) -> list[Metric]:
    """返回每台服务器最近一条指标快照。"""
    # 每台服务器按时间倒序取第一条,避免全表扫描后在 Python 侧过滤
    newest = (
        select(
            Metric.server_id,
            func.max(Metric.captured_at).label("captured_at"),
        )
        .group_by(Metric.server_id)
        .subquery()
    )

    stmt = (
        select(Metric)
        .join(
            newest,
            (Metric.server_id == newest.c.server_id) & (Metric.captured_at == newest.c.captured_at),
        )
        .order_by(Metric.captured_at.desc())
    )
    if server_id is not None:
        stmt = stmt.where(Metric.server_id == server_id)

    return list(db.scalars(stmt))


@router.get("/metrics", response_model=list[MetricRead], summary="指标历史")
def metric_history(
    db: Session = Depends(get_db),
    _: User = Depends(require("view")),
    server_id: uuid.UUID = Query(description="服务器 ID"),
    hours: int = Query(default=24, ge=1, le=720, description="回溯小时数"),
    points: int | None = Query(
        default=None,
        ge=2,
        le=500,
        description="按时间等分降采样到指定点数;留空返回原始样本",
    ),
) -> list[Metric]:
    """返回指定服务器的指标历史,按时间升序。

    看板上的趋势条只需要几十个点。24 小时约 2900 条原始样本(约 900KB),
    而 60 个桶(约 8KB)画出来肉眼分不出区别 —— 所以提供 `points` 做服务端降采样,
    避免把几百 KB 的 JSON 塞给浏览器。留空则保持原行为,兼容既有调用方。
    """
    until = datetime.now(UTC)
    since = until - timedelta(hours=hours)
    rows = list(
        db.scalars(
            select(Metric)
            .where(Metric.server_id == server_id, Metric.captured_at >= since)
            .order_by(Metric.captured_at)
        )
    )
    if points is None or len(rows) <= points:
        return rows
    return _downsample(rows, points, since, until)


def _mean(values: Iterable[float | int | None]) -> float | None:
    """忽略空值的均值。全为空时返回 None,而不是 0 —— 缺数据与真值是 0 不是一回事。"""
    kept = [float(v) for v in values if v is not None]
    if not kept:
        return None
    return sum(kept) / len(kept)


def _mean_int(values: Iterable[float | int | None]) -> int | None:
    """忽略空值的均值,四舍五入到整数(MB / GB 这类量纲不需要小数)。"""
    avg = _mean(values)
    return None if avg is None else round(avg)


def _latest(values: Iterable[float | int | None]) -> float | int | None:
    """取最后一个非空值。

    "总量"字段(内存总量、磁盘总量)不参与平均 —— 取均值没有物理意义,
    而且一旦机器改配,均值会落在两个真实值之间,反而制造出一个不存在的容量。
    """
    last: float | int | None = None
    for v in values:
        if v is not None:
            last = v
    return last


def _downsample(
    rows: list[Metric],
    points: int,
    since: datetime,
    until: datetime,
) -> list[dict[str, object]]:
    """把时间窗等分成 `points` 个桶,每桶聚合成一条。

    按**时间**分桶而不是按序号:采集器会断线(现网数据里就有 3 小时的整段空缺),
    按序号分桶会把空缺摊平到每个桶里,趋势条看起来依然饱满均匀 ——
    等于把"采集器失联"这个最该被看见的信号抹掉了。

    空桶返回一条全 None 的记录,由前端画成缺口,而不是补 0:
    0% 和"没采集到"在运维上是两件完全不同的事。
    """
    span = max((until - since).total_seconds(), 1.0)
    step = span / points
    buckets: list[list[Metric]] = [[] for _ in range(points)]

    for row in rows:
        captured = row.captured_at
        if captured.tzinfo is None:
            # SQLite 不保存时区,读回来是 naive 的;库里的值一律按 UTC 解释
            captured = captured.replace(tzinfo=UTC)
        idx = int((captured - since).total_seconds() / step)
        buckets[min(points - 1, max(0, idx))].append(row)

    server_id = rows[0].server_id
    out: list[dict[str, object]] = []
    for i, chunk in enumerate(buckets):
        # 桶的右边界作为代表时间,与升序返回的语义一致
        at = since + timedelta(seconds=step * (i + 1))
        if not chunk:
            out.append(
                {
                    "id": -(i + 1),  # 空桶没有真实主键,用负数占位且保证唯一
                    "server_id": server_id,
                    "captured_at": at,
                    "cpu_percent": None,
                    "mem_used_mb": None,
                    "mem_total_mb": None,
                    "swap_used_mb": None,
                    "swap_total_mb": None,
                    "disk_used_gb": None,
                    "disk_total_gb": None,
                    "load_1": None,
                    "load_5": None,
                    "load_15": None,
                }
            )
            continue

        out.append(
            {
                # 代表 id 取桶内首条:稳定且不与其它桶重复
                "id": chunk[0].id,
                "server_id": server_id,
                "captured_at": chunk[-1].captured_at,
                # 比率取均值,总量取末值
                "cpu_percent": _mean(c.cpu_percent for c in chunk),
                "mem_used_mb": _mean_int(c.mem_used_mb for c in chunk),
                "mem_total_mb": _latest(c.mem_total_mb for c in chunk),
                "swap_used_mb": _mean_int(c.swap_used_mb for c in chunk),
                "swap_total_mb": _latest(c.swap_total_mb for c in chunk),
                "disk_used_gb": _mean(c.disk_used_gb for c in chunk),
                "disk_total_gb": _latest(c.disk_total_gb for c in chunk),
                "load_1": _mean(c.load_1 for c in chunk),
                "load_5": _mean(c.load_5 for c in chunk),
                "load_15": _mean(c.load_15 for c in chunk),
            }
        )
    return out


@router.get("/instances", response_model=list[InstanceRead], summary="实例列表")
def list_instances(
    db: Session = Depends(get_db),
    _: User = Depends(require("view")),
    server_id: uuid.UUID | None = Query(default=None),
    state: str | None = Query(default=None, description="按状态筛选,如 running / exited"),
) -> list[Instance]:
    """返回采集到的容器实例。"""
    stmt = select(Instance).order_by(Instance.name)
    if server_id is not None:
        stmt = stmt.where(Instance.project_id.in_(select(Project.id).where(Project.server_id == server_id)))
    if state is not None:
        stmt = stmt.where(Instance.state == state)
    return list(db.scalars(stmt))


@router.get("/instances/detail", response_model=list[InstanceDetailRead], summary="实例列表(含项目与服务器)")
def list_instances_detail(
    db: Session = Depends(get_db),
    _: User = Depends(require("view")),
    server_id: uuid.UUID | None = Query(default=None),
    state: str | None = Query(default=None, description="按状态筛选,如 running / exited"),
) -> list[InstanceDetailRead]:
    """返回容器实例,并联表带上所属项目名与服务器名。

    容器看板要跨机器汇总,没有这两个名字就只能显示 UUID。
    用 join 而不是在 Session 上逐个懒加载:后者是 N+1 查询,
    容器数量一多就会把一次看板刷新变成几十次往返。
    """
    stmt = (
        select(
            Instance,
            Project.name.label("project_name"),
            Server.id.label("server_id"),
            Server.name.label("server_name"),
        )
        .join(Project, Project.id == Instance.project_id)
        .join(Server, Server.id == Project.server_id)
        .order_by(Server.name, Project.name, Instance.name)
    )
    if server_id is not None:
        stmt = stmt.where(Project.server_id == server_id)
    if state is not None:
        stmt = stmt.where(Instance.state == state)

    return [
        InstanceDetailRead(
            id=inst.id,
            project_id=inst.project_id,
            name=inst.name,
            image=inst.image,
            state=inst.state,
            health=inst.health,
            mem_used_mb=inst.mem_used_mb,
            mem_limit_mb=inst.mem_limit_mb,
            updated_at=inst.updated_at,
            project_name=project_name,
            server_id=server_id_,
            server_name=server_name,
            started_at=inst.started_at,
            exit_code=inst.exit_code,
        )
        for inst, project_name, server_id_, server_name in db.execute(stmt)
    ]


@router.get("/events", response_model=list[EventRead], summary="事件列表")
def list_events(
    db: Session = Depends(get_db),
    _: User = Depends(require("view")),
    level: str | None = Query(default=None),
    acknowledged: bool | None = Query(default=None),
    limit: int = Query(default=50, ge=1, le=500),
) -> list[Event]:
    """返回事件与告警,按时间倒序。"""
    stmt = select(Event).order_by(Event.created_at.desc()).limit(limit)
    if level is not None:
        stmt = stmt.where(Event.level == level)
    if acknowledged is not None:
        stmt = stmt.where(Event.acknowledged == acknowledged)
    return list(db.scalars(stmt))


@router.post("/events/{event_id}/ack", response_model=EventRead, summary="标记事件已读")
def acknowledge_event(event_id: int, db: Session = Depends(get_db), _: User = Depends(require("view"))) -> Event:
    """把事件标记为已处理。"""
    event = db.get(Event, event_id)
    if event is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="事件不存在")
    event.acknowledged = True
    db.commit()
    db.refresh(event)
    return event


@router.post("/events/ack-all", summary="全部标记已读")
def acknowledge_all(
    db: Session = Depends(get_db),
    _: User = Depends(require("view")),
) -> dict[str, int]:
    """把所有未读事件一次性标记为已处理。

    告警积压往往是一次性噪声退潮后的残留(几十条同类),逐条点 ack
    既是折磨也是劝退 —— 批量清掉,未读数才有机会真正归零。
    只动 acknowledged 位,不删除任何数据:审计上"看过并处理过"必须留痕。
    """
    updated = db.execute(update(Event).where(Event.acknowledged.is_(False)).values(acknowledged=True)).rowcount
    db.commit()
    return {"acked": updated}


@router.post("/detect", summary="立即执行一轮告警检测")
def detect_now(db: Session = Depends(get_db), _: User = Depends(require("view"))) -> dict[str, int]:
    """手动触发离线与阈值检测,便于即时排查,不必等待后台周期。"""
    return run_detection(db)
