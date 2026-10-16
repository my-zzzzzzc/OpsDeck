"""ORM 模型。

包含资产核心(服务器、项目)与阶段 2 的观测数据(实例、指标、事件)。
"""

import uuid
from datetime import datetime
from typing import Any

from sqlalchemy import (
    BigInteger,
    Boolean,
    DateTime,
    Float,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
    func,
)
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db import Base


class TimestampMixin:
    """为模型提供创建时间与更新时间。"""

    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False
    )


class Server(Base, TimestampMixin):
    """一台被管理的服务器。

    `agent_token` 是采集器上报时使用的凭证,每台服务器一把。
    """

    __tablename__ = "servers"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    name: Mapped[str] = mapped_column(String(64), nullable=False, unique=True)
    hostname: Mapped[str | None] = mapped_column(String(255))
    ip: Mapped[str | None] = mapped_column(String(64))
    ssh_port: Mapped[int] = mapped_column(Integer, default=22, server_default="22", nullable=False)

    # SSH 私钥路径。留空则使用标准密钥(id_rsa / id_ed25519)。
    # 若目标机使用专用密钥(如 ~/.ssh/hermes_server),必须在此显式指定 ——
    # asyncssh 不会读取 ~/.ssh/config,只自动加载标准命名的密钥。
    ssh_key_path: Mapped[str | None] = mapped_column(String(512))

    os_info: Mapped[str | None] = mapped_column(String(255))
    cpu_cores: Mapped[int | None] = mapped_column(Integer)
    mem_total_mb: Mapped[int | None] = mapped_column(Integer)

    agent_token: Mapped[str] = mapped_column(String(64), nullable=False, default=lambda: uuid.uuid4().hex)

    # online / offline / unknown
    status: Mapped[str] = mapped_column(String(16), default="unknown", server_default="unknown", nullable=False)
    last_seen_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    # 是否允许通过 Web 终端登录该服务器。默认关闭,需管理员逐台开启。
    terminal_enabled: Mapped[bool] = mapped_column(Boolean, default=False, server_default="false", nullable=False)

    note: Mapped[str | None] = mapped_column(Text)

    projects: Mapped[list["Project"]] = relationship(
        back_populates="server", cascade="all, delete-orphan", passive_deletes=True
    )


class Project(Base, TimestampMixin):
    """一个被管理的项目 / 服务。

    这是 OpsDeck 的核心资产:记录"这个项目是什么、在哪、怎么重启"。
    """

    __tablename__ = "projects"
    __table_args__ = (UniqueConstraint("server_id", "name", name="uq_projects_server_name"),)

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    server_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("servers.id", ondelete="CASCADE"), nullable=False, index=True
    )
    name: Mapped[str] = mapped_column(String(64), nullable=False)

    # docker-compose / docker / systemd / binary
    kind: Mapped[str] = mapped_column(String(32), default="docker-compose", server_default="docker-compose")

    work_dir: Mapped[str | None] = mapped_column(String(512))
    compose_file: Mapped[str | None] = mapped_column(String(255))

    # [{"host": 8090, "container": 80, "proto": "tcp"}]
    ports: Mapped[list[dict[str, Any]] | None] = mapped_column(JSONB)

    url: Mapped[str | None] = mapped_column(String(512))
    restart_cmd: Mapped[str | None] = mapped_column(Text)
    upgrade_cmd: Mapped[str | None] = mapped_column(Text)
    depends_on: Mapped[list[str] | None] = mapped_column(JSONB)
    tags: Mapped[list[str] | None] = mapped_column(JSONB)

    note: Mapped[str | None] = mapped_column(Text)

    server: Mapped[Server] = relationship(back_populates="projects")
    instances: Mapped[list["Instance"]] = relationship(
        back_populates="project", cascade="all, delete-orphan", passive_deletes=True
    )


class Instance(Base):
    """某个项目下被采集到的容器 / 进程实例。

    由采集器上报后按 (project_id, name) 幂等更新。
    """

    __tablename__ = "instances"
    __table_args__ = (UniqueConstraint("project_id", "name", name="uq_instances_project_name"),)

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    project_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("projects.id", ondelete="CASCADE"), nullable=False, index=True
    )

    name: Mapped[str] = mapped_column(String(255), nullable=False)
    image: Mapped[str | None] = mapped_column(String(255))
    state: Mapped[str | None] = mapped_column(String(32))
    health: Mapped[str | None] = mapped_column(String(32))
    exit_code: Mapped[int | None] = mapped_column(Integer)
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    mem_used_mb: Mapped[int | None] = mapped_column(Integer)
    mem_limit_mb: Mapped[int | None] = mapped_column(Integer)

    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False
    )

    project: Mapped[Project] = relationship(back_populates="instances")


