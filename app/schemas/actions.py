"""白名单操作的 Pydantic 契约。"""

import uuid
from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field


class ActionCatalogItem(BaseModel):
    """一个可执行操作的描述。"""

    key: str
    label: str
    danger: str = Field(description="none / low / medium / high")
    confirm_required: bool
    read_only: bool
    enabled: bool
    description: str


class ActionExecutePayload(BaseModel):
    """执行操作的请求。

    只接受操作名与项目 ID —— 不接受命令字符串,命令由后端白名单模板构造。
    """

    project_id: uuid.UUID
    action: str = Field(max_length=64, description="操作名,取自 /actions/catalog")
    confirm: bool = Field(default=False, description="需要确认的操作必须传 true")
    triggered_by: str = Field(
        default="manual",
        max_length=16,
        description="触发来源:manual(界面按钮) 或 dify(AI 建议后人工确认)",
    )


class ContainerActionPayload(BaseModel):
    """单容器操作请求。只接受动作名,容器由 URL 指定。"""

    action: str = Field(max_length=32, description="container_restart / container_stop / container_start")
    confirm: bool = Field(default=False, description="需要确认的操作必须传 true")


class ActionLogRead(BaseModel):
    """操作记录读取模型。"""

    model_config = ConfigDict(from_attributes=True)

    id: int
    project_id: uuid.UUID | None
    project_name: str | None
    action: str
    command: str | None
    status: str
    output: str | None
    exit_code: int | None
    triggered_by: str
    username: str | None
    created_at: datetime
    finished_at: datetime | None
