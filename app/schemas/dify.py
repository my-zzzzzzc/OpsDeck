"""Dify 接入与对话的 Pydantic 契约。"""

import uuid
from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

DifyMode = Literal["chat", "agent", "completion", "workflow"]


class DifyAppCreate(BaseModel):
    """登记一个 Dify 应用。"""

    name: str = Field(max_length=64, description="显示名,如「运维助手」")
    api_key: str = Field(min_length=8, max_length=255, description="Dify 应用的 API Key(app-xxx)")
    mode: DifyMode = "chat"
    description: str | None = None
    is_default: bool = False


class DifyAppUpdate(BaseModel):
    """更新 Dify 应用。api_key 留空表示不修改。"""

    name: str | None = Field(default=None, max_length=64)
    api_key: str | None = Field(default=None, min_length=8, max_length=255)
    mode: DifyMode | None = None
    description: str | None = None
    is_default: bool | None = None
    is_active: bool | None = None


class DifyAppRead(BaseModel):
    """Dify 应用读取模型。

    注意:只返回掩码后的 Key,明文永不出现在响应中。
    """

    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    name: str
    mode: DifyMode
    description: str | None
    is_default: bool
    is_active: bool
    created_at: datetime


class DifyAppWithKey(DifyAppRead):
    """带掩码 Key 的视图,供管理界面展示。"""

    api_key_masked: str = Field(description="形如 app-xxxx****yyyy")


class ChatRequest(BaseModel):
    """发起一次对话。"""

    app_id: uuid.UUID | None = Field(default=None, description="留空则使用默认应用")
    query: str = Field(min_length=1, max_length=8000)
    conversation_id: str = Field(default="", max_length=64, description="Dify 会话 ID,多轮对话需回传")
    inputs: dict[str, Any] = Field(default_factory=dict, description="Dify 应用定义的变量")


class ChatConversationRead(BaseModel):
    """本地记录的会话。"""

    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    dify_conversation_id: str | None
    dify_app_id: uuid.UUID | None
    title: str | None
    created_at: datetime
    updated_at: datetime


class DifyHealthResult(BaseModel):
    """Dify 连通性探测结果。"""

    ok: bool
    message: str
