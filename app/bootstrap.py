"""首次启动引导。

当用户表为空时创建初始管理员,避免加认证后把自己锁在门外。
密码从 `INITIAL_ADMIN_PASSWORD` 读取;未设置时生成随机密码并打印一次。
"""

import logging
import secrets

from sqlalchemy import func, select

from app.auth import hash_password
from app.config import settings
from app.db import SessionLocal
from app.models import User

logger = logging.getLogger(__name__)


def ensure_initial_admin() -> None:
    """若系统中没有任何用户,创建一个管理员账号。"""
    db = SessionLocal()
    try:
        user_count = db.scalar(select(func.count()).select_from(User)) or 0
        if user_count > 0:
            return

        password = settings.initial_admin_password
        generated = False
        if not password:
            password = secrets.token_urlsafe(12)
            generated = True

        admin = User(
            username=settings.initial_admin_username,
            display_name="初始管理员",
            role="admin",
            password_hash=hash_password(password),
            is_active=True,
        )
        db.add(admin)
        db.commit()

        if generated:
            # 只在终端打印一次,不写日志文件
            print(
                "\n"
                "=" * 62 + "\n"
                "  OpsDeck 已创建初始管理员\n"
                f"    用户名: {admin.username}\n"
                f"    密码:   {password}\n"
                "  请立即登录并修改密码;此密码仅显示这一次。\n"
                "  如需固定密码,设置环境变量 INITIAL_ADMIN_PASSWORD。\n" + "=" * 62 + "\n",
                flush=True,
            )
        else:
            logger.info("已创建初始管理员: %s", admin.username)

    except Exception:
        logger.exception("创建初始管理员失败")
    finally:
        db.close()
