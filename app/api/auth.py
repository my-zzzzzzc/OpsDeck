"""认证与用户管理接口。"""

import uuid

from fastapi import APIRouter, Depends, HTTPException, Request, status
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.audit import record_audit
from app.auth import (
    PERMISSIONS,
    CurrentUser,
    client_ip,
    create_access_token,
    hash_password,
    require,
    verify_password,
)
from app.db import get_db
from app.models import User
from app.ratelimit import RateLimitExceeded, check_and_record, reset_after_success
from app.schemas.auth import (
    LoginPayload,
    LoginResult,
    PasswordChangePayload,
    UserCreate,
    UserRead,
    UserUpdate,
)

router = APIRouter(tags=["auth"])


@router.post("/auth/login", response_model=LoginResult, summary="登录")
def login(payload: LoginPayload, request: Request, db: Session = Depends(get_db)) -> LoginResult:
    """校验用户名与密码,返回访问令牌。

    公网部署下此接口会被持续尝试,因此在凭据校验之前先做 IP 与账号双重限流。
    """
    ip = client_ip(request)

    # 先限流:无论凭据对错都计数,避免攻击者用成功请求绕过
    try:
        check_and_record("login", ip=ip, account=payload.username)
    except RateLimitExceeded as exc:
        record_audit(
            db,
            action="login_failed",
            target_type="auth",
            target_name=payload.username,
            ip=ip,
            success=False,
            detail=f"触发限流: {exc}",
            commit=True,
        )
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail=str(exc),
            headers={"Retry-After": str(exc.rule.window_seconds)},
        ) from None

    user = db.scalar(select(User).where(User.username == payload.username))

    # 统一错误信息,不区分"用户不存在"与"密码错误",避免账号枚举
    if user is None or not verify_password(payload.password, user.password_hash):
        record_audit(
            db,
            action="login_failed",
            target_type="auth",
            target_name=payload.username,
            ip=ip,
            success=False,
            detail="用户名或密码错误",
            commit=True,
        )
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="用户名或密码错误")

    if not user.is_active:
        record_audit(
            db,
            user_id=user.id,
            username=user.username,
            action="login_failed",
            target_type="auth",
            target_name=user.username,
            ip=ip,
            success=False,
            detail="账户已停用",
            commit=True,
        )
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="账户已被停用")

    # 登录成功:清除该账号维度的计数(IP 维度保留,防止换账号继续爆破)
    reset_after_success("login", account=user.username)

    token, expires_in = create_access_token(user)

    user.last_login_at = func.now()
    user.last_login_ip = ip
    record_audit(
        db,
        user_id=user.id,
        username=user.username,
        action="login",
        target_type="auth",
        target_name=user.username,
        ip=ip,
    )
    db.commit()
    db.refresh(user)

    return LoginResult(access_token=token, expires_in=expires_in, user=UserRead.model_validate(user))


@router.get("/auth/me", response_model=UserRead, summary="当前登录用户")
def me(user: CurrentUser) -> User:
    """返回当前令牌对应的用户信息,前端用于恢复登录态。"""
    return user


@router.post("/auth/change-password", summary="修改自己的密码")
def change_password(
    payload: PasswordChangePayload,
    request: Request,
    user: CurrentUser,
    db: Session = Depends(get_db),
) -> dict[str, str]:
    """修改当前用户密码,需提供原密码。"""
    if not verify_password(payload.old_password, user.password_hash):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="原密码不正确")

    user.password_hash = hash_password(payload.new_password)
    record_audit(
        db,
        user_id=user.id,
        username=user.username,
        action="update",
        target_type="user",
        target_id=str(user.id),
        target_name=user.username,
        ip=client_ip(request),
        detail="修改密码",
    )
    db.commit()
    return {"message": "密码已更新"}


# ---------------------------------------------------------------- 用户管理(仅 admin)


@router.get("/users", response_model=list[UserRead], summary="用户列表")
def list_users(db: Session = Depends(get_db), _: User = Depends(require("users"))) -> list[User]:
    """返回全部用户。"""
    return list(db.scalars(select(User).order_by(User.created_at)))


