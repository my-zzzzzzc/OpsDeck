"""采集器上报接口与观测数据查询。"""

import logging
import uuid
from collections.abc import Iterable
from datetime import UTC, datetime, timedelta

from fastapi import APIRouter, Depends, Header, HTTPException, Query, status
from sqlalchemy import func, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.auth import require
from app.db import get_db
from app.detection import run_detection
from app.discovery import (
    compose_label,
    event_detail,
    normalized_work_dir,
    observed_compose_file,
    observed_work_dir,
)
from app.models import ContainerMetric, Event, Instance, Metric, Project, Server, User
from app.schemas.observability import (
    ContainerMetricRead,
    EventRead,
    IngestResult,
    InstanceDetailRead,
    InstanceRead,
    MetricRead,
    ReportPayload,
)

logger = logging.getLogger(__name__)

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

    # 3. 同步实例:先按 Compose 标签匹配,再按名称与唯一工作目录学习。
    #
    # 未匹配的 Compose 栈以 discovered 自动登记,但只是只读资产:
    # 接管之前不参与操作、更新与告警,也不出现在容器页。
    projects = list(db.scalars(select(Project).where(Project.server_id == server.id)))
    by_compose = {p.compose_project: p for p in projects if p.compose_project}
    by_name = {p.name: p for p in projects}
    by_workdir: dict[str, list[Project]] = {}
    for p in projects:
        if p.kind != "docker-compose" or p.lifecycle == "ignored":
            continue
        key = normalized_work_dir(p.work_dir)
        if key:
            by_workdir.setdefault(key, []).append(p)

    synced = 0
    created = 0
    conflicts = 0
    skipped_ignored = 0
    managed_labels: dict[str, Project] = {}

    for item in payload.instances:
        label = compose_label(item.project)
        if label is None:
            # 非 Compose 容器不进入项目模型
            continue

        project = by_compose.get(label)

        # 显示名与 Compose 标签一致,但还没学习到标签:直接认领
        if project is None:
            candidate = by_name.get(label)
            if candidate is not None and candidate.kind == "docker-compose" and candidate.compose_project is None:
                project = candidate

        # 显示名与标签不同(如项目 dify、标签 docker):按唯一工作目录修复
        if project is None:
            work_dir_key = normalized_work_dir(item.compose_working_dir)
            if work_dir_key:
                candidates = [p for p in by_workdir.get(work_dir_key, []) if p.compose_project is None]
                if len(candidates) > 1:
                    observed_file = observed_compose_file(item.compose_file)
                    if observed_file:
                        candidates = [
                            p for p in candidates if observed_compose_file(p.compose_file) == observed_file
                        ]
                if len(candidates) == 1:
                    project = candidates[0]
                elif len(candidates) > 1:
                    # 多候选时不猜:错配会让操作打到另一个项目上
                    conflicts += 1
                    continue

        if project is None:
            if label in by_name:
                # 同名项目已存在但不是可学习的 Compose 项目,不能重复创建
                conflicts += 1
                continue

            project = Project(
                server_id=server.id,
                name=label,
                lifecycle="discovered",
                kind="docker-compose",
                compose_project=label,
                work_dir=observed_work_dir(item.compose_working_dir),
                compose_file=observed_compose_file(item.compose_file),
            )
            try:
                # 并发上报或名称占用时只回滚这一条,不影响本轮其它容器
                with db.begin_nested():
                    db.add(project)
                    db.flush()
            except IntegrityError:
                project = db.scalar(
                    select(Project).where(Project.server_id == server.id, Project.compose_project == label)
                )
                if project is None:
                    conflicts += 1
                    continue
            else:
                created += 1
                logger.info("自动发现项目: %s / %s", server.name, label)

            by_compose[label] = project
            by_name[project.name] = project
            work_dir_key = normalized_work_dir(project.work_dir)
            if work_dir_key:
                by_workdir.setdefault(work_dir_key, []).append(project)

        # 学习匹配键:只补空值,不覆盖已有标签
        if project.compose_project is None:
            project.compose_project = label
            by_compose[label] = project

        project.last_seen_at = now

        if project.lifecycle == "ignored":
            skipped_ignored += 1
            continue

        # 未接管项目跟随采集刷新路径;已接管项目只补空值,
        # 不覆盖人工确认过的配置(老数据常因发现规则缺失而留空)。
        if project.lifecycle == "discovered" or project.work_dir is None:
            work_dir = observed_work_dir(item.compose_working_dir)
            if work_dir:
                project.work_dir = work_dir
        if project.lifecycle == "discovered" or project.compose_file is None:
            compose_file = observed_compose_file(item.compose_file)
            if compose_file:
                project.compose_file = compose_file

        existing = db.scalar(select(Instance).where(Instance.project_id == project.id, Instance.name == item.name))
        if existing is None:
            existing = Instance(project_id=project.id, name=item.name)
            db.add(existing)

        previous_image = existing.image
        existing.image = item.image or existing.image
        existing.state = item.state or existing.state
        existing.health = item.health or existing.health
        existing.one_off = item.one_off
        # 镜像换了但新镜像没有 digest(本地构建)时,旧 digest 必须清掉,
        # 否则详情页会把上一版镜像的摘要挂在新容器上。
        if item.image_digest is not None:
            existing.image_digest = item.image_digest
        elif item.image and item.image != previous_image:
            existing.image_digest = None
        # 旧采集器没上报健康输出时保留旧值;健康检查恢复后旧输出不再展示,
        # 下一页采集会带回成功输出自然覆盖。
        if item.health_detail is not None:
            existing.health_detail = item.health_detail
        # 内存直接覆盖,不能用 `or` 兜底:采集器对"未设上限"和"没采集到"都给 0,
        # 用 `or` 会把 0 当成缺失,于是容器停掉之后还一直挂着上一次运行时的占用。
        existing.mem_used_mb = item.mem_used_mb or None
        existing.mem_limit_mb = item.mem_limit_mb or None

        # 退出码只对已退出容器有意义;运行中的容器清掉旧值。
        if item.state == "exited" and item.exit_code is not None:
            existing.exit_code = item.exit_code
        elif item.state != "exited":
            existing.exit_code = None
        if item.started_at is not None:
            existing.started_at = item.started_at
        # 崩溃字段:None 表示旧采集器没上报,保留旧值;false / 0 都是有效值。
        if item.restart_count is not None:
            existing.restart_count = item.restart_count
        if item.oom_killed is not None:
            existing.oom_killed = item.oom_killed
        # 重新运行时清掉上一次的退出时间;已退出容器只在采集器给出新值时更新,
        # 否则旧采集器部署下会把历史退出时间抹掉。
        if item.finished_at is not None:
            existing.finished_at = item.finished_at
        elif item.state in ("running", "paused", "created"):
            existing.finished_at = None
        # None 表示采集器没提供(旧版本或 inspect 失败),保留上次值;
        # 空列表是有效值(Docker 明确返回没有端口/挂载),照常写入。
        if item.ports is not None:
            existing.ports = item.ports
        if item.mounts is not None:
            existing.mounts = item.mounts
        if item.env_keys is not None:
            existing.env_keys = item.env_keys
        if item.restart_policy:
            existing.restart_policy = item.restart_policy

        # 容器资源趋势。旧采集器只会上报内存,同样落库;速率字段为空时
        # 前端画成缺口,不补 0。
        if item.state == "running":
            if existing.id is None:
                db.flush()
            db.add(
                ContainerMetric(
                    instance_id=existing.id,
                    captured_at=payload.captured_at or now,
                    cpu_percent=item.cpu_percent,
                    mem_used_mb=item.mem_used_mb or None,
                    net_rx_bps=item.net_rx_bps,
                    net_tx_bps=item.net_tx_bps,
                    block_read_bps=item.block_read_bps,
                    block_write_bps=item.block_write_bps,
                )
            )

        synced += 1
        if project.lifecycle == "managed":
            managed_labels[label] = project

    # 4. 记录离线容器为事件(仅已接管项目)
    #
    # 一次性任务容器(init_permissions / migrate / 建表脚本这类)跑完退出
    # 是它的正常生命周期,不是故障 —— 给它们发告警只会训练用户忽略告警。
    #
    # 判断依据只能是名字:旧采集器不给 exit_code 赋值(永远是 Go 的零值 0),
    # 所以"退出码为 0 就算正常"这种写法会把**所有**退出一律过滤掉,包括真故障。
    # 名字启发式会漏掉个别非常规命名,但它的错误方向是"少报一次正常退出",
    # 而不是"漏掉一次真实宕机"。
    def _is_one_shot(name: str) -> bool:
        lowered = name.lower()
        return any(marker in lowered for marker in ("init", "migrat", "setup", "provision"))

    exited = [
        (item, managed_labels[label])
        for item in payload.instances
        if (label := compose_label(item.project)) is not None
        and label in managed_labels
        and item.state == "exited"
        and not _is_one_shot(item.name)
    ]
    for item, project in exited:
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
                    detail=event_detail(project.name, item.name, item.exit_code),
                )
            )

    db.commit()

    if created or conflicts or skipped_ignored:
        logger.info(
            "采集发现: %s 新建 %d 个项目, %d 个实例因冲突跳过, %d 个实例属于已忽略项目",
            server.name,
            created,
            conflicts,
            skipped_ignored,
        )

    return IngestResult(
        server_id=server.id,
        server_name=server.name,
        instances_synced=synced,
        instances_ignored=len(payload.instances) - synced,
        projects_created=created,
        projects_conflicts=conflicts,
        instances_skipped_ignored=skipped_ignored,
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
    """返回采集到的容器实例。只包含已接管项目,未托管项目的容器需先接管。"""
    stmt = (
        select(Instance)
        .join(Project, Project.id == Instance.project_id)
        .where(Project.lifecycle == "managed")
        .order_by(Instance.name)
    )
    if server_id is not None:
        stmt = stmt.where(Project.server_id == server_id)
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
        .where(Project.lifecycle == "managed")
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
            image_digest=inst.image_digest,
            state=inst.state,
            health=inst.health,
            health_detail=inst.health_detail,
            one_off=inst.one_off,
            mem_used_mb=inst.mem_used_mb,
            mem_limit_mb=inst.mem_limit_mb,
            updated_at=inst.updated_at,
            project_name=project_name,
            server_id=server_id_,
            server_name=server_name,
            started_at=inst.started_at,
            exit_code=inst.exit_code,
            restart_count=inst.restart_count,
            oom_killed=inst.oom_killed,
            finished_at=inst.finished_at,
            ports=inst.ports,
            mounts=inst.mounts,
            env_keys=inst.env_keys,
            restart_policy=inst.restart_policy,
        )
        for inst, project_name, server_id_, server_name in db.execute(stmt)
    ]