class Metric(Base):
    """服务器资源指标快照,由采集器按间隔上报。

    属于时序数据,需定期清理(建议保留 30 天)。
    """

    __tablename__ = "metrics"
    __table_args__ = (Index("ix_metrics_server_captured", "server_id", "captured_at"),)

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    server_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("servers.id", ondelete="CASCADE"), nullable=False
    )

    captured_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)

    cpu_percent: Mapped[float | None] = mapped_column(Float)
    mem_used_mb: Mapped[int | None] = mapped_column(Integer)
    mem_total_mb: Mapped[int | None] = mapped_column(Integer)
    swap_used_mb: Mapped[int | None] = mapped_column(Integer)
    swap_total_mb: Mapped[int | None] = mapped_column(Integer)
    disk_used_gb: Mapped[float | None] = mapped_column(Float)
    disk_total_gb: Mapped[float | None] = mapped_column(Float)
    load_1: Mapped[float | None] = mapped_column(Float)
    load_5: Mapped[float | None] = mapped_column(Float)
    load_15: Mapped[float | None] = mapped_column(Float)


class Event(Base):
    """事件与告警:服务离线、容器退出、阈值越界等。"""

    __tablename__ = "events"
    __table_args__ = (Index("ix_events_created", "created_at"),)

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    server_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("servers.id", ondelete="CASCADE")
    )
    project_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("projects.id", ondelete="SET NULL")
    )

    # info / warning / critical
    level: Mapped[str] = mapped_column(String(16), nullable=False, default="info")
    # offline / oom / exit / high_mem / high_swap / deploy
    kind: Mapped[str] = mapped_column(String(32), nullable=False)

    title: Mapped[str] = mapped_column(String(255), nullable=False)
    detail: Mapped[str | None] = mapped_column(Text)

    acknowledged: Mapped[bool] = mapped_column(Boolean, default=False, server_default="false", nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)


# ---------------------------------------------------------------- 账户与权限


class User(Base, TimestampMixin):
    """系统用户。

    角色决定可执行的操作范围,见 `app.auth.ROLE_PERMISSIONS`:
      - admin:    全部权限,含用户管理
      - operator: 查看 + 执行运维操作,不能管理用户与资产删除
      - viewer:   只读
    """

    __tablename__ = "users"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    username: Mapped[str] = mapped_column(String(64), nullable=False, unique=True, index=True)
    email: Mapped[str | None] = mapped_column(String(255), unique=True)
    display_name: Mapped[str | None] = mapped_column(String(64))

    password_hash: Mapped[str] = mapped_column(String(255), nullable=False)
    role: Mapped[str] = mapped_column(String(16), nullable=False, default="viewer", server_default="viewer")

    is_active: Mapped[bool] = mapped_column(Boolean, default=True, server_default="true", nullable=False)

    # 最后登录信息,便于排查异常登录
    last_login_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    last_login_ip: Mapped[str | None] = mapped_column(String(64))

    created_by: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL")
    )


class AuditLog(Base):
    """操作审计:记录谁、在什么时间、对什么对象、做了什么。

    写入失败不应影响主流程,因此由调用方在业务事务提交后单独记录。
    """

    __tablename__ = "audit_logs"
    __table_args__ = (Index("ix_audit_created", "created_at"),)

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)

    user_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"))
    # 冗余用户名:用户被删后审计记录仍需可读
    username: Mapped[str | None] = mapped_column(String(64))

    # create / update / delete / login / login_failed / logout / execute
    action: Mapped[str] = mapped_column(String(32), nullable=False)
    # server / project / user / auth / action / dify_app
    target_type: Mapped[str | None] = mapped_column(String(32))
    target_id: Mapped[str | None] = mapped_column(String(64))
    target_name: Mapped[str | None] = mapped_column(String(128))

    detail: Mapped[str | None] = mapped_column(Text)
    ip: Mapped[str | None] = mapped_column(String(64))
    success: Mapped[bool] = mapped_column(Boolean, default=True, server_default="true", nullable=False)

    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)


# ---------------------------------------------------------------- Dify 接入


