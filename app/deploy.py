"""受控部署:接管已有目录,或从 Git 新建。

边界:
  - 前端只提交"部署什么",命令由本模块按来源类型构造,不接受任意命令。
  - 部署前先做只读预检:目录状态、Docker / Compose、Git 远端可达性。
  - Git 只允许克隆到不存在或空的目录,避免覆盖机器上的已有文件。
  - 接管已有目录只执行 `docker compose up -d`,不拉取、不构建 ——
    拉取与升级由「更新」页负责,部署只回答"让它跑起来"。
"""

from __future__ import annotations

import posixpath
import re
import shlex
from dataclasses import dataclass
from typing import Literal
from urllib.parse import urlparse

from app.executor import execute
from app.models import Server

DeploySource = Literal["existing", "git"]

# 预检只做只读探测,网络操作(git ls-remote)给 45 秒。
PREFLIGHT_TIMEOUT = 45
# 构建镜像可能远超普通命令的 120 秒;与更新保持一致。
DEPLOY_TIMEOUT = 900

_CONTROL_RE = re.compile(r"[\x00-\x1f\x7f]")
_BRANCH_RE = re.compile(r"[A-Za-z0-9._/-]+")
_COMPOSE_FILE_RE = re.compile(r"[A-Za-z0-9._/-]+")
_SCP_REPO_RE = re.compile(r"[A-Za-z0-9._-]+@[A-Za-z0-9._-]+:[^\s]+")
_GIT_SSH_COMMAND = (
    "ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new -o ConnectTimeout=10"
)
_GIT_ENV = f'GIT_TERMINAL_PROMPT=0 GIT_SSH_COMMAND="{_GIT_SSH_COMMAND}"'


class DeployError(Exception):
    """部署参数不合法,消息可直接展示给用户。"""


@dataclass(frozen=True)
class DeploySpec:
    """校验并归一化后的部署参数。"""

    source: DeploySource
    work_dir: str
    compose_file: str | None = None
    repo_url: str | None = None
    branch: str | None = None


@dataclass(frozen=True)
class CheckResult:
    """一项预检结果。"""

    key: str
    label: str
    ok: bool
    detail: str


def normalize_name(value: str) -> str:
    """项目名会进入数据库与界面,不参与命令。"""
    raw = (value or "").strip()
    if not raw:
        raise DeployError("项目名不能为空")
    if len(raw) > 64:
        raise DeployError("项目名不能超过 64 个字符")
    if _CONTROL_RE.search(raw):
        raise DeployError("项目名不能包含换行或控制字符")
    return raw


def normalize_work_dir(value: str) -> str:
    """工作目录必须是绝对路径,且不能通过 `..` 跳出。"""
    raw = (value or "").strip()
    if not raw:
        raise DeployError("工作目录不能为空")
    if len(raw) > 512:
        raise DeployError("工作目录不能超过 512 个字符")
    if _CONTROL_RE.search(raw):
        raise DeployError("工作目录不能包含换行或控制字符")
    if not raw.startswith("/"):
        raise DeployError("工作目录必须是绝对路径,例如 /opt/app")

    if ".." in raw.split("/"):
        raise DeployError("工作目录不能包含 ..")

    normalized = posixpath.normpath(raw)
    if normalized.startswith("//"):
        normalized = "/" + normalized.lstrip("/")
    if normalized == "/":
        raise DeployError("不能直接部署到根目录 /")
    return normalized


def normalize_compose_file(value: str | None) -> str | None:
    """Compose 文件是相对工作目录的路径。"""
    raw = (value or "").strip()
    if not raw:
        return None
    if len(raw) > 255:
        raise DeployError("Compose 文件路径不能超过 255 个字符")
    if _CONTROL_RE.search(raw):
        raise DeployError("Compose 文件路径不能包含换行或控制字符")
    if raw.startswith("/"):
        raise DeployError("Compose 文件请填写相对工作目录的路径")
    if raw.startswith("-"):
        raise DeployError("Compose 文件路径不能以 - 开头")
    if ".." in raw.split("/"):
        raise DeployError("Compose 文件路径不能包含 ..")

    normalized = posixpath.normpath(raw)
    if normalized in ("", ".", "..") or normalized.startswith("../"):
        raise DeployError("Compose 文件路径不合法")
    if not _COMPOSE_FILE_RE.fullmatch(normalized):
        raise DeployError("Compose 文件路径只能包含字母、数字、点、下划线、短横线和 /")
    return normalized


