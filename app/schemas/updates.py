"""项目更新的 Pydantic 契约。"""

import uuid
from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

UpdateSource = Literal["git", "registry", "release", "manual"]
UpdateStatus = Literal["unknown", "up_to_date", "update_available", "check_failed", "manual"]


class UpdateConfigPayload(BaseModel):
    """保存一个项目的更新来源。

    只接受来源参数,不接受命令。真正执行什么由后端按来源类型构造。
    """

    source_type: UpdateSource = Field(description="git(提交) / release(版本) / registry(镜像 digest) / manual")
    repo_url: str | None = Field(default=None, max_length=512, description="Git 远端地址,仅展示与记录")
    branch: str | None = Field(default=None, max_length=128, description="Git 分支;留空使用服务器当前分支")
    image_ref: str | None = Field(default=None, max_length=255, description="registry 来源的完整镜像引用")
    upstream_repo: str | None = Field(default=None, max_length=255, description="GitHub owner/repo,用于 Release 检测")
    current_version: str | None = Field(
        default=None,
        max_length=128,
        description="人工指定的当前版本;留空时由检测从部署镜像或 Git 提交推断",
    )


class UpdateConfigRead(BaseModel):
    """更新配置与最近一次检测结果。"""

    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    project_id: uuid.UUID
    source_type: UpdateSource
    confirmed: bool
    auto_detected: bool
    repo_url: str | None
    branch: str | None
    image_ref: str | None
    upstream_repo: str | None
    current_version: str | None
    latest_version: str | None
    status: UpdateStatus
    detail: str | None
    release_url: str | None
    extra: dict[str, Any] | None
    last_checked_at: datetime | None
    last_success_at: datetime | None


class UpdateProjectRead(BaseModel):
    """更新页的一行:项目 + 所属服务器 + 已采集镜像 + 更新配置。"""

    project_id: uuid.UUID
    project_name: str
    server_id: uuid.UUID
    server_name: str | None
    kind: str
    work_dir: str | None
    images: list[str]
    config: UpdateConfigRead | None


class UpdateSuggestion(BaseModel):
    """自动识别出的更新来源建议。必须在界面上由人确认后才保存。"""

    source_type: UpdateSource
    repo_url: str | None = None
    branch: str | None = None
    image_ref: str | None = None
    upstream_repo: str | None = None
    current_version: str | None = None
    reason: str
    images: list[str] = []


class UpdateApplyPayload(BaseModel):
    """执行更新。必须显式确认 —— 它会重建容器。"""

    confirm: bool = Field(default=False, description="必须为 true")


class UpdateApplyResult(BaseModel):
    """一次更新动作的结果。"""

    ok: bool
    message: str
    output: str | None = None
    command: str | None = None
    config: UpdateConfigRead | None = None
