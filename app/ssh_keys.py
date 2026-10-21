"""SSH 私钥路径解析。

服务器记录的是目标机(或生产容器)内的 POSIX 路径。本地开发在 Windows 上时
这些路径不存在,通过 SSH_KEY_OVERRIDE_DIR 按文件名映射到本机密钥;
服务器未单独配置密钥时回退到 SSH_DEFAULT_KEY_PATH 或 OpenSSH 默认身份文件。
"""

from pathlib import Path, PurePosixPath

from app.config import settings


def resolve_ssh_key(server_key_path: str | None) -> str | None:
    """返回本机可用的私钥路径;None 表示交给底层使用默认凭据。"""
    if server_key_path:
        if settings.ssh_key_override_dir:
            name = PurePosixPath(server_key_path.replace("\\", "/")).name
            candidate = Path(settings.ssh_key_override_dir) / name
            if candidate.is_file():
                return str(candidate)
        return server_key_path
    return settings.ssh_default_key_path or None
