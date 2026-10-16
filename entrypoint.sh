#!/bin/sh
# 容器启动入口:先应用数据库迁移,再启动应用。
# 迁移失败时直接退出,避免用旧表结构对外提供服务。
set -e

echo "[entrypoint] 应用数据库迁移..."
alembic upgrade head

echo "[entrypoint] 启动应用: $*"
exec "$@"