def normalize_repo_url(value: str) -> str:
    """只接受 https / http / ssh / git@ 形式的远端地址。

    显式拒绝带账号或令牌的 HTTP(S) 地址:命令和操作日志都会落库,
    把凭据写进 URL 等于把密钥写进数据库与界面。
    """
    raw = (value or "").strip()
    if not raw:
        raise DeployError("Git 仓库地址不能为空")
    if len(raw) > 512:
        raise DeployError("Git 仓库地址不能超过 512 个字符")
    if _CONTROL_RE.search(raw) or any(ch.isspace() for ch in raw):
        raise DeployError("Git 仓库地址不能包含空白字符")
    if raw.startswith("-"):
        raise DeployError("Git 仓库地址不能以 - 开头")

    if _SCP_REPO_RE.fullmatch(raw):
        return raw

    parsed = urlparse(raw)
    if parsed.scheme not in ("http", "https", "ssh"):
        raise DeployError("Git 仓库地址只支持 https://、http://、ssh:// 或 git@host:path 形式")
    if not parsed.hostname:
        raise DeployError("Git 仓库地址缺少主机名")
    if parsed.password:
        raise DeployError("Git 仓库地址不能包含密码或令牌")
    if parsed.scheme in ("http", "https") and parsed.username:
        raise DeployError("Git 仓库地址不能包含账号或令牌")
    if parsed.query or parsed.fragment:
        raise DeployError("Git 仓库地址不能包含查询参数或片段")
    return raw


def normalize_branch(value: str | None) -> str | None:
    """分支留空表示使用远端默认分支。"""
    raw = (value or "").strip()
    if not raw:
        return None
    if len(raw) > 128:
        raise DeployError("分支名不能超过 128 个字符")
    if _CONTROL_RE.search(raw) or any(ch.isspace() for ch in raw):
        raise DeployError("分支名不能包含空白字符")
    if raw.startswith(("-", "/", ".")) or raw.endswith(("/", ".")):
        raise DeployError("分支名不能以 -、/、. 开头,也不能以 / 或 . 结尾")
    if ".." in raw or "//" in raw:
        raise DeployError("分支名不能包含 .. 或 //")
    if raw == "HEAD" or not _BRANCH_RE.fullmatch(raw):
        raise DeployError("分支名不合法")
    return raw


def normalize_spec(
    source: str,
    work_dir: str,
    compose_file: str | None = None,
    repo_url: str | None = None,
    branch: str | None = None,
) -> DeploySpec:
    """校验并归一化部署参数。Git 来源必须携带仓库地址。"""
    if source not in ("existing", "git"):
        raise DeployError("未知的部署方式")
    if source == "git":
        return DeploySpec(
            source="git",
            work_dir=normalize_work_dir(work_dir),
            compose_file=normalize_compose_file(compose_file),
            repo_url=normalize_repo_url(repo_url or ""),
            branch=normalize_branch(branch),
        )
    return DeploySpec(
        source="existing",
        work_dir=normalize_work_dir(work_dir),
        compose_file=normalize_compose_file(compose_file),
    )


def _compose_command(compose_file: str | None) -> str:
    command = "docker compose"
    if compose_file:
        command += f" -f {shlex.quote(compose_file)}"
    return command


def build_deploy_command(spec: DeploySpec) -> str:
    """构造部署命令。命令只由来源类型决定。"""
    work_dir = shlex.quote(spec.work_dir)
    compose = _compose_command(spec.compose_file)

    if spec.source == "existing":
        return f"cd {work_dir} && {compose} up -d"

    parent = shlex.quote(posixpath.dirname(spec.work_dir) or "/")
    repo = shlex.quote(spec.repo_url or "")
    branch = ""
    if spec.branch:
        branch = f" --branch {shlex.quote(spec.branch)} --single-branch"
    return (
        f"mkdir -p {parent} && "
        f"{_GIT_ENV} git clone{branch} {repo} {work_dir} && "
        f"cd {work_dir} && {compose} build && {compose} up -d"
    )


def _docker_checks() -> str:
    return (
        'if command -v docker >/dev/null 2>&1; then echo "DOCKER=yes"; else echo "DOCKER=no"; fi\n'
        'if docker info >/dev/null 2>&1; then echo "DAEMON=yes"; else echo "DAEMON=no"; fi\n'
        'if docker compose version >/dev/null 2>&1; then echo "COMPOSE=yes"; else echo "COMPOSE=no"; fi\n'
    )


