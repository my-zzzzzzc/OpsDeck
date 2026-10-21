"""观测数据(指标、实例、事件)与采集上报的 Pydantic 契约。"""

import uuid
from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

# ---------------------------------------------------------------- 上报(采集器 → 后端)


class HostInfo(BaseModel):
    """采集到的主机基本信息,用于回填服务器资产。"""

    hostname: str | None = None
    os_info: str | None = None
    cpu_cores: int | None = Field(default=None, ge=0)
    mem_total_mb: int | None = Field(default=None, ge=0)


class MetricsPayload(BaseModel):
    """一次资源快照。"""

    cpu_percent: float | None = Field(default=None, ge=0, le=100)
    mem_used_mb: int | None = Field(default=None, ge=0)
    mem_total_mb: int | None = Field(default=None, ge=0)
    swap_used_mb: int | None = Field(default=None, ge=0)
    swap_total_mb: int | None = Field(default=None, ge=0)
    disk_used_gb: float | None = Field(default=None, ge=0)
    disk_total_gb: float | None = Field(default=None, ge=0)
    load_1: float | None = None
    load_5: float | None = None
    load_15: float | None = None


class InstancePayload(BaseModel):
    """采集到的一个容器实例。

    `project` 对应 Docker Compose 的项目名。未匹配到已登记项目时,
    后端会以 discovered 状态自动登记,而不是丢弃。
    """

    name: str = Field(max_length=255)
    project: str = Field(default="", max_length=64)
    image: str | None = Field(default=None, max_length=255)
    image_digest: str | None = Field(default=None, max_length=128)
    state: str | None = Field(default=None, max_length=32)
    health: str | None = Field(default=None, max_length=32)
    health_detail: str | None = Field(default=None, max_length=1000)
    one_off: bool = False
    exit_code: int | None = None
    started_at: datetime | None = None
    restart_count: int | None = Field(default=None, ge=0)
    oom_killed: bool | None = None
    finished_at: datetime | None = None
    mem_used_mb: int | None = Field(default=None, ge=0)
    mem_limit_mb: int | None = Field(default=None, ge=0)
    # 容器资源速率:CPU 为整机占比,其余为字节/秒。None 表示本帧没有基线。
    cpu_percent: float | None = Field(default=None, ge=0)
    net_rx_bps: float | None = Field(default=None, ge=0)
    net_tx_bps: float | None = Field(default=None, ge=0)
    block_read_bps: float | None = Field(default=None, ge=0)
    block_write_bps: float | None = Field(default=None, ge=0)

    # Compose 标签,用于识别项目工作目录与 Compose 文件
    compose_working_dir: str | None = Field(default=None, max_length=512)
    compose_file: str | None = Field(default=None, max_length=255)
    # 容器运行配置。env_keys 只包含键名,值不进入上报体。
    ports: list[dict[str, Any]] | None = Field(default=None, max_length=50)
    mounts: list[dict[str, Any]] | None = Field(default=None, max_length=50)
    env_keys: list[str] | None = Field(default=None, max_length=100)
    restart_policy: str | None = Field(default=None, max_length=64)


class ReportPayload(BaseModel):
    """采集器的完整上报体。"""

    host: HostInfo = Field(default_factory=HostInfo)
    metrics: MetricsPayload = Field(default_factory=MetricsPayload)
    instances: list[InstancePayload] = Field(default_factory=list)
    captured_at: datetime | None = None
    agent_version: str | None = None


class IngestResult(BaseModel):
    """上报处理结果。"""

    server_id: uuid.UUID
    server_name: str
    instances_synced: int = Field(description="已同步到项目的实例数")
    instances_ignored: int = Field(description="未同步的实例数:非 Compose 容器、已忽略项目或名称冲突")
    projects_created: int = Field(default=0, description="本轮自动发现的未托管项目数")
    projects_conflicts: int = Field(default=0, description="因名称冲突或匹配不唯一而跳过的实例数")
    instances_skipped_ignored: int = Field(default=0, description="属于已忽略项目而未同步的实例数")


# ---------------------------------------------------------------- 查询(后端 → 前端)


class MetricRead(BaseModel):
    """指标快照读取模型。"""

    model_config = ConfigDict(from_attributes=True)

    id: int
    server_id: uuid.UUID
    captured_at: datetime
    cpu_percent: float | None
    mem_used_mb: int | None
    mem_total_mb: int | None
    swap_used_mb: int | None
    swap_total_mb: int | None
    disk_used_gb: float | None
    disk_total_gb: float | None
    load_1: float | None
    load_5: float | None
    load_15: float | None


class ContainerMetricRead(BaseModel):
    """容器指标快照读取模型。空桶的 id 用负数占位,其余字段为 None。"""

    model_config = ConfigDict(from_attributes=True)

    id: int
    instance_id: int
    captured_at: datetime
    cpu_percent: float | None
    mem_used_mb: int | None
    net_rx_bps: float | None
    net_tx_bps: float | None
    block_read_bps: float | None
    block_write_bps: float | None


class InstanceRead(BaseModel):
    """实例读取模型。"""

    model_config = ConfigDict(from_attributes=True)

    id: int
    project_id: uuid.UUID
    name: str
    image: str | None
    state: Literal["running", "exited", "created", "restarting", "paused", "dead"] | str | None
    health: str | None
    mem_used_mb: int | None
    mem_limit_mb: int | None
    updated_at: datetime


class InstanceDetailRead(InstanceRead):
    """实例读取模型(带所属项目与服务器名)。

    容器看板要跨服务器汇总,每个容器必须能说清"它属于哪个项目、跑在哪台机器上"。
    单独一个模型而不是往 InstanceRead 里加字段:后者是上报端与采集器共用的契约,
    扩展它会让所有读 InstanceRead 的地方都以为拿到了联表数据。
    """

    project_name: str | None = None
    server_id: uuid.UUID | None = None
    server_name: str | None = None
    # 镜像 digest 与最近一次健康检查输出(旧采集器为 None)
    image_digest: str | None = None
    health_detail: str | None = None
    # Docker Compose 一次性任务标签
    one_off: bool = False
    # 容器的启动时间与退出码。旧采集器不上报,前端必须把 None 渲染成「—」。
    started_at: datetime | None = None
    exit_code: int | None = None
    # 崩溃排障:重启次数、OOM 终止标记、最近一次退出时间
    restart_count: int | None = None
    oom_killed: bool | None = None
    finished_at: datetime | None = None
    # 运行配置:端口、挂载、环境变量键名与重启策略
    ports: list[dict[str, Any]] | None = None
    mounts: list[dict[str, Any]] | None = None
    env_keys: list[str] | None = None
    restart_policy: str | None = None


class EventRead(BaseModel):
    """事件读取模型。"""

    model_config = ConfigDict(from_attributes=True)

    id: int
    server_id: uuid.UUID | None
    project_id: uuid.UUID | None
    level: Literal["info", "warning", "critical"] | str
    kind: str
    title: str
    detail: str | None
    acknowledged: bool
    created_at: datetime
