"""认证与授权核心。

包含:
  - 密码哈希与校验(bcrypt)
  - JWT 签发与解析
  - 角色 → 权限映射
  - FastAPI 依赖:当前用户、角色校验、权限校验

安全约定:
  - 密码永不出现在响应、日志或审计明细中。
  - 登录失败只返回统一错误信息,不泄露用户是否存在。
"""

import uuid
from collections.abc import Callable
from datetime import UTC, datetime, timedelta
from typing import Annotated, Literal

import bcrypt
from fastapi import Depends, HTTPException, Request, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from jose import JWTError, jwt
from sqlalchemy.orm import Session

from app.config import settings
from app.db import get_db
from app.models import User

# ---------------------------------------------------------------- 密码

# bcrypt 只处理前 72 字节,超出部分被静默忽略。这里显式拒绝,
# 避免出现"密码后半段实际未生效"的隐患。
MAX_PASSWORD_BYTES = 72


def hash_password(plain: str) -> str:
    """生成 bcrypt 密码哈希。

    直接使用 bcrypt 库而非 passlib:passlib 已停止维护,且与 bcrypt 4.x+
    存在版本探测不兼容问题。
    """
    raw = plain.encode("utf-8")
    if len(raw) > MAX_PASSWORD_BYTES:
        raise ValueError(f"密码过长(超过 {MAX_PASSWORD_BYTES} 字节)")
    return bcrypt.hashpw(raw, bcrypt.gensalt()).decode("utf-8")


def verify_password(plain: str, hashed: str) -> bool:
    """校验明文密码与哈希是否匹配。任何异常都视为不匹配。"""
    try:
        return bcrypt.checkpw(plain.encode("utf-8"), hashed.encode("utf-8"))
    except (ValueError, TypeError):
        return False


# ---------------------------------------------------------------- JWT

ALGORITHM = "HS256"


def create_access_token(user: User) -> tuple[str, int]:
    """签发访问令牌,返回 (token, 有效期秒数)。"""
    expires_in = settings.access_token_expire_minutes * 60
    expire = datetime.now(UTC) + timedelta(seconds=expires_in)

    payload = {
        "sub": str(user.id),
        "username": user.username,
        "role": user.role,
        "exp": expire,
        "iat": datetime.now(UTC),
    }
    return jwt.encode(payload, settings.secret_key, algorithm=ALGORITHM), expires_in


def decode_access_token(token: str) -> dict | None:
    """解析令牌,无效或过期返回 None。"""
    try:
        return jwt.decode(token, settings.secret_key, algorithms=[ALGORITHM])
    except JWTError:
        return None


# ---------------------------------------------------------------- 角色与权限

Role = Literal["admin", "operator", "viewer"]

# 权限点。端点通过 require(...) 声明所需权限。
#   view      —— 查看资产、指标、事件
#   operate   —— 执行运维操作(重启服务等)
#   manage    —— 管理资产(增删改服务器与项目)
#   users     —— 管理用户
PERMISSIONS: dict[str, set[str]] = {
    "viewer": {"view"},
    "operator": {"view", "operate"},
    "admin": {"view", "operate", "manage", "users"},
}


def role_has_permission(role: str, permission: str) -> bool:
    """判断角色是否具备某权限。未知角色一律无权限。"""
    return permission in PERMISSIONS.get(role, set())


# ---------------------------------------------------------------- 依赖

# auto_error=False:自行返回统一的中文错误,而非 FastAPI 默认的 403
_bearer = HTTPBearer(auto_error=False)


def get_current_user(
    credentials: Annotated[HTTPAuthorizationCredentials | None, Depends(_bearer)],
    db: Session = Depends(get_db),
) -> User:
    """解析 Bearer 令牌并返回当前用户。"""
    if credentials is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="未提供认证凭据",
            headers={"WWW-Authenticate": "Bearer"},
        )

    payload = decode_access_token(credentials.credentials)
    if payload is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="凭据无效或已过期",
            headers={"WWW-Authenticate": "Bearer"},
        )

    try:
        user_id = uuid.UUID(payload["sub"])
    except (KeyError, ValueError):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="凭据无效") from None

    user = db.get(User, user_id)
    if user is None:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="用户不存在")

    # 令牌签发后被停用的用户应立即失效
    if not user.is_active:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="账户已被停用")

    return user


CurrentUser = Annotated[User, Depends(get_current_user)]


def require(permission: str) -> Callable[[User], User]:
    """构造一个校验指定权限的依赖。"""

    def dependency(user: CurrentUser) -> User:
        if not role_has_permission(user.role, permission):
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail=f"需要 {permission} 权限,当前角色 {user.role} 无权执行",
            )
        return user

    return dependency


def client_ip(request: Request) -> str | None:
    """从请求中提取客户端 IP,优先使用反向代理透传的头。"""
    forwarded = request.headers.get("x-forwarded-for")
    if forwarded:
        return forwarded.split(",")[0].strip()
    return request.client.host if request.client else None
