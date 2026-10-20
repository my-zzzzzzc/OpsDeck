"""部署的 Pydantic 契约。

前端只提交部署参数,不提交命令;命令由 app.deploy 按来源构造。
"""

import uuid

from pydantic import BaseModel, Field

from app.deploy import DeploySource
from app.schemas.assets import ProjectRead
from app.schemas.updates import UpdateConfigRead


class DeployPreflightRequest(BaseModel):
    """部署前检查。只需描述要部署到哪里。"""

    server_id: uuid.UUID
    name: str = Field(min_length=1, max_length=64, description="登记后的项目名")
    source: DeploySource = Field(default="existing", description="existing(接管已有目录)/ git(克隆新建)")
    work_dir: str = Field(min_length=1, max_length=512, description="目标机上的绝对路径")
    compose_file: str | None = Field(default=None, max_length=255, description="相对工作目录的 Compose 文件")
    repo_url: str | None = Field(default=None, max_length=512, description="Git 来源的仓库地址")
    branch: str | None = Field(default=None, max_length=128, description="Git 来源的分支;留空使用默认分支")


class DeployRequest(DeployPreflightRequest):
    """执行部署。必须显式确认。"""

    url: str | None = Field(default=None, max_length=512, description="部署后的访问地址,仅登记")
    note: str | None = Field(default=None, description="备注")
    confirm: bool = Field(default=False, description="必须为 true")


class DeployCheck(BaseModel):
    """一项预检结果。"""

    key: str
    label: str
    ok: bool
    detail: str


class DeployPreflightRead(BaseModel):
    """预检结果。ok 为 true 时才允许执行部署。"""

    ok: bool
    checks: list[DeployCheck]
    command: str
    work_dir: str


class DeployResultRead(BaseModel):
    """一次部署动作的结果。

    project 为 null 表示命令执行成功但项目未登记(例如同名项目刚好被创建),
    此时 message 会说明原因,但容器已经在运行。
    """

    ok: bool
    message: str
    command: str
    output: str | None = None
    project: ProjectRead | None = None
    config: UpdateConfigRead | None = None
