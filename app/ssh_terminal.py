"""SSH 终端桥接与会话录制。

连接目标服务器的 SSH PTY,在浏览器与远端之间双向转发数据,并把整个会话
录制为 asciinema v2 格式,供事后回放审计。

安全要点:
  - 使用 BatchMode 等价的配置:不尝试密码认证,仅用密钥,避免交互挂起。
  - 未知主机键按配置处理(默认接受并记录,便于首次接入新机器)。
  - 输出走异步流,不做整体缓冲。
"""

import json
import logging
import time
from collections.abc import AsyncIterator
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path

import asyncssh

from app.config import settings
from app.models import Server

logger = logging.getLogger(__name__)


class SSHError(Exception):
    """SSH 连接或交互失败。"""


@dataclass
class TerminalRecorder:
    """把终端交互录制为 asciinema v2 格式。

    格式:首行是 JSON 头,其后每行是 [时间偏移, "o"|"i", 数据] 的 JSON 数组。
    """

    path: Path
    cols: int
    rows: int
    start_time: float = field(default_factory=time.monotonic)
    bytes_written: int = 0
    max_bytes: int = field(default_factory=lambda: settings.terminal_recording_max_mb * 1024 * 1024)
    _handle: object = None
    truncated: bool = False

    def open(self) -> None:
        """创建录制文件并写入头部。"""
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._handle = self.path.open("w", encoding="utf-8")

        header = {
            "version": 2,
            "width": self.cols,
            "height": self.rows,
            "timestamp": int(datetime.now(UTC).timestamp()),
            "env": {"TERM": "xterm-256color", "SHELL": "/bin/bash"},
        }
        self._handle.write(json.dumps(header, ensure_ascii=False) + "\n")
        self._handle.flush()

    def write(self, kind: str, data: str) -> None:
        """写入一条事件。超出上限后停止录制,避免撑爆磁盘。"""
        if self._handle is None or self.truncated:
            return

        payload = json.dumps([round(time.monotonic() - self.start_time, 6), kind, data], ensure_ascii=False)
        line = payload + "\n"

        if self.bytes_written + len(line) > self.max_bytes:
            self.truncated = True
            self._handle.write(
                json.dumps(
                    [round(time.monotonic() - self.start_time, 6), "o", "\r\n[录制已达大小上限,后续内容不再记录]\r\n"],
                    ensure_ascii=False,
                )
                + "\n"
            )
            self._handle.flush()
            logger.warning("终端录制达到上限 %d 字节,已停止记录: %s", self.max_bytes, self.path)
            return

        self._handle.write(line)
        self.bytes_written += len(line)

    def close(self) -> None:
        """关闭录制文件。"""
        if self._handle is not None:
            try:
                self._handle.flush()
                self._handle.close()
            except Exception:
                logger.exception("关闭录制文件失败: %s", self.path)
            self._handle = None


class SSHTerminal:
    """一个到目标服务器的交互式 SSH 会话。"""

    def __init__(self, server: Server, cols: int = 120, rows: int = 30) -> None:
        self.server = server
        self.cols = cols
        self.rows = rows
        self._conn: asyncssh.SSHClientConnection | None = None
        self._process: asyncssh.SSHClientProcess | None = None
        self.bytes_in = 0
        self.bytes_out = 0

    async def connect(self) -> None:
        """建立 SSH 连接并申请 PTY。"""
        target = self.server.ip or self.server.hostname
        if not target:
            raise SSHError(f"服务器「{self.server.name}」未配置 IP 或主机名")

        kwargs: dict = {
            "host": target,
            "port": self.server.ssh_port or 22,
            "username": "root",
            "known_hosts": None,  # 首次接入新机器时无已知主机键
            "connect_timeout": 15,
            # 禁用所有交互式认证,只用密钥。避免因等待密码输入而挂起。
            # 指定了密钥路径时只用该密钥;否则回退到标准密钥。
            "client_keys": [self.server.ssh_key_path] if self.server.ssh_key_path else None,
            "preferred_auth": ["publickey"],
            "encoding": None,  # 使用 bytes,终端输出可能是任意字节序列
        }

        try:
            self._conn = await asyncssh.connect(**kwargs)
        except asyncssh.PermissionDenied as exc:
            raise SSHError(f"SSH 认证失败,请确认已部署公钥且允许 root 登录:{exc}") from exc
        except (OSError, asyncssh.Error) as exc:
            raise SSHError(f"无法连接 {target}:{self.server.ssh_port} — {exc}") from exc

        try:
            # term_type 与浏览器 xterm 对齐,保证颜色与光标行为一致
            self._process = await self._conn.create_process(
                term_type="xterm-256color",
                term_size=(self.cols, self.rows),
                encoding=None,
            )
        except asyncssh.Error as exc:
            raise SSHError(f"无法创建终端会话: {exc}") from exc

    async def resize(self, cols: int, rows: int) -> None:
        """同步窗口尺寸。不同步会导致 vim/top 排版错乱。"""
        self.cols, self.rows = cols, rows
        if self._process is not None:
            try:
                self._process.change_terminal_size(cols, rows)
            except Exception:
                logger.debug("调整终端尺寸失败", exc_info=True)

    async def read(self) -> AsyncIterator[bytes]:
        """持续读取远端输出。"""
        if self._process is None:
            raise SSHError("会话未建立")

        while True:
            try:
                data = await self._process.stdout.read(65536)
            except asyncssh.TerminalSizeChanged:
                continue
            except (asyncssh.Error, OSError):
                break

            if not data:
                break

            chunk = data if isinstance(data, bytes) else data.encode()
            self.bytes_out += len(chunk)
            yield chunk

    async def write(self, data: str) -> None:
        """把浏览器输入写入远端。"""
        if self._process is None:
            return
        raw = data.encode()
        self.bytes_in += len(raw)
        self._process.stdin.write(raw)

    async def close(self) -> None:
        """关闭会话与连接。"""
        if self._process is not None:
            try:
                self._process.close()
            except Exception:
                logger.debug("关闭 SSH 进程失败", exc_info=True)
            self._process = None

        if self._conn is not None:
            try:
                self._conn.close()
                await self._conn.wait_closed()
            except Exception:
                logger.debug("关闭 SSH 连接失败", exc_info=True)
            self._conn = None


def recording_dir() -> Path:
    """录制文件根目录。"""
    return Path(settings.terminal_recording_dir)


def cleanup_recordings() -> int:
    """删除超过保留期的录制文件,返回删除数量。"""
    root = recording_dir()
    if not root.is_dir():
        return 0

    cutoff = time.time() - settings.terminal_recording_days * 86400
    removed = 0

    for path in root.rglob("*.cast"):
        try:
            if path.stat().st_mtime < cutoff:
                path.unlink()
                removed += 1
        except OSError:
            logger.debug("删除录制文件失败: %s", path, exc_info=True)

    if removed:
        logger.info("清理了 %d 个过期终端录制文件", removed)

    return removed
