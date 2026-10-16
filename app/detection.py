"""告警检测引擎。

由 Celery 之外的后台任务周期调用,负责:
  1. 离线检测 —— 超过阈值未上报的服务器标记 offline 并产生事件
  2. 阈值检测 —— 内存 / swap / 磁盘超限时产生事件

设计要点:
  - 幂等:同类事件在静默期内只产生一次,避免刷屏(见 DEDUP_WINDOW)。
  - 自愈:条件恢复后自动关闭对应事件并写恢复记录。
  - 无外部依赖:不发送网络通知,事件只落库供界面展示。
"""

import logging
from datetime import UTC, datetime, timedelta

from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from app.config import settings
from app.models import Event, Metric, Server

logger = logging.getLogger(__name__)

# 服务器超过该时长未上报即视为离线
OFFLINE_AFTER = timedelta(minutes=2)

# 同类事件的静默窗口:窗口内不重复产生
DEDUP_WINDOW = timedelta(minutes=30)

# 阈值(百分比)
THRESHOLDS = {
    "mem": 90.0,
    "swap": 90.0,
    "disk": 90.0,
    "cpu": 95.0,
}

# 每个阈值对应的检测字段与展示名
THRESHOLD_FIELDS = {
    "mem": ("mem_used_mb", "mem_total_mb", "内存"),
    "swap": ("swap_used_mb", "swap_total_mb", "Swap"),
    "disk": ("disk_used_gb", "disk_total_gb", "磁盘"),
}


def _find_open_event(db: Session, kind: str, server_id, title: str | None = None):
    """查找同一故障的未解决事件。

    去重不按"是否已读"判断 —— 标记已读只表示人看过了,不代表故障恢复。
    也不按时间窗口新建:同一个持续存在的故障(如 Swap 长期 100%)应当
    始终对应同一条事件,而不是每 30 分钟新增一条。否则事件列表会变成
    "提醒历史",把真正待处理的问题淹没。

    恢复由 `_close_open_events` 负责:条件不再满足时才关闭。
    """
    stmt = select(Event).where(
        Event.kind == kind,
        Event.server_id == server_id,
        Event.acknowledged.is_(False),
    )
    if title is not None:
        stmt = stmt.where(Event.title == title)
    return db.scalar(stmt.order_by(Event.created_at.desc()))


def _touch_event(event: Event, detail: str, level: str) -> None:
    """刷新一条仍在持续的事件。

    只更新时间与描述,不新增记录;同时重置已读状态 ——
    故障数值变化了,用户需要重新注意到。
    """
    event.detail = detail
    event.level = level
    event.created_at = datetime.now(UTC)


def _close_open_events(db: Session, kind: str, server_id) -> int:
    """条件恢复后关闭同一服务器上未解决的同类事件,返回关闭数量。"""
    open_events = list(
        db.scalars(
            select(Event).where(
                Event.kind == kind,
                Event.server_id == server_id,
                Event.acknowledged.is_(False),
            )
        )
    )
    for event in open_events:
        event.acknowledged = True
    return len(open_events)


