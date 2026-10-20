"""FastAPI 应用入口。"""

import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from app.api import (
    actions,
    audit,
    auth,
    chat,
    container_logs,
    dify_tools,
    health,
    observability,
    projects,
    servers,
    terminal,
)
from app.bootstrap import ensure_initial_admin
from app.config import settings
from app.scheduler import background_lifespan


@asynccontextmanager
async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
    """应用生命周期:创建初始管理员并启动后台调度器。"""
    ensure_initial_admin()

    if settings.secret_key == "dev-only-insecure-secret-change-me":
        logging.getLogger(__name__).warning(
            "SECRET_KEY 仍为默认值,请在生产环境通过环境变量设置随机密钥,否则 JWT 可被伪造。"
        )

    if not settings.scheduler_enabled:
        logging.getLogger(__name__).warning("后台调度器已关闭(SCHEDULER_ENABLED=false):告警检测与数据清理不会运行。")
        yield
        return

    async with background_lifespan():
        yield


def create_app() -> FastAPI:
    """构建并配置 FastAPI 应用。"""
    logging.basicConfig(level=settings.log_level.upper())

    app = FastAPI(
        title=settings.app_name,
        description="服务器与项目管理台,接入 Dify 提供 AI 问答与排障能力。",
        version="0.3.0",
        docs_url="/docs",
        redoc_url="/redoc",
        lifespan=lifespan,
    )

    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origin_list,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    # 系统与认证
    app.include_router(health.router, prefix="/api")
    app.include_router(auth.router, prefix="/api")
    app.include_router(audit.router, prefix="/api")

    # 资产管理
    app.include_router(servers.router, prefix="/api")
    app.include_router(projects.router, prefix="/api")

    # 观测数据
    app.include_router(observability.router, prefix="/api")

    # Dify 接入
    app.include_router(chat.router, prefix="/api")
    app.include_router(dify_tools.router, prefix="/api")

    # 白名单操作
    app.include_router(actions.router, prefix="/api")

    # Web 终端(仅管理员,需逐台授权)
    app.include_router(terminal.router, prefix="/api")
    app.add_api_websocket_route("/ws/terminal/{server_id}", terminal.terminal_websocket)

    # 容器日志(仅管理员):一次性回放 + 实时流
    app.include_router(container_logs.router, prefix="/api")
    app.add_api_websocket_route("/ws/containers/{instance_id}/logs", container_logs.container_logs_websocket)

    _mount_frontend(app)
    return app


def _mount_frontend(app: FastAPI) -> None:
    """挂载前端静态资源。

    构建产物存在时由后端直接托管(生产镜像即如此),单容器即可对外服务;
    开发期前端跑在 Vite dev server 上,此处不挂载。
    """
    static_dir = Path(settings.static_dir)
    index_file = static_dir / "index.html"

    if not index_file.is_file():
        logging.getLogger(__name__).info(
            "未找到前端构建产物(%s),跳过静态资源挂载;开发期请使用 Vite dev server。", static_dir
        )
        return

    # 静态资源目录(js/css/图片)
    assets_dir = static_dir / "assets"
    if assets_dir.is_dir():
        app.mount("/assets", StaticFiles(directory=assets_dir), name="assets")

    @app.get("/", include_in_schema=False)
    def spa_root() -> FileResponse:
        """返回 SPA 入口页。"""
        return FileResponse(index_file)

    @app.get("/{full_path:path}", include_in_schema=False)
    def spa_fallback(full_path: str) -> FileResponse:
        """前端路由回退。

        /api 与 /docs 已由前面的路由处理,不会走到这里;
        其余未知路径交给 SPA 处理(刷新子路由时不 404)。
        """
        candidate = static_dir / full_path
        if candidate.is_file():
            return FileResponse(candidate)
        return FileResponse(index_file)


app = create_app()
