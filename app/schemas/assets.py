"""服务器与项目的 Pydantic 契约。"""

import uuid
from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

# ---------------------------------------------------------------- 服务器


class ServerBase(BaseModel):
    """服务器的可写字段。"""

    name: str = Field(max_length=64, description="服务器显示名,唯一")
    hostname: str | None = Field(default=None, max_length=255)
    ip: str | None = Field(default=None, max_length=64)
    ssh_port: int = Field(default=22, ge=1, le=65535)
    ssh_user: str = Field(
        default="root",
        max_length=64,
        pattern=r"^[A-Za-z0-9._-]+$",
        description="SSH 登录用户名。默认 root;只允许 ubuntu 登录的镜像需改成 ubuntu。",
    )
    ssh_key_path: str | None = Field(
        default=None,
        max_length=512,
        description="SSH 私钥路径。留空使用标准密钥;专用密钥必须显式指定。",
    )
    os_info: str | None = Field(default=None, max_length=255)
    cpu_cores: int | None = Field(default=None, ge=1)
    mem_total_mb: int | None = Field(default=None, ge=1)
    note: str | None = None
    terminal_enabled: bool = Field(
        default=False,
        description="是否允许通过 Web 终端登录该服务器。默认关闭,需逐台显式开启。",
    )


class ServerCreate(ServerBase):
    """新增服务器。"""


class ServerUpdate(BaseModel):
    """更新服务器,所有字段可选。"""

    name: str | None = Field(default=None, max_length=64)
    hostname: str | None = Field(default=None, max_length=255)
    ip: str | None = Field(default=None, max_length=64)
    ssh_port: int | None = Field(default=None, ge=1, le=65535)
    ssh_user: str | None = Field(default=None, max_length=64, pattern=r"^[A-Za-z0-9._-]+$")
    ssh_key_path: str | None = Field(default=None, max_length=512)
    os_info: str | None = Field(default=None, max_length=255)
    cpu_cores: int | None = Field(default=None, ge=1)
    mem_total_mb: int | None = Field(default=None, ge=1)
    note: str | None = None
    terminal_enabled: bool | None = Field(default=None, description="开启或关闭该服务器的终端访问")


class ServerRead(ServerBase):
    """服务器读取模型。"""

    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    status: Literal["online", "offline", "unknown"]
    last_seen_at: datetime | None
    created_at: datetime
    updated_at: datetime


class ServerWithProjects(ServerRead):
    """服务器详情,附带项目列表。"""

    projects: list["ProjectRead"] = []


class ServerTokenRead(BaseModel):
    """采集器凭证。单独返回,避免出现在列表接口里。"""

    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    agent_token: str


# ---------------------------------------------------------------- 项目

ProjectKind = Literal["docker-compose", "docker", "systemd", "binary"]


class ProjectBase(BaseModel):
    """项目的可写字段。"""

    name: str = Field(max_length=64, description="项目名,同一服务器内唯一")
    kind: ProjectKind = "docker-compose"
    work_dir: str | None = Field(default=None, max_length=512, description="工作目录,如 /opt/dify/docker")
    compose_file: str | None = Field(default=None, max_length=255)
    ports: list[dict[str, Any]] | None = Field(default=None, description='如 [{"host":8090,"container":80}]')
    url: str | None = Field(default=None, max_length=512)
    restart_cmd: str | None = Field(default=None, description="重启命令,仅展示与人工执行")
    upgrade_cmd: str | None = Field(default=None, description="升级命令,仅展示;MVP 阶段不自动执行")
    depends_on: list[str] | None = None
    tags: list[str] | None = None
    note: str | None = None


class ProjectCreate(ProjectBase):
    """新增项目。"""

    server_id: uuid.UUID


class ProjectUpdate(BaseModel):
    """更新项目,所有字段可选。"""

    name: str | None = Field(default=None, max_length=64)
    kind: ProjectKind | None = None
    work_dir: str | None = Field(default=None, max_length=512)
    compose_file: str | None = Field(default=None, max_length=255)
    ports: list[dict[str, Any]] | None = None
    url: str | None = Field(default=None, max_length=512)
    restart_cmd: str | None = None
    upgrade_cmd: str | None = None
    depends_on: list[str] | None = None
    tags: list[str] | None = None
    note: str | None = None


class ProjectRead(ProjectBase):
    """项目读取模型。

    卡片摘要字段是列表接口临时计算的,不落库:
    历史部署记录与更新配置分别来自 action_logs / project_update_configs。
    """

    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    server_id: uuid.UUID
    server_name: str | None = None
    last_deploy_at: datetime | None = None
    last_deploy_status: str | None = None
    last_deploy_username: str | None = None
    update_source: str | None = None
    update_status: str | None = None
    update_branch: str | None = None
    created_at: datetime
    updated_at: datetime


ServerWithProjects.model_rebuild()