class DifyApp(Base, TimestampMixin):
    """登记的 Dify 应用。

    Dify 每个应用有独立的 API Key,这里让一个 OpsDeck 实例可以同时对接
    多个应用(如"运维助手""日志分析""知识问答"),前端按用途切换。

    api_key 属于敏感凭据:读取接口只返回掩码后的值,不返回明文。
    """

    __tablename__ = "dify_apps"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    name: Mapped[str] = mapped_column(String(64), nullable=False, unique=True)

    # chat / agent / completion / workflow —— 决定调用哪个 Dify 接口
    mode: Mapped[str] = mapped_column(String(32), nullable=False, default="chat", server_default="chat")

    api_key: Mapped[str] = mapped_column(String(255), nullable=False)
    description: Mapped[str | None] = mapped_column(Text)

    is_default: Mapped[bool] = mapped_column(Boolean, default=False, server_default="false", nullable=False)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, server_default="true", nullable=False)


class ChatConversation(Base, TimestampMixin):
    """对话会话。

    dify_conversation_id 由 Dify 分配,用于保持多轮上下文。
    """

    __tablename__ = "chat_conversations"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"))
    dify_app_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("dify_apps.id", ondelete="SET NULL")
    )

    dify_conversation_id: Mapped[str | None] = mapped_column(String(64))
    title: Mapped[str | None] = mapped_column(String(255))

    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    # updated_at 用于按最近活跃排序
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False
    )


class ActionLog(Base):
    """白名单操作的执行记录。

    与 audit_logs 的区别:audit_logs 记录"谁改了什么资产",
    action_logs 记录"谁在哪个项目上执行了什么命令及其输出"。
    """

    __tablename__ = "action_logs"
    __table_args__ = (Index("ix_action_logs_created", "created_at"),)

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)

    project_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("projects.id", ondelete="SET NULL")
    )
    project_name: Mapped[str | None] = mapped_column(String(64))

    action: Mapped[str] = mapped_column(String(64), nullable=False)
    command: Mapped[str | None] = mapped_column(Text)

    # pending / running / success / failed / rejected
    status: Mapped[str] = mapped_column(String(16), nullable=False, default="pending")

    output: Mapped[str | None] = mapped_column(Text)
    exit_code: Mapped[int | None] = mapped_column(Integer)

    # 触发来源:manual(界面按钮) / dify(AI 建议后由人确认)
    triggered_by: Mapped[str] = mapped_column(String(16), nullable=False, default="manual")
    user_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"))
    username: Mapped[str | None] = mapped_column(String(64))

    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class TerminalSession(Base):
    """Web 终端会话记录。

    终端能执行任意命令,是系统中最高的权限入口,因此每次会话都必须留痕:
    谁、何时、连了哪台机器、做了什么(通过录制回放)、为什么结束。
    """

    __tablename__ = "terminal_sessions"
    __table_args__ = (Index("ix_terminal_sessions_started", "started_at"),)

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)

    server_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("servers.id", ondelete="SET NULL")
    )
    # 冗余服务器名:服务器被删后仍能读懂历史记录
    server_name: Mapped[str | None] = mapped_column(String(64))

    user_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"))
    username: Mapped[str | None] = mapped_column(String(64))

    # active / closed / failed
    status: Mapped[str] = mapped_column(String(16), nullable=False, default="active")
    # user_closed / idle_timeout / max_duration / error / server_disabled
    close_reason: Mapped[str | None] = mapped_column(String(32))

    client_ip: Mapped[str | None] = mapped_column(String(64))
    # asciinema v2 录制文件路径(相对于录制目录)
    recording_path: Mapped[str | None] = mapped_column(String(255))

    bytes_in: Mapped[int] = mapped_column(BigInteger, default=0, server_default="0", nullable=False)
    bytes_out: Mapped[int] = mapped_column(BigInteger, default=0, server_default="0", nullable=False)

    started_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    ended_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class TerminalCredential(Base):
    """终端二次确认凭据。

    与登录密码分离:即使登录令牌泄露,攻击者仍需单独知道终端密码。
    这是"一次泄露"与"两次泄露"的区别。
    """

    __tablename__ = "terminal_credentials"

    user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), primary_key=True
    )
    password_hash: Mapped[str] = mapped_column(String(255), nullable=False)

    # 连续失败次数,用于额外的账号级锁定
    failed_attempts: Mapped[int] = mapped_column(Integer, default=0, server_default="0", nullable=False)
    locked_until: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False
    )