def detect_offline_servers(db: Session) -> list[Event]:
    """检测长时间未上报的服务器,标记 offline 并产生事件。"""
    now = datetime.now(UTC)
    cutoff = now - OFFLINE_AFTER
    created: list[Event] = []

    # 只看曾经上报过的服务器:从未上报的保持 unknown,不算故障
    candidates = list(db.scalars(select(Server).where(Server.last_seen_at.is_not(None), Server.status == "online")))

    for server in candidates:
        if server.last_seen_at is None or server.last_seen_at > cutoff:
            continue

        server.status = "offline"
        silent_minutes = int((now - server.last_seen_at).total_seconds() // 60)

        detail = f"已 {silent_minutes} 分钟未收到采集上报。请检查采集器进程与该主机网络。"

        existing = _find_open_event(db, "offline", server.id)
        if existing is not None:
            _touch_event(existing, detail, "critical")
            continue

        event = Event(
            server_id=server.id,
            level="critical",
            kind="offline",
            title=f"服务器离线: {server.name}",
            detail=detail,
        )
        db.add(event)
        created.append(event)
        logger.warning("服务器离线: %s (静默 %d 分钟)", server.name, silent_minutes)

    return created


def detect_thresholds(db: Session) -> list[Event]:
    """对最新的指标快照做阈值检测。"""
    now = datetime.now(UTC)
    created: list[Event] = []

    # 取每台服务器最近一条指标
    newest = (
        select(Metric.server_id, Metric.captured_at.label("captured_at"))
        .distinct(Metric.server_id)
        .order_by(Metric.server_id, Metric.captured_at.desc())
        .subquery()
    )
    latest = list(
        db.scalars(
            select(Metric).join(
                newest,
                (Metric.server_id == newest.c.server_id) & (Metric.captured_at == newest.c.captured_at),
            )
        )
    )

    servers = {s.id: s for s in db.scalars(select(Server))}

    for metric in latest:
        server = servers.get(metric.server_id)
        if server is None:
            continue

        # 只对在线服务器告警:离线时数据陈旧,无意义
        if server.status != "online":
            continue

        for kind, (used_field, total_field, label) in THRESHOLD_FIELDS.items():
            used = getattr(metric, used_field, None)
            total = getattr(metric, total_field, None)
            if not used or not total or total <= 0:
                continue

            pct = used / total * 100
            if pct < THRESHOLDS[kind]:
                # 已恢复:关闭遗留事件
                if _close_open_events(db, kind, server.id):
                    logger.info("%s 的 %s 告警已恢复", server.name, label)
                continue

            level = "critical" if pct >= 95 else "warning"
            title = f"{label}占用过高: {server.name} ({pct:.0f}%)"
            detail = (
                f"{label} 已使用 {used:.0f} / {total:.0f},超过 {THRESHOLDS[kind]:.0f}% 阈值。建议检查高占用进程或扩容。"
            )

            # 同一类阈值问题始终对应一条事件:存在则刷新,不存在才新建
            existing = _find_open_event(db, kind, server.id)
            if existing is not None:
                _touch_event(existing, detail, level)
                continue

            event = Event(
                server_id=server.id,
                level=level,
                kind=kind,
                title=title,
                detail=detail,
            )
            db.add(event)
            created.append(event)

        # CPU 是瞬时值:高时提醒,回落即关闭,避免长期挂一条陈旧的告警
        cpu = metric.cpu_percent
        if cpu is not None:
            if cpu >= THRESHOLDS["cpu"]:
                detail = f"最近一次采样 CPU 为 {cpu:.1f}%。"
                existing = _find_open_event(db, "cpu", server.id)
                if existing is not None:
                    _touch_event(existing, detail, "warning")
                else:
                    event = Event(
                        server_id=server.id,
                        level="warning",
                        kind="cpu",
                        title=f"CPU 占用过高: {server.name} ({cpu:.0f}%)",
                        detail=detail,
                    )
                    db.add(event)
                    created.append(event)
            else:
                _close_open_events(db, "cpu", server.id)

    _ = now
    return created


def run_detection(db: Session) -> dict[str, int]:
    """执行一轮完整检测,返回本轮产生的事件数。"""
    offline = detect_offline_servers(db)
    thresholds = detect_thresholds(db)
    db.commit()

    return {"offline_events": len(offline), "threshold_events": len(thresholds)}


def cleanup_old_metrics(db: Session) -> int:
    """删除超过保留期的指标数据,返回删除行数。

    指标按采集间隔持续写入,不清理会无限增长。
    """
    cutoff = datetime.now(UTC) - timedelta(days=settings.metric_retention_days)
    result = db.execute(delete(Metric).where(Metric.captured_at < cutoff))
    db.commit()
    return result.rowcount or 0


def cleanup_old_events(db: Session) -> int:
    """删除超过保留期且已处理的事件。

    未处理的事件保留 —— 它们仍需人工关注。
    """
    cutoff = datetime.now(UTC) - timedelta(days=settings.event_retention_days)
    result = db.execute(delete(Event).where(Event.created_at < cutoff, Event.acknowledged.is_(True)))
    db.commit()
    return result.rowcount or 0
