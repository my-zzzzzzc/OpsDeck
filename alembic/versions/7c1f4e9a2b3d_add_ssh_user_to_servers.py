"""add ssh user to servers

运维操作、终端、容器日志都通过 SSH 回连被管服务器,而此前用户名写死为 root
(在 app/ssh_terminal.py 里),导致只允许 ubuntu 登录的机器完全不可用。
这一列把它变成逐台可配。

Revision ID: 7c1f4e9a2b3d
Revises: 9340e5f8b6cc
Create Date: 2026-10-19 00:30:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "7c1f4e9a2b3d"
down_revision: str | None = "9340e5f8b6cc"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # 默认 root:与既有行为保持一致,已有机器不需要重新配置。
    op.add_column(
        "servers",
        sa.Column("ssh_user", sa.String(length=64), nullable=False, server_default="root"),
    )


def downgrade() -> None:
    op.drop_column("servers", "ssh_user")
