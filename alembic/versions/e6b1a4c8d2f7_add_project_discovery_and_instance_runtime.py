"""add project discovery state and instance runtime config

Compose 项目自动发现:项目增加 lifecycle / compose_project / last_seen_at,
实例增加端口、挂载、环境变量键名与重启策略。

不回填 compose_project:现有项目的显示名未必等于 Compose 标签,
由后续采集按「标签 → 名称 → 唯一工作目录」学习,避免张冠李戴。

Revision ID: e6b1a4c8d2f7
Revises: c3a7e9f1d2b4
Create Date: 2026-10-21 10:00:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision: str = "e6b1a4c8d2f7"
down_revision: str | None = "c3a7e9f1d2b4"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "projects",
        sa.Column("lifecycle", sa.String(length=16), server_default="managed", nullable=False),
    )
    op.add_column("projects", sa.Column("compose_project", sa.String(length=64), nullable=True))
    op.add_column("projects", sa.Column("last_seen_at", sa.DateTime(timezone=True), nullable=True))
    op.create_index(
        "uq_projects_server_compose",
        "projects",
        ["server_id", "compose_project"],
        unique=True,
        postgresql_where=sa.text("compose_project IS NOT NULL"),
    )

    op.add_column("instances", sa.Column("ports", postgresql.JSONB(astext_type=sa.Text()), nullable=True))
    op.add_column("instances", sa.Column("mounts", postgresql.JSONB(astext_type=sa.Text()), nullable=True))
    op.add_column("instances", sa.Column("env_keys", postgresql.JSONB(astext_type=sa.Text()), nullable=True))
    op.add_column("instances", sa.Column("restart_policy", sa.String(length=64), nullable=True))


def downgrade() -> None:
    op.drop_column("instances", "restart_policy")
    op.drop_column("instances", "env_keys")
    op.drop_column("instances", "mounts")
    op.drop_column("instances", "ports")

    op.drop_index("uq_projects_server_compose", table_name="projects")
    op.drop_column("projects", "last_seen_at")
    op.drop_column("projects", "compose_project")
    op.drop_column("projects", "lifecycle")
