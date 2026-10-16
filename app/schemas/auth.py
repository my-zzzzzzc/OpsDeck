"""认证与用户的 Pydantic 契约。"""

import uuid
from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

Role = Literal["admin", "operator", "viewer"]

# 密码策略:至少 8 位,且同时包含字母与数字
MIN_PASSWORD_LENGTH = 8


class LoginPayload(BaseModel):
    """登录请求。"""

    username: str = Field(max_length=64)
    password: str = Field(max_length=128)


class UserRead(BaseModel):
    """用户读取模型。绝不含密码字段。"""

    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    username: str
    email: str | None
    display_name: str | None
    role: Role
    is_active: bool
    last_login_at: datetime | None
    created_at: datetime


class LoginResult(BaseModel):
    """登录成功返回。"""

    access_token: str
    token_type: str = "bearer"
    expires_in: int = Field(description="令牌有效期(秒)")
    user: UserRead


class UserCreate(BaseModel):
    """新建用户。"""

    username: str = Field(min_length=3, max_length=64, description="登录名,3-64 字符")
    password: str = Field(min_length=MIN_PASSWORD_LENGTH, max_length=128)
    email: str | None = Field(default=None, max_length=255)
    display_name: str | None = Field(default=None, max_length=64)
    role: Role = "viewer"

    @field_validator("password")
    @classmethod
    def password_strength(cls, v: str) -> str:
        """要求密码同时含字母与数字,避免纯数字弱口令。"""
        if not any(c.isalpha() for c in v) or not any(c.isdigit() for c in v):
            raise ValueError("密码需同时包含字母和数字")
        return v


class UserUpdate(BaseModel):
    """更新用户,所有字段可选。"""

    password: str | None = Field(default=None, min_length=MIN_PASSWORD_LENGTH, max_length=128)
    email: str | None = Field(default=None, max_length=255)
    display_name: str | None = Field(default=None, max_length=64)
    role: Role | None = None
    is_active: bool | None = None

    @field_validator("password")
    @classmethod
    def password_strength(cls, v: str | None) -> str | None:
        """重置密码时同样校验强度。"""
        if v is None:
            return v
        if not any(c.isalpha() for c in v) or not any(c.isdigit() for c in v):
            raise ValueError("密码需同时包含字母和数字")
        return v


class PasswordChangePayload(BaseModel):
    """用户修改自己的密码。"""

    old_password: str = Field(max_length=128)
    new_password: str = Field(min_length=MIN_PASSWORD_LENGTH, max_length=128)

    @field_validator("new_password")
    @classmethod
    def password_strength(cls, v: str) -> str:
        """新密码强度校验。"""
        if not any(c.isalpha() for c in v) or not any(c.isdigit() for c in v):
            raise ValueError("密码需同时包含字母和数字")
        return v


class AuditLogRead(BaseModel):
    """审计记录读取模型。"""

    model_config = ConfigDict(from_attributes=True)

    id: int
    user_id: uuid.UUID | None
    username: str | None
    action: str
    target_type: str | None
    target_id: str | None
    target_name: str | None
    detail: str | None
    ip: str | None
    success: bool
    created_at: datetime
