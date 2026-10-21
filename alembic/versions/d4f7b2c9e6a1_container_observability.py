"""add container observability fields and metrics

容器排障需要的镜像 digest、健康检查最近输出、一次性任务标签,
以及用于资源趋势的 container_metrics 时序表。

Revision ID: d4f7b2c9e6a1
Revises: a7c4e2f9b1d3
Create Date: 2026-10-21 17:20:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "d4f7b2c9e6a1"
down_revision: str | None = "a7c4e2f9b1d3"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("instances", sa.Column("image_digest", sa.String(length=128), nullable=True))
    op.add_column("instances", sa.Column("health_detail", sa.Text(), nullable=True))
    op.add_column(
        "instances",
        sa.Column("one_off", sa.Boolean(), nullable=False, server_default=sa.text("false")),
    )

    op.create_table(
        "container_metrics",
        sa.Column("id", sa.BigInteger(), autoincrement=True, nullable=False),
        sa.Column("instance_id", sa.BigInteger(), nullable=False),
        sa.Column("captured_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("cpu_percent", sa.Float(), nullable=True),
        sa.Column("mem_used_mb", sa.Integer(), nullable=True),
        sa.Column("net_rx_bps", sa.Float(), nullable=True),
        sa.Column("net_tx_bps", sa.Float(), nullable=True),
        sa.Column("block_read_bps", sa.Float(), nullable=True),
        sa.Column("block_write_bps", sa.Float(), nullable=True),
        sa.ForeignKeyConstraint(["instance_id"], ["instances.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "ix_container_metrics_instance_captured",
        "container_metrics",
        ["instance_id", "captured_at"],
    )


def downgrade() -> None:
    op.drop_index("ix_container_metrics_instance_captured", table_name="container_metrics")
    op.drop_table("container_metrics")
    op.drop_column("instances", "one_off")
    op.drop_column("instances", "health_detail")
    op.drop_column("instances", "image_digest")
