"""Compose 项目自动发现的纯函数。

这些规则同时用于上报入库与接管接口:采集器给的标签未必干净,
而工作目录与 Compose 文件名最终会被写进项目资产,必须在这里统一收口。
"""

from __future__ import annotations

import posixpath
import re
from pathlib import PurePosixPath

_CONTROL_RE = re.compile(r"[\x00-\x1f\x7f]")

MAX_COMPOSE_PROJECT = 64
MAX_WORK_DIR = 512
MAX_COMPOSE_FILE = 255


def compose_label(raw: str | None) -> str | None:
    """清洗 Docker Compose 项目标签;空值与非法字符返回 None。"""
    if raw is None:
        return None
    label = raw.strip()
    if not label or _CONTROL_RE.search(label):
        return None
    return label[:MAX_COMPOSE_PROJECT]


def observed_work_dir(raw: str | None) -> str | None:
    """规范化采集到的工作目录。

    必须是绝对 POSIX 路径;超长或含控制字符时直接丢弃,而不是截断 ——
    截断后的路径看起来合法,却指向另一个目录,比没有更危险。
    """
    if raw is None:
        return None
    value = raw.strip()
    if not value or len(value) > MAX_WORK_DIR or _CONTROL_RE.search(value):
        return None
    if not value.startswith("/"):
        return None
    normalized = posixpath.normpath(value)
    if normalized.startswith("//"):
        normalized = "/" + normalized.lstrip("/")
    return normalized


def normalized_work_dir(raw: str | None) -> str | None:
    """用于比较的工作目录;与入库使用同一套规则,避免比较时漏匹配。"""
    return observed_work_dir(raw)


def observed_compose_file(raw: str | None) -> str | None:
    """从 config_files 标签中取第一个 Compose 文件的 basename。

    Compose 允许 `-f a.yml -f b.yml`;项目表只能记录一个文件,取第一个。
    """
    if raw is None:
        return None
    first = raw.split(",")[0].strip()
    if not first or _CONTROL_RE.search(first):
        return None
    name = PurePosixPath(first).name
    if name in ("", ".", "..") or len(name) > MAX_COMPOSE_FILE:
        return None
    return name


def validate_bare_compose_file(value: str | None) -> str:
    """接管接口使用:Compose 文件必须是工作目录下的单个文件名。"""
    raw = (value or "").strip()
    if not raw:
        raise ValueError("Compose 文件不能为空")
    path = PurePosixPath(raw)
    if path.is_absolute() or ".." in path.parts or len(path.parts) != 1:
        raise ValueError("Compose 文件必须位于项目工作目录中")
    return path.name


def event_detail(project_name: str, container_name: str, exit_code: int | None) -> str:
    """容器退出事件的详情;新采集器带退出码时一并展示。"""
    detail = f"项目 {project_name} 的容器 {container_name} 处于 exited 状态。"
    if exit_code:
        detail += f"退出码 {exit_code}。"
    return detail
