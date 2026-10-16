"""Web 终端的安全控制。

本模块集中管理系统中最高的权限入口,包含:
  1. 终端密码的校验与独立锁定(与登录密码分离)
  2. 一次性 ticket 的签发与验证(短期、绑定用户与服务器)
  3. IP 白名单检查
  4. 并发会话限制

设计原则:所有校验都在服务端,任何一项不通过即拒绝;失败全部写审计。
"""

import hmac
import logging
import secrets
import uuid
from datetime import UTC, datetime, timedelta

from jose import JWTError, jwt
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.auth import ALGORITHM, hash_password, verify_password
from app.config import settings
from app.models import Server, TerminalCredential, TerminalSession, User

logger = logging.getLogger(__name__)

# ticket 有效期。只需覆盖"确认密码 → 建立 WebSocket"的时间,给足网络余量。
TICKET_TTL_SECONDS = 60

# 终端密码连续失败后的锁定时长
CREDENTIAL_LOCK_THRESHOLD = 5
CREDENTIAL_LOCK_MINUTES = 30


class TerminalError(Exception):
    """终端相关的业务错误。message 可直接返回给前端。"""

    def __init__(self, message: str, status_code: int = 400) -> None:
        super().__init__(message)
        self.message = message
        self.status_code = status_code


# ---------------------------------------------------------------- 终端密码


def has_terminal_password(db: Session, user: User) -> bool:
    """判断用户是否已设置终端密码。"""
    return db.get(TerminalCredential, user.id) is not None


def set_terminal_password(db: Session, user: User, password: str) -> None:
    """设置或重置终端密码。

    要求与登录密码不同 —— 若相同,二次确认就失去了"两次泄露"的意义。
    """
    if len(password) < 8:
        raise TerminalError("终端密码至少 8 位")

    if not any(c.isalpha() for c in password) or not any(c.isdigit() for c in password):
        raise TerminalError("终端密码需同时包含字母和数字")

    if verify_password(password, user.password_hash):
        raise TerminalError("终端密码不能与登录密码相同")

    credential = db.get(TerminalCredential, user.id)
    if credential is None:
        credential = TerminalCredential(user_id=user.id, password_hash=hash_password(password))
        db.add(credential)
    else:
        credential.password_hash = hash_password(password)

    # 重置密码后解除锁定
    credential.failed_attempts = 0
    credential.locked_until = None
    db.commit()


