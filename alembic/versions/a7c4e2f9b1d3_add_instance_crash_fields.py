"""add instance crash fields

容器排障需要的重启次数、OOM 终止标记与最近一次退出时间。
旧采集器不上报这三项,列保持可空,由后端保留已有值。

Revision ID: a7c4e2f9b1d3
Revises: e6b1a4c8d2f7
Create Date: 2026-10-21 16:45:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "a7c4e2f9b1d3"
down_revision: str | None = "e6b1a4c8d2f7"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("instances", sa.Column("restart_count", sa.Integer(), nullable=True))
    op.add_column("instances", sa.Column("oom_killed", sa.Boolean(), nullable=True))
    op.add_column("instances", sa.Column("finished_at", sa.DateTime(timezone=True), nullable=True))


def downgrade() -> None:
    op.drop_column("instances", "finished_at")
    op.drop_column("instances", "oom_killed")
    op.drop_column("instances", "restart_count")
