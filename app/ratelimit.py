"""登录与敏感操作的速率限制。

公网部署下,登录接口会被自动化工具持续尝试。本模块提供基于 Redis 的计数限流,
数据库不可用或未配置 Redis 时降级为进程内内存计数(仍能挡住单机暴力破解)。

设计要点:
  - 按 IP 与按账号**双重限制**:只限 IP 挡不住分布式尝试,只限账号会误伤共用出口 IP。
  - 使用固定窗口计数。实现简单、内存可控,对暴力破解场景足够。
  - Redis 不可用时自动降级,不因限流组件故障导致登录完全不可用(可用性优先)。
"""

import logging
import time
from dataclasses import dataclass

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class RateLimitRule:
    """一条限流规则。"""

    max_attempts: int
    window_seconds: int
    label: str

    @property
    def window_minutes(self) -> int:
        """窗口的分钟数,用于错误提示。"""
        return max(1, self.window_seconds // 60)


# 登录限流规则。阈值参考常见运维系统的实践,兼顾安全与可用。
LOGIN_RULES: dict[str, RateLimitRule] = {
    "ip": RateLimitRule(max_attempts=5, window_seconds=300, label="该 IP"),
    "account": RateLimitRule(max_attempts=10, window_seconds=900, label="该账号"),
}

# 终端二次确认限流。终端是高危入口,阈值更严。
TERMINAL_RULES: dict[str, RateLimitRule] = {
    "ip": RateLimitRule(max_attempts=3, window_seconds=600, label="该 IP"),
    "account": RateLimitRule(max_attempts=5, window_seconds=900, label="该账号"),
}

_KEY_PREFIX = "opsdeck:ratelimit"


class _MemoryStore:
    """进程内降级存储。多进程部署时各自计数,但仍能挡住单进程的暴力破解。"""

    def __init__(self) -> None:
        self._data: dict[str, tuple[int, float]] = {}

    def incr(self, key: str, window: int) -> int:
        """递增计数,返回当前值。窗口过期后重新计数。"""
        now = time.time()
        count, expires_at = self._data.get(key, (0, now + window))

        if now >= expires_at:
            count, expires_at = 0, now + window

        count += 1
        self._data[key] = (count, expires_at)

        # 顺手清理过期项,避免字典无限增长
        if len(self._data) > 10000:
            self._data = {k: v for k, v in self._data.items() if v[1] > now}

        return count

    def reset(self, key: str) -> None:
        """清除计数(登录成功后调用)。"""
        self._data.pop(key, None)

    def ttl(self, key: str) -> int:
        """剩余锁定秒数。"""
        entry = self._data.get(key)
        if entry is None:
            return 0
        return max(0, int(entry[1] - time.time()))

    def remaining(self, key: str, max_attempts: int) -> int:
        """剩余可尝试次数。已过期则返回完整额度。"""
        entry = self._data.get(key)
        if entry is None or time.time() >= entry[1]:
            return max_attempts
        return max(0, max_attempts - entry[0])


_memory = _MemoryStore()


def _redis_client():
    """获取 Redis 客户端。未配置或连接失败时返回 None。"""
    from app.config import settings

    if not settings.rate_limit_use_redis:
        return None

    try:
        import redis

        client = redis.Redis.from_url(settings.redis_url, socket_connect_timeout=1, socket_timeout=1)
        client.ping()
        return client
    except Exception:
        logger.warning("Redis 不可用,限流降级为进程内计数", exc_info=False)
        return None


def _incr(key: str, window: int) -> int:
    """递增计数。优先 Redis,失败则降级内存。"""
    client = _redis_client()
    if client is not None:
        try:
            pipe = client.pipeline()
            pipe.incr(key)
            pipe.expire(key, window)
            return int(pipe.execute()[0])
        except Exception:
            logger.warning("Redis 限流操作失败,本次降级为内存计数", exc_info=False)

    return _memory.incr(key, window)


def _reset(key: str) -> None:
    """清除计数。"""
    client = _redis_client()
    if client is not None:
        try:
            client.delete(key)
            return
        except Exception:
            pass
    _memory.reset(key)


class RateLimitExceeded(Exception):
    """触发限流。"""

    def __init__(self, label: str, rule: RateLimitRule) -> None:
        self.label = label
        self.rule = rule
        minutes = rule.window_minutes
        super().__init__(f"{label}尝试次数过多(超过 {rule.max_attempts} 次 / {minutes} 分钟),请 {minutes} 分钟后再试")


def check_and_record(
    scope: str,
    *,
    ip: str | None,
    account: str | None,
    rules: dict[str, RateLimitRule] | None = None,
) -> None:
    """记录一次尝试,并在超出阈值时抛出 RateLimitExceeded。

    在**尝试之前**调用:无论成功失败都计数,避免攻击者用成功请求重置计数。
    登录成功后可调用 `reset_after_success` 清除该账号的计数。
    """
    active_rules = rules or LOGIN_RULES

    if ip:
        rule = active_rules["ip"]
        key = f"{_KEY_PREFIX}:{scope}:ip:{ip}"
        if _incr(key, rule.window_seconds) > rule.max_attempts:
            raise RateLimitExceeded(rule.label, rule)

    if account:
        rule = active_rules["account"]
        key = f"{_KEY_PREFIX}:{scope}:account:{account.lower()}"
        if _incr(key, rule.window_seconds) > rule.max_attempts:
            raise RateLimitExceeded(rule.label, rule)


def reset_after_success(scope: str, *, account: str | None) -> None:
    """登录成功后清除该账号的失败计数。

    仅清账号维度:IP 维度保留,防止同一 IP 换账号继续爆破。
    """
    if account:
        _reset(f"{_KEY_PREFIX}:{scope}:account:{account.lower()}")


def remaining_attempts(
    scope: str,
    *,
    ip: str | None = None,
    account: str | None = None,
    rules: dict[str, RateLimitRule] | None = None,
) -> int:
    """返回剩余可尝试次数(只读,不递增计数),用于界面提示。

    降级存储下可精确读取;Redis 模式下为避免额外往返,返回规则上限。
    """
    active_rules = rules or LOGIN_RULES
    candidates: list[int] = []

    if ip:
        rule = active_rules["ip"]
        left = _memory.remaining(f"{_KEY_PREFIX}:{scope}:ip:{ip}", rule.max_attempts)
        candidates.append(left)

    if account:
        rule = active_rules["account"]
        left = _memory.remaining(f"{_KEY_PREFIX}:{scope}:account:{account.lower()}", rule.max_attempts)
        candidates.append(left)

    return min(candidates) if candidates else 0
