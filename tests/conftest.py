"""测试配置。

使用独立的 SQLite 会话级数据库,避免污染开发库。
单元测试聚焦纯逻辑(权限、白名单、命令构造),不依赖外部服务。
"""

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy.pool import StaticPool

from app.db import Base

# 事件与审计依赖 PostgreSQL 的 JSONB/UUID,这里复用同一 Base;
# 纯逻辑测试不建表,需要建表的用例通过 test_db fixture 获得会话。


@pytest.fixture
def test_db() -> Session:
    """提供一个独立的内存数据库会话。"""
    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    # 只创建不依赖 PostgreSQL 专属类型的表
    Base.metadata.create_all(engine, tables=[])
    factory = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)
    db = factory()
    try:
        yield db
    finally:
        db.close()
        engine.dispose()