def build_preflight_command(spec: DeploySpec) -> str:
    """构造只读预检脚本。输出为若干 KEY=value 行,由 `_parse_state` 解析。"""
    work_dir = shlex.quote(spec.work_dir)

    if spec.source == "existing":
        compose = _compose_command(spec.compose_file)
        compose_file_check = ""
        if spec.compose_file:
            compose_path = shlex.quote(f"{spec.work_dir}/{spec.compose_file}")
            compose_file_check = (
                f'if [ -f {compose_path} ]; then echo "COMPOSE_FILE=present"; '
                'else echo "COMPOSE_FILE=missing"; fi\n'
            )
        return (
            f'if [ ! -d {work_dir} ]; then echo "DIR=missing"; exit 0; fi\n'
            f'if [ ! -r {work_dir} ]; then echo "DIR=unreadable"; exit 0; fi\n'
            'echo "DIR=present"\n'
            f'if [ -z "$(ls -A {work_dir} 2>/dev/null)" ]; then echo "EMPTY=yes"; '
            'else echo "EMPTY=no"; fi\n'
            + compose_file_check
            + _docker_checks()
            + f"OUT=$(cd {work_dir} && {compose} config --quiet 2>&1)\n"
            + 'CODE=$?\n'
            + 'printf "CONFIG_EXIT=%s\\n" "$CODE"\n'
            + 'printf "CONFIG_MSG=%s\\n" "$(printf "%s" "$OUT" | tr "\\n" " " | cut -c1-300)"\n'
        )

    parent = shlex.quote(posixpath.dirname(spec.work_dir) or "/")
    repo = shlex.quote(spec.repo_url or "")
    if spec.branch:
        remote = (
            f"{_GIT_ENV} git ls-remote --exit-code --heads {repo} "
            f"{shlex.quote('refs/heads/' + spec.branch)}"
        )
    else:
        remote = f"{_GIT_ENV} git ls-remote --exit-code --symref {repo} HEAD"

    return (
        f'if [ -e {work_dir} ]; then\n'
        f'  if [ ! -d {work_dir} ]; then echo "TARGET=file";\n'
        f'  elif [ ! -r {work_dir} ]; then echo "TARGET=unreadable";\n'
        f'  elif [ -z "$(ls -A {work_dir} 2>/dev/null)" ]; then echo "TARGET=empty";\n'
        '  else echo "TARGET=nonempty"; fi\n'
        'else echo "TARGET=missing"; fi\n'
        'if command -v git >/dev/null 2>&1; then echo "GIT=yes"; else echo "GIT=no"; fi\n'
        + _docker_checks()
        + f'P={parent}\n'
        + 'while [ ! -e "$P" ] && [ "$P" != "/" ]; do P=$(dirname "$P"); done\n'
        + 'if [ -d "$P" ] && [ -w "$P" ]; then echo "PARENT=writable"; '
        'else echo "PARENT=readonly"; fi\n'
        + 'if command -v git >/dev/null 2>&1; then\n'
        + f'  OUT=$({remote} 2>&1)\n'
        + '  CODE=$?\n'
        + 'else OUT="git 未安装"; CODE=127; fi\n'
        + 'printf "REMOTE_EXIT=%s\\n" "$CODE"\n'
        + 'printf "REMOTE_MSG=%s\\n" "$(printf "%s" "$OUT" | tr "\\n" " " | cut -c1-300)"\n'
    )


def parse_state(output: str) -> dict[str, str]:
    """解析预检脚本的 KEY=value 输出。只接受全大写键,避免误收 shell 报错。"""
    state: dict[str, str] = {}
    for line in (output or "").splitlines():
        key, sep, value = line.partition("=")
        if not sep:
            continue
        key = key.strip()
        if not re.fullmatch(r"[A-Z_]+", key):
            continue
        state[key] = value.strip()
    return state


