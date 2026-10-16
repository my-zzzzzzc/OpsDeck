"""Web 终端的 Pydantic 契约。"""

import uuid
from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field


class TerminalAuthorizePayload(BaseModel):
    """打开终端的请求。

    不需要密码 —— 打开终端只依赖登录态与服务器授权。
    保留这个模型是为了后续可能加入的额外参数(如指定初始命令)。
    """

    model_config = ConfigDict(extra="ignore")


class TerminalAuthorizeResult(BaseModel):
    """二次确认成功后返回的一次性凭据。"""

    ticket: str = Field(description="短期有效的一次性终端凭据")
    expires_in: int = Field(description="凭据有效期(秒)")
    server_name: str


class TerminalStatusRead(BaseModel):
    """当前用户的终端可用性。"""

    available: bool
    reason: str | None = None
    # 保留字段以便前端兼容;现在不再要求终端密码,恒为 true
    has_password: bool = Field(default=True, description="已废弃:不再要求终端密码")


class TerminalSessionRead(BaseModel):
    """终端会话记录。"""

    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    server_id: uuid.UUID | None
    server_name: str | None
    user_id: uuid.UUID | None
    username: str | None
    status: str
    close_reason: str | None
    client_ip: str | None
    recording_path: str | None
    bytes_in: int
    bytes_out: int
    started_at: datetime
    ended_at: datetime | None
