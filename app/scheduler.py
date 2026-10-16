"""内置后台调度器。

在 FastAPI 进程内以后台任务方式周期执行:
  - 告警检测(每 30 秒)
  - 数据清理(每 6 小时)

这样避免为一个自用工具再引入 Celery / Redis。任务失败只记日志,不影响 API 服务。
"""

import asyncio
import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager, suppress

from app.db import SessionLocal
from app.detection import cleanup_old_events, cleanup_old_metrics, run_detection
from app.ssh_terminal import cleanup_recordings
from app.terminal import close_stale_sessions

logger = logging.getLogger(__name__)

# 检测周期(秒)
DETECT_INTERVAL = 30

# 清理周期(秒),6 小时
CLEANUP_INTERVAL = 6 * 3600


async def _detection_loop() -> None:
    """周期执行告警检测,单次失败不终止循环。"""
    while True:
        try:
            await asyncio.sleep(DETECT_INTERVAL)
            # 检测是同步 DB 操作,放到线程池避免阻塞事件循环
            result = await asyncio.to_thread(_run_detection_once)
            if result["offline_events"] or result["threshold_events"]:
                logger.warning(
                    "检测产生新事件: 离线 %d 个, 阈值 %d 个",
                    result["offline_events"],
                    result["threshold_events"],
                )
        except asyncio.CancelledError:
            logger.info("检测调度器已停止")
            raise
        except Exception:
            logger.exception("检测执行失败,将在下个周期重试")


async def _cleanup_loop() -> None:
    """周期清理过期数据。启动后先等一个周期,避免与应用启动争抢资源。"""
    while True:
        try:
            await asyncio.sleep(CLEANUP_INTERVAL)
            metrics, events, recordings, stale = await asyncio.to_thread(_run_cleanup_once)
            if any((metrics, events, recordings, stale)):
                logger.info(
                    "清理完成: 指标 %d 行, 事件 %d 行, 录制 %d 个, 陈旧会话 %d 个",
                    metrics,
                    events,
                    recordings,
                    stale,
                )
        except asyncio.CancelledError:
            logger.info("清理调度器已停止")
            raise
        except Exception:
            logger.exception("清理执行失败,将在下个周期重试")


def _run_detection_once() -> dict[str, int]:
    """在独立会话中执行一轮检测。"""
    db = SessionLocal()
    try:
        return run_detection(db)
    finally:
        db.close()


def _run_cleanup_once() -> tuple[int, int, int, int]:
    """在独立会话中执行一轮清理。

    返回 (指标行数, 事件行数, 录制文件数, 陈旧会话数)。
    """
    db = SessionLocal()
    try:
        metrics = cleanup_old_metrics(db)
        events = cleanup_old_events(db)
        # 会话记录可能因进程被杀而残留 active,导致并发计数被永久占用
        stale = close_stale_sessions(db)
        return metrics, events, cleanup_recordings(), stale
    finally:
        db.close()


@asynccontextmanager
async def background_lifespan() -> AsyncIterator[None]:
    """启动全部后台任务,应用关闭时统一取消。"""
    tasks = [
        asyncio.create_task(_detection_loop(), name="detection"),
        asyncio.create_task(_cleanup_loop(), name="cleanup"),
    ]
    logger.info("后台调度器已启动: 检测 %d 秒,清理 %d 秒", DETECT_INTERVAL, CLEANUP_INTERVAL)

    try:
        yield
    finally:
        for task in tasks:
            task.cancel()
        for task in tasks:
            with suppress(asyncio.CancelledError):
                await task