def evaluate_existing(state: dict[str, str], spec: DeploySpec) -> list[CheckResult]:
    """把接管已有目录的预检输出转成可读清单。"""
    dir_state = state.get("DIR")
    if dir_state == "present":
        checks = [CheckResult("dir", "工作目录", True, f"目录存在:{spec.work_dir}")]
    elif dir_state == "missing":
        return [CheckResult("dir", "工作目录", False, f"目录不存在:{spec.work_dir}")]
    elif dir_state == "unreadable":
        return [CheckResult("dir", "工作目录", False, f"目录不可读:{spec.work_dir}")]
    else:
        return [CheckResult("ssh", "SSH 连接", False, "未能读取目标机状态")]

    if spec.compose_file:
        file_state = state.get("COMPOSE_FILE")
        checks.append(
            CheckResult(
                "compose_file",
                "Compose 文件",
                file_state == "present",
                (
                    f"文件存在:{spec.compose_file}"
                    if file_state == "present"
                    else f"文件不存在:{spec.work_dir}/{spec.compose_file}"
                ),
            )
        )
    else:
        checks.append(CheckResult("compose_file", "Compose 文件", True, "未指定,使用 Compose 默认文件名"))

    docker = state.get("DOCKER") == "yes"
    checks.append(CheckResult("docker", "Docker CLI", docker, "docker 可用" if docker else "目标机没有 docker 命令"))

    daemon = state.get("DAEMON") == "yes"
    checks.append(
        CheckResult("daemon", "Docker 守护进程", daemon, "Docker 正在运行" if daemon else "无法连接 Docker 守护进程")
    )

    compose = state.get("COMPOSE") == "yes"
    checks.append(
        CheckResult(
            "compose",
            "Compose 插件",
            compose,
            "docker compose 可用" if compose else "缺少 docker compose 插件",
        )
    )

    if docker and compose:
        exit_code = state.get("CONFIG_EXIT")
        message = (state.get("CONFIG_MSG") or "").strip()
        ok = exit_code == "0"
        checks.append(
            CheckResult(
                "config",
                "Compose 配置",
                ok,
                "配置校验通过" if ok else (message or f"配置校验失败(退出码 {exit_code or '未知'})"),
            )
        )
    else:
        checks.append(CheckResult("config", "Compose 配置", False, "Docker Compose 不可用,无法校验配置"))
    return checks


def evaluate_git(state: dict[str, str], spec: DeploySpec) -> list[CheckResult]:
    """把 Git 新建的预检输出转成可读清单。"""
    target = state.get("TARGET")
    target_map = {
        "missing": (True, "目标目录不存在,部署时创建"),
        "empty": (True, "目标目录为空,可以克隆"),
        "nonempty": (False, "目标目录非空;Git 部署只允许空目录,避免覆盖已有文件"),
        "file": (False, "目标路径已存在且不是目录"),
        "unreadable": (False, "目标目录不可读"),
    }
    if target in target_map:
        ok, detail = target_map[target]
        checks = [CheckResult("target", "目标目录", ok, detail)]
    else:
        return [CheckResult("ssh", "SSH 连接", False, "未能读取目标机状态")]

    git_cli = state.get("GIT") == "yes"
    checks.append(CheckResult("git", "Git 客户端", git_cli, "git 可用" if git_cli else "目标机没有 git 命令"))

    remote_exit = state.get("REMOTE_EXIT")
    remote_ok = remote_exit == "0"
    remote_msg = (state.get("REMOTE_MSG") or "").strip()
    checks.append(
        CheckResult(
            "remote",
            "Git 远端",
            remote_ok,
            "远端仓库与分支可访问" if remote_ok else (remote_msg or "无法访问远端仓库"),
        )
    )

    writable = state.get("PARENT") == "writable"
    checks.append(
        CheckResult(
            "parent",
            "目标父目录",
            writable,
            "可以创建目标目录" if writable else "目标父目录不可写",
        )
    )

    docker = state.get("DOCKER") == "yes"
    checks.append(CheckResult("docker", "Docker CLI", docker, "docker 可用" if docker else "目标机没有 docker 命令"))

    daemon = state.get("DAEMON") == "yes"
    checks.append(
        CheckResult("daemon", "Docker 守护进程", daemon, "Docker 正在运行" if daemon else "无法连接 Docker 守护进程")
    )

    compose = state.get("COMPOSE") == "yes"
    checks.append(
        CheckResult(
            "compose",
            "Compose 插件",
            compose,
            "docker compose 可用" if compose else "缺少 docker compose 插件",
        )
    )
    return checks


def run_preflight(server: Server, spec: DeploySpec) -> list[CheckResult]:
    """在目标机上执行只读预检。SSH 本身失败时收敛成一条错误,不抛异常。"""
    result = execute(server, build_preflight_command(spec), timeout=PREFLIGHT_TIMEOUT)
    state = parse_state(result.output)

    if not result.ok and not state:
        detail = (result.output or "无法连接目标服务器").strip()
        return [CheckResult("ssh", "SSH 连接", False, detail[:300])]

    checks = evaluate_existing(state, spec) if spec.source == "existing" else evaluate_git(state, spec)
    if not result.ok:
        checks.append(
            CheckResult(
                "remote_exit",
                "远程检查",
                False,
                f"检查脚本未正常结束(退出码 {result.exit_code}),以上结果可能不完整",
            )
        )
    return checks
