# 多阶段构建:构建前端 → 安装后端依赖 → 合成运行时镜像
#
# 最终镜像同时提供 API 与前端静态资源,省去一个容器与一次网络跳转。

# ---------- 阶段 1:构建前端 ----------
FROM node:24-alpine AS web

WORKDIR /web

# 先装依赖,利用层缓存
COPY frontend/package.json frontend/pnpm-lock.yaml* ./
RUN corepack enable && pnpm install --frozen-lockfile || pnpm install

COPY frontend/ ./
RUN pnpm build


# ---------- 阶段 2:运行时 ----------
FROM python:3.12-slim

# uv:与开发环境一致的依赖管理方式
COPY --from=ghcr.io/astral-sh/uv:latest /uv /usr/local/bin/uv

WORKDIR /app

# 系统依赖:ssh 用于远程操作被管服务器;curl 供健康检查
RUN apt-get update \
    && apt-get install -y --no-install-recommends openssh-client curl \
    && rm -rf /var/lib/apt/lists/*

# 先装 Python 依赖,利用层缓存
COPY pyproject.toml uv.lock* ./
RUN uv sync --no-dev --frozen 2>/dev/null || uv sync --no-dev

# 应用代码
COPY app/ ./app/
COPY alembic/ ./alembic/
COPY alembic.ini ./
COPY entrypoint.sh ./
RUN chmod +x entrypoint.sh

# 前端静态资源
COPY --from=web /web/dist ./static

ENV PATH="/app/.venv/bin:$PATH" \
    PYTHONUNBUFFERED=1 \
    STATIC_DIR=/app/static

EXPOSE 8000

# 启动前先跑迁移,避免新版本代码遇到旧表结构
ENTRYPOINT ["./entrypoint.sh"]
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--proxy-headers", "--forwarded-allow-ips", "*"]
