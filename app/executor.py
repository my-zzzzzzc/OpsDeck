"""SSH 命令执行器。

通过 `ssh` 在目标服务器上运行白名单命令。

安全设计:
  - 命令必须由 `actions.build_command` 从白名单模板构造,本模块不做任何拼接。
  - 使用 BatchMode,禁止交互式提示,避免进程挂起。
  - 强制 ConnectTimeout 与总超时,防止长时间占用工作线程。
  - 未配置 SSH 凭据时明确报错,不静默降级为本地执行。
"""

import logging
import shutil
import subprocess
from dataclasses import dataclass

from app.models import Server

logger = logging.getLogger(__name__)

# 单条命令的总超时(秒)
COMMAND_TIMEOUT = 120


@dataclass
class ExecResult:
    """命令执行结果。"""

    ok: bool
    exit_code: int
    output: str


def execute(
    server: Server,
    command: str,
    *,
    ssh_key_path: str = "",
    timeout: int = COMMAND_TIMEOUT,
) -> ExecResult:
    """在目标服务器上执行命令并返回输出。

    密钥优先级:显式参数 > 服务器配置的 ssh_key_path > ssh 默认凭据。
    timeout 可按操作覆盖:构建镜像可能远超普通命令的 120 秒。
    """
    if shutil.which("ssh") is None:
        return ExecResult(False, -1, "本机未安装 ssh 客户端,无法执行远程操作")

    if not server.ip and not server.hostname:
        return ExecResult(False, -1, f"服务器 {server.name} 未配置 IP 或主机名")

    target = server.ip or server.hostname or ""
    port = server.ssh_port or 22

    argv = [
        "ssh",
        "-o",
        "BatchMode=yes",  # 禁止交互式提示,否则会挂起
        "-o",
        "ConnectTimeout=10",
        "-o",
        "StrictHostKeyChecking=accept-new",
        "-p",
        str(port),
    ]
    # 密钥优先级:调用方显式传入 > 服务器自身配置 > ssh 默认
    key = ssh_key_path or server.ssh_key_path or ""
    if key:
        argv += ["-i", key, "-o", "IdentitiesOnly=yes"]
    # 用户名必须取自服务器配置:部分云镜像禁用 root,只能以 ubuntu 登录。
    user = server.ssh_user or "root"
    argv += [f"{user}@{target}", command]

    logger.info("在 %s 上执行: %s", server.name, command)

    try:
        proc = subprocess.run(  # noqa: S603 - argv 由白名单构造,未经 shell
            argv,
            capture_output=True,
            text=True,
            timeout=timeout,
            check=False,
        )
    except subprocess.TimeoutExpired:
        return ExecResult(False, -1, f"命令执行超时(超过 {timeout} 秒)")
    except OSError as exc:
        return ExecResult(False, -1, f"无法启动 ssh: {exc}")

    output = (proc.stdout or "") + (proc.stderr or "")
    # 限制入库长度,避免超长日志撑爆数据库
    if len(output) > 20000:
        output = output[:20000] + "\n...(输出已截断)"

    return ExecResult(proc.returncode == 0, proc.returncode, output or "(无输出)")