@router.get(
    "/instances/{instance_id}/metrics",
    response_model=list[ContainerMetricRead],
    summary="容器指标历史",
)
def container_metric_history(
    instance_id: int,
    db: Session = Depends(get_db),
    _: User = Depends(require("view")),
    hours: int = Query(default=1, ge=1, le=720, description="回溯小时数"),
    points: int | None = Query(
        default=None,
        ge=2,
        le=500,
        description="按时间等分降采样到指定点数;留空返回原始样本",
    ),
) -> list[ContainerMetric] | list[dict[str, object]]:
    """返回单个容器的资源趋势,按时间升序。

    趋势只对已接管项目开放;未托管项目即便有采集数据也不对外暴露。
    空桶返回全 None,由前端画成缺口 —— 与服务器指标保持同一语义。
    """
    visible = db.execute(
        select(Instance.id)
        .join(Project, Project.id == Instance.project_id)
        .where(Instance.id == instance_id, Project.lifecycle == "managed")
    ).first()
    if visible is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="容器不存在")

    until = datetime.now(UTC)
    since = until - timedelta(hours=hours)
    rows = list(
        db.scalars(
            select(ContainerMetric)
            .where(ContainerMetric.instance_id == instance_id, ContainerMetric.captured_at >= since)
            .order_by(ContainerMetric.captured_at)
        )
    )
    if points is None or len(rows) <= points:
        return rows
    return _downsample_container(rows, points, since, until)