@router.post("/users", response_model=UserRead, status_code=status.HTTP_201_CREATED, summary="新建用户")
def create_user(
    payload: UserCreate,
    request: Request,
    db: Session = Depends(get_db),
    actor: User = Depends(require("users")),
) -> User:
    """新建用户。用户名与邮箱需唯一。"""
    if db.scalar(select(User).where(User.username == payload.username)) is not None:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=f"用户名已存在: {payload.username}")

    if payload.email and db.scalar(select(User).where(User.email == payload.email)) is not None:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=f"邮箱已被使用: {payload.email}")

    user = User(
        username=payload.username,
        email=payload.email,
        display_name=payload.display_name,
        role=payload.role,
        password_hash=hash_password(payload.password),
        created_by=actor.id,
    )
    db.add(user)
    db.flush()

    record_audit(
        db,
        user_id=actor.id,
        username=actor.username,
        action="create",
        target_type="user",
        target_id=str(user.id),
        target_name=user.username,
        ip=client_ip(request),
        detail=f"新建用户,角色 {user.role}",
    )
    db.commit()
    db.refresh(user)
    return user


@router.patch("/users/{user_id}", response_model=UserRead, summary="更新用户")
def update_user(
    user_id: uuid.UUID,
    payload: UserUpdate,
    request: Request,
    db: Session = Depends(get_db),
    actor: User = Depends(require("users")),
) -> User:
    """更新用户资料或角色。不能停用或降级自己,避免把管理权限锁死。"""
    user = db.get(User, user_id)
    if user is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="用户不存在")

    changes = payload.model_dump(exclude_unset=True)

    # 保护:不允许通过自我降级/停用让系统失去管理员
    if user.id == actor.id:
        if changes.get("role") and changes["role"] != actor.role:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="不能修改自己的角色")
        if changes.get("is_active") is False:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="不能停用自己")

    # 保护:不允许移除最后一个管理员
    if user.role == "admin" and (changes.get("role") not in (None, "admin") or changes.get("is_active") is False):
        admin_count = db.scalar(select(func.count()).select_from(User).where(User.role == "admin", User.is_active)) or 0
        if admin_count <= 1:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="系统必须保留至少一个管理员")

    if payload.password:
        user.password_hash = hash_password(payload.password)

    for field in ("email", "display_name", "role", "is_active"):
        if field in changes:
            setattr(user, field, changes[field])

    record_audit(
        db,
        user_id=actor.id,
        username=actor.username,
        action="update",
        target_type="user",
        target_id=str(user.id),
        target_name=user.username,
        ip=client_ip(request),
        detail=f"更新字段: {', '.join(changes.keys())}",
    )
    db.commit()
    db.refresh(user)
    return user


@router.delete("/users/{user_id}", status_code=status.HTTP_204_NO_CONTENT, summary="删除用户")
def delete_user(
    user_id: uuid.UUID,
    request: Request,
    db: Session = Depends(get_db),
    actor: User = Depends(require("users")),
) -> None:
    """删除用户。不能删除自己,也不能删除最后一个管理员。"""
    user = db.get(User, user_id)
    if user is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="用户不存在")

    if user.id == actor.id:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="不能删除自己")

    if user.role == "admin":
        admin_count = db.scalar(select(func.count()).select_from(User).where(User.role == "admin", User.is_active)) or 0
        if admin_count <= 1:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="系统必须保留至少一个管理员")

    record_audit(
        db,
        user_id=actor.id,
        username=actor.username,
        action="delete",
        target_type="user",
        target_id=str(user.id),
        target_name=user.username,
        ip=client_ip(request),
    )
    db.delete(user)
    db.commit()


@router.get("/auth/permissions", summary="当前用户的权限点")
def my_permissions(user: CurrentUser) -> dict[str, object]:
    """返回当前用户的角色与权限点,前端据此控制按钮可见性。"""
    return {"role": user.role, "permissions": sorted(PERMISSIONS.get(user.role, set()))}
