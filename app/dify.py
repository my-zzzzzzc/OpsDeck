"""Dify Service API 客户端与流式对话代理。

设计要点:
  - API Key 只存在于后端,前端永远拿不到(见 `chat.py` 的代理端点)。
  - `stream_chat` 返回异步迭代器,逐块透传 Dify 的 SSE,不缓冲整段响应,
    这样前端能实时看到逐字输出。
  - 上游非 2xx 时抛出 `DifyError`,由调用方翻译成合适的 HTTP 状态。
"""

import json
import logging
from collections.abc import AsyncIterator
from typing import Any

import httpx

from app.config import settings

logger = logging.getLogger(__name__)


class DifyError(Exception):
    """调用 Dify 失败。message 面向调用方,可直接返回给前端。"""

    def __init__(self, message: str, status_code: int | None = None) -> None:
        super().__init__(message)
        self.message = message
        self.status_code = status_code


def _headers(api_key: str) -> dict[str, str]:
    """构造 Dify 请求头。"""
    return {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }


def _url(path: str) -> str:
    """拼接 Dify 端点地址。"""
    base = settings.dify_base_url.rstrip("/")
    return f"{base}/v1{path}"


async def stream_chat(
    *,
    api_key: str,
    query: str,
    user: str,
    inputs: dict[str, Any] | None = None,
    conversation_id: str = "",
) -> AsyncIterator[bytes]:
    """向 Dify 发起流式对话,逐块产出原始 SSE 字节。

    Dify 的 SSE 已经是标准格式(data: {...}\\n\\n),这里原样透传,
    前端按 Dify 的事件协议解析即可,无需中间转换。
    """
    payload = {
        "inputs": inputs or {},
        "query": query,
        "response_mode": "streaming",
        "user": user,
        "conversation_id": conversation_id,
        "auto_generate_name": True,
    }

    try:
        async with (
            httpx.AsyncClient(timeout=settings.dify_timeout_seconds) as client,
            client.stream(
                "POST",
                _url("/chat-messages"),
                headers=_headers(api_key),
                json=payload,
            ) as resp,
        ):
            if resp.status_code != 200:
                body = await resp.aread()
                detail = _extract_error(body)
                logger.warning("Dify 返回 %d: %s", resp.status_code, detail)
                raise DifyError(detail, resp.status_code)

            async for chunk in resp.aiter_bytes():
                yield chunk

    except httpx.TimeoutException as exc:
        raise DifyError("Dify 响应超时,请稍后重试") from exc
    except httpx.HTTPError as exc:
        raise DifyError(f"无法连接 Dify: {exc}") from exc


async def block_chat(
    *,
    api_key: str,
    query: str,
    user: str,
    inputs: dict[str, Any] | None = None,
    conversation_id: str = "",
) -> dict[str, Any]:
    """非流式对话,返回完整结果。用于不需要逐字输出的场景(如工具调用)。"""
    payload = {
        "inputs": inputs or {},
        "query": query,
        "response_mode": "blocking",
        "user": user,
        "conversation_id": conversation_id,
    }

    try:
        async with httpx.AsyncClient(timeout=settings.dify_timeout_seconds) as client:
            resp = await client.post(
                _url("/chat-messages"),
                headers=_headers(api_key),
                json=payload,
            )
            if resp.status_code != 200:
                raise DifyError(_extract_error(resp.content), resp.status_code)
            return resp.json()

    except httpx.TimeoutException as exc:
        raise DifyError("Dify 响应超时,请稍后重试") from exc
    except httpx.HTTPError as exc:
        raise DifyError(f"无法连接 Dify: {exc}") from exc


async def list_conversations(*, api_key: str, user: str, limit: int = 20) -> list[dict[str, Any]]:
    """列出该用户在 Dify 侧的会话。"""
    try:
        async with httpx.AsyncClient(timeout=30) as client:
            resp = await client.get(
                _url("/conversations"),
                headers=_headers(api_key),
                params={"user": user, "limit": limit},
            )
            if resp.status_code != 200:
                raise DifyError(_extract_error(resp.content), resp.status_code)
            return resp.json().get("data", [])
    except httpx.HTTPError as exc:
        raise DifyError(f"无法连接 Dify: {exc}") from exc


async def ping(api_key: str) -> dict[str, Any]:
    """探测应用可用性。用一次最简对话验证 Key 是否有效。"""
    try:
        async with httpx.AsyncClient(timeout=30) as client:
            resp = await client.post(
                _url("/chat-messages"),
                headers=_headers(api_key),
                json={
                    "inputs": {},
                    "query": "ping",
                    "response_mode": "blocking",
                    "user": "opsdeck-healthcheck",
                },
            )
            if resp.status_code == 200:
                return {"ok": True, "message": "连接正常"}
            return {"ok": False, "message": _extract_error(resp.content)}
    except httpx.HTTPError as exc:
        return {"ok": False, "message": f"无法连接 Dify: {exc}"}


def _extract_error(body: bytes) -> str:
    """从 Dify 的错误响应中提取可读信息。"""
    try:
        data = json.loads(body)
        if isinstance(data, dict):
            # Dify 常见结构: {"code": "...", "message": "..."} 或 {"error": "..."}
            return str(data.get("message") or data.get("error") or data)
    except (json.JSONDecodeError, UnicodeDecodeError):
        pass
    text = body.decode("utf-8", errors="replace").strip()
    return text[:300] or "Dify 返回未知错误"