def verify_terminal_password(db: Session, user: User, password: str) -> None:
    """校验终端密码。失败时累计次数并在超限后锁定。

    任何失败都抛出 TerminalError,调用方负责写审计。
    """
    credential = db.get(TerminalCredential, user.id)
    if credential is None:
        raise TerminalError("尚未设置终端密码,请先在设置中配置", status_code=409)

    now = datetime.now(UTC)

    # 先检查锁定状态,避免锁定期间仍做昂贵的 bcrypt 校验
    if credential.locked_until is not None and credential.locked_until > now:
        remaining = int((credential.locked_until - now).total_seconds() // 60) + 1
        raise TerminalError(f"终端密码错误次数过多,请 {remaining} 分钟后再试", status_code=429)

    if not verify_password(password, credential.password_hash):
        credential.failed_attempts += 1
        if credential.failed_attempts >= CREDENTIAL_LOCK_THRESHOLD:
            credential.locked_until = now + timedelta(minutes=CREDENTIAL_LOCK_MINUTES)
            credential.failed_attempts = 0
            db.commit()
            raise TerminalError(f"终端密码错误次数过多,已锁定 {CREDENTIAL_LOCK_MINUTES} 分钟", status_code=429)

        db.commit()
        left = CREDENTIAL_LOCK_THRESHOLD - credential.failed_attempts
        raise TerminalError(f"终端密码错误,还可尝试 {left} 次", status_code=401)

    # 成功:清零计数
    credential.failed_attempts = 0
    credential.locked_until = None
    db.commit()


# ---------------------------------------------------------------- ticket


def issue_ticket(user: User, server_id: uuid.UUID, client_ip: str | None) -> tuple[str, int]:
    """签发一次性终端 ticket。

    ticket 只证明"该用户刚刚通过了终端密码校验,且被授权连该服务器",
    不延长登录态,也不携带任何权限升级能力。
    """
    payload = {
        "sub": str(user.id),
        "srv": str(server_id),
        "typ": "terminal",
        "ip": client_ip or "",
        # 随机数保证同一用户多次确认得到不同 ticket,便于识别重放
        "jti": secrets.token_urlsafe(8),
        "exp": datetime.now(UTC) + timedelta(seconds=TICKET_TTL_SECONDS),
        "iat": datetime.now(UTC),
    }
    token = jwt.encode(payload, settings.secret_key, algorithm=ALGORITHM)
    return token, TICKET_TTL_SECONDS


def verify_ticket(ticket: str, server_id: uuid.UUID, client_ip: str | None) -> uuid.UUID:
    """验证 ticket,返回用户 ID。任何不匹配都拒绝。"""
    try:
        payload = jwt.decode(ticket, settings.secret_key, algorithms=[ALGORITHM])
    except JWTError:
        raise TerminalError("终端凭据无效或已过期,请重新确认密码", status_code=401) from None

    if payload.get("typ") != "terminal":
        raise TerminalError("凭据类型不正确", status_code=401)

    if payload.get("srv") != str(server_id):
        # ticket 与目标服务器绑定,防止用一个 ticket 连其他机器
        raise TerminalError("凭据与目标服务器不匹配", status_code=403)

    # IP 绑定:开启白名单时严格校验,否则仅记录
    if settings.terminal_ip_allowlist_enabled and payload.get("ip") != (client_ip or ""):
        raise TerminalError("客户端地址与凭据不匹配", status_code=403)

    try:
        return uuid.UUID(payload["sub"])
    except (KeyError, ValueError):
        raise TerminalError("凭据内容不合法", status_code=401) from None


# ---------------------------------------------------------------- 访问控制


def check_ip_allowlist(client_ip: str | None) -> None:
    """检查客户端 IP 是否在白名单内。

    未启用白名单时直接通过 —— 由限流与密码确认承担主要防护。
    """
    if not settings.terminal_ip_allowlist_enabled:
        return

    allowlist = settings.terminal_ip_allowlist_list
    if not allowlist:
        raise TerminalError("已启用 IP 白名单但未配置任何地址,终端不可用", status_code=503)

    if not client_ip:
        raise TerminalError("无法识别客户端地址", status_code=403)

    # 支持精确匹配与简单前缀通配(如 203.0.113.)
    for allowed in allowlist:
        if allowed.endswith("."):
            if client_ip.startswith(allowed):
                return
        elif hmac.compare_digest(client_ip, allowed):
            return

    logger.warning("终端访问被 IP 白名单拒绝: %s", client_ip)
    raise TerminalError("当前 IP 不在终端访问白名单内", status_code=403)


def check_server_terminal_enabled(server: Server) -> None:
    """检查服务器是否已授权开放终端。默认全部关闭。"""
    if not server.terminal_enabled:
        raise TerminalError(f"服务器「{server.name}」未开放终端访问,请先在服务器设置中开启", status_code=403)


def check_concurrency(db: Session, user_id: uuid.UUID) -> None:
    """检查并发会话数是否超限。"""
    active_filter = (TerminalSession.status == "active",)

    user_active = db.scalar(
        select(func.count()).select_from(TerminalSession).where(*active_filter, TerminalSession.user_id == user_id)
    )
    if (user_active or 0) >= settings.terminal_max_per_user:
        raise TerminalError(
            f"你已有 {user_active} 个终端会话,最多同时开启 {settings.terminal_max_per_user} 个",
            status_code=429,
        )

    global_active = db.scalar(select(func.count()).select_from(TerminalSession).where(*active_filter))
    if (global_active or 0) >= settings.terminal_max_global:
        raise TerminalError(f"系统终端会话已达上限({settings.terminal_max_global} 个),请稍后再试", status_code=503)


def close_stale_sessions(db: Session) -> int:
    """清理超时的会话记录。

    进程被强杀时不会执行关闭逻辑,因此需要周期性把陈旧记录标记为结束,
    否则并发计数会被永久占用。
    """
    cutoff = datetime.now(UTC) - timedelta(seconds=settings.terminal_max_duration + 300)

    stale = list(
        db.scalars(
            select(TerminalSession).where(TerminalSession.status == "active", TerminalSession.started_at < cutoff)
        )
    )
    for session in stale:
        session.status = "closed"
        session.close_reason = "stale_cleanup"
        session.ended_at = datetime.now(UTC)

    if stale:
        db.commit()
        logger.info("清理了 %d 个陈旧的终端会话记录", len(stale))

    return len(stale)
