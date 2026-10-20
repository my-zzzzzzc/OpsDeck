"""观测数据(指标、实例、事件)与采集上报的 Pydantic 契约。"""

import uuid
from datetime import datetime
from typing import Literal

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

    `project` 对应 Docker Compose 的项目名,用于匹配已登记的项目资产。
    未登记的项目会被忽略,不会自动创建资产。
    """

    name: str = Field(max_length=255)
    project: str = Field(default="", max_length=64)
    image: str | None = Field(default=None, max_length=255)
    state: str | None = Field(default=None, max_length=32)
    health: str | None = Field(default=None, max_length=32)
    exit_code: int | None = None
    started_at: datetime | None = None
    mem_used_mb: int | None = Field(default=None, ge=0)
    mem_limit_mb: int | None = Field(default=None, ge=0)


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
    instances_synced: int = Field(description="已匹配到登记项目的实例数")
    instances_ignored: int = Field(description="因项目未登记而忽略的实例数")


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
    # 容器的启动时间与退出码。「容器」页要算运行时长、要看退出码,
    # 而这两列在 models.Instance 里已经存在,只是此前没往外吐。
    # 注意:采集器目前不上报这两个值,所以它们常常是 None —— 前端必须
    # 把 None 渲染成「—」而不是 0 或 1970 年。
    started_at: datetime | None = None
    exit_code: int | None = None


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
