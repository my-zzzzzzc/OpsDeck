"""add project update configs

每个项目一个权威更新来源,记录最近一次检测结果。更新是项目级概念:
Dify 的 postgres / redis / nginx 是内部依赖,不应各自成为更新单元。

Revision ID: c3a7e9f1d2b4
Revises: 7c1f4e9a2b3d
Create Date: 2026-10-20 10:00:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision: str = "c3a7e9f1d2b4"
down_revision: str | None = "7c1f4e9a2b3d"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "project_update_configs",
        sa.Column("id", sa.UUID(), nullable=False),
        sa.Column("project_id", sa.UUID(), nullable=False),
        sa.Column("source_type", sa.String(length=16), server_default="manual", nullable=False),
        sa.Column("confirmed", sa.Boolean(), server_default="false", nullable=False),
        sa.Column("auto_detected", sa.Boolean(), server_default="false", nullable=False),
        sa.Column("repo_url", sa.String(length=512), nullable=True),
        sa.Column("branch", sa.String(length=128), nullable=True),
        sa.Column("image_ref", sa.String(length=255), nullable=True),
        sa.Column("upstream_repo", sa.String(length=255), nullable=True),
        sa.Column("current_version", sa.String(length=128), nullable=True),
        sa.Column("latest_version", sa.String(length=128), nullable=True),
        sa.Column("status", sa.String(length=32), server_default="unknown", nullable=False),
        sa.Column("detail", sa.Text(), nullable=True),
        sa.Column("release_url", sa.String(length=512), nullable=True),
        sa.Column("extra", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column("last_checked_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("last_success_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.ForeignKeyConstraint(["project_id"], ["projects.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("project_id", name="uq_project_update_configs_project"),
    )
    op.create_index(
        op.f("ix_project_update_configs_project_id"),
        "project_update_configs",
        ["project_id"],
        unique=False,
    )


def downgrade() -> None:
    op.drop_index(op.f("ix_project_update_configs_project_id"), table_name="project_update_configs")
    op.drop_table("project_update_configs")