def _downsample_container(
    rows: list[ContainerMetric],
    points: int,
    since: datetime,
    until: datetime,
) -> list[dict[str, object]]:
    """按时间等分聚合容器指标。速率取均值,内存取均值后取整。"""
    span = max((until - since).total_seconds(), 1.0)
    step = span / points
    buckets: list[list[ContainerMetric]] = [[] for _ in range(points)]

    for row in rows:
        captured = row.captured_at
        if captured.tzinfo is None:
            captured = captured.replace(tzinfo=UTC)
        idx = int((captured - since).total_seconds() / step)
        buckets[min(points - 1, max(0, idx))].append(row)

    instance_id = rows[0].instance_id
    out: list[dict[str, object]] = []
    for i, chunk in enumerate(buckets):
        at = since + timedelta(seconds=step * (i + 1))
        if not chunk:
            out.append(
                {
                    "id": -(i + 1),
                    "instance_id": instance_id,
                    "captured_at": at,
                    "cpu_percent": None,
                    "mem_used_mb": None,
                    "net_rx_bps": None,
                    "net_tx_bps": None,
                    "block_read_bps": None,
                    "block_write_bps": None,
                }
            )
            continue

        out.append(
            {
                "id": chunk[0].id,
                "instance_id": instance_id,
                "captured_at": chunk[-1].captured_at,
                "cpu_percent": _mean(row.cpu_percent for row in chunk),
                "mem_used_mb": _mean_int(row.mem_used_mb for row in chunk),
                "net_rx_bps": _mean(row.net_rx_bps for row in chunk),
                "net_tx_bps": _mean(row.net_tx_bps for row in chunk),
                "block_read_bps": _mean(row.block_read_bps for row in chunk),
                "block_write_bps": _mean(row.block_write_bps for row in chunk),
            }
        )
    return out


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
