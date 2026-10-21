"""白名单操作引擎。

安全模型(重要):
  1. **能力由后端定义** —— 可执行的操作写死在 `ACTION_CATALOG`,不由 AI 或前端传入。
     请求只能指定"项目 + 操作名",不能传命令,从根本上杜绝命令注入。
  2. **危险操作默认关闭** —— `enabled=False` 的操作即使被请求也会拒绝。
  3. **可选二次确认** —— `confirm_required=True` 的操作必须显式带 confirm 标记。
  4. **全部留痕** —— 每次执行都写入 action_logs,失败也记录。

当前执行方式:通过 SSH 在目标服务器上运行预设命令。
  未配置 SSH 凭据时,操作会以 `rejected` 状态记录并返回明确错误。
"""

import logging
import re
import shlex
from dataclasses import dataclass

from app.models import Project

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class ActionSpec:
    """一个白名单操作的定义。"""

    key: str
    label: str
    # 命令模板。{work_dir} 会被项目的工作目录替换。
    command: str
    # 风险等级,仅用于界面提示与排序
    danger: str
    # 是否需要显式确认
    confirm_required: bool
    # 是否为只读操作(只读操作不改变系统状态)
    read_only: bool
    # 是否启用。关闭的操作任何请求都会被拒绝。
    enabled: bool
    description: str


# 操作目录。新增操作必须同时评估其风险等级与是否需要确认。
ACTION_CATALOG: dict[str, ActionSpec] = {
    "status": ActionSpec(
        key="status",
        label="查看状态",
        command="docker compose ps",
        danger="none",
        confirm_required=False,
        read_only=True,
        enabled=True,
        description="列出该项目的容器状态。",
    ),
    "logs": ActionSpec(
        key="logs",
        label="查看日志",
        command="docker compose logs --tail=200 --no-color",
        danger="none",
        confirm_required=False,
        read_only=True,
        enabled=True,
        description="查看该项目最近 200 行日志。",
    ),
    "restart": ActionSpec(
        key="restart",
        label="重启服务",
        command="docker compose restart",
        danger="low",
        confirm_required=False,
        read_only=False,
        enabled=True,
        description="重启该项目全部容器。容器会短暂不可用。",
    ),
    "stop": ActionSpec(
        key="stop",
        label="停止服务",
        command="docker compose stop",
        danger="medium",
        confirm_required=True,
        read_only=False,
        enabled=True,
        description="停止该项目全部容器。服务将不可访问,需人工再启动。",
    ),
    "start": ActionSpec(
        key="start",
        label="启动服务",
        command="docker compose start",
        danger="low",
        confirm_required=False,
        read_only=False,
        enabled=True,
        description="启动该项目已停止的容器。",
    ),
    "pull": ActionSpec(
        key="pull",
        label="拉取新镜像",
        command="docker compose pull",
        danger="medium",
        confirm_required=True,
        read_only=False,
        # 默认关闭:拉取会改变本地镜像,可能影响后续 up 的行为
        enabled=False,
        description="拉取最新镜像但不重启。仅更新本地镜像缓存。",
    ),
    "upgrade": ActionSpec(
        key="upgrade",
        label="升级并重启",
        command="docker compose pull && docker compose up -d",
        danger="high",
        confirm_required=True,
        read_only=False,
        # 默认关闭:升级可能触发数据库迁移,失败会导致数据不一致,必须人工执行
        enabled=False,
        description="拉取新镜像并重建容器。Dify 等应用的版本升级涉及数据库迁移,请人工操作并先备份。",
    ),
}


# ---------------------------------------------------------------- 容器级操作
#
# 单容器操作与项目级操作分开维护:容器名会直接进入命令,必须走白名单字符校验;
# 动作也只保留重启/停止/启动 —— 升级仍走项目级 compose,避免绕过编排。
CONTAINER_NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,254}$")


@dataclass(frozen=True)
class ContainerActionSpec:
    """一个单容器操作的定义。verb 是固定的 Docker 子命令,不接受外部输入。"""

    key: str
    label: str
    verb: str
    danger: str
    confirm_required: bool
    description: str


CONTAINER_ACTION_CATALOG: dict[str, ContainerActionSpec] = {
    "container_restart": ContainerActionSpec(
        key="container_restart",
        label="重启容器",
        verb="restart",
        danger="low",
        confirm_required=False,
        description="只重启这一个容器,同项目的其它服务不受影响。",
    ),
    "container_stop": ContainerActionSpec(
        key="container_stop",
        label="停止容器",
        verb="stop",
        danger="medium",
        confirm_required=True,
        description="只停止这一个容器。若被其它服务依赖,相关调用会立即失败。",
    ),
    "container_start": ContainerActionSpec(
        key="container_start",
        label="启动容器",
        verb="start",
        danger="low",
        confirm_required=False,
        description="启动这一个已停止的容器,不重建也不更新镜像。",
    ),
}


def get_catalog() -> list[dict]:
    """返回操作目录,供前端渲染可用操作。"""
    return [
        {
            "key": spec.key,
            "label": spec.label,
            "danger": spec.danger,
            "confirm_required": spec.confirm_required,
            "read_only": spec.read_only,
            "enabled": spec.enabled,
            "description": spec.description,
        }
        for spec in ACTION_CATALOG.values()
    ]


class ActionRejected(Exception):
    """操作被安全策略拒绝。"""


def build_command(spec: ActionSpec, project: Project) -> str:
    """构造实际执行的命令。

    命令来自白名单模板,项目路径经过 shell 转义,
    调用方无法注入任意内容。
    """
    if not project.work_dir:
        raise ActionRejected(f"项目 {project.name} 未配置工作目录,无法执行操作")

    work_dir = shlex.quote(project.work_dir)

    # compose 文件非默认名时显式指定
    if project.compose_file and project.compose_file != "docker-compose.yaml":
        compose = f" -f {shlex.quote(project.compose_file)}"
    else:
        compose = ""

    base = f"cd {work_dir} && docker compose{compose}"

    # 从模板中剥离 docker compose 前缀,复用其参数部分
    args = spec.command.removeprefix("docker compose").strip()
    return f"{base} {args}".strip()


def validate(spec_key: str, project: Project, *, confirm: bool) -> ActionSpec:
    """校验操作是否允许执行,返回操作定义。不允许时抛出 ActionRejected。"""
    spec = ACTION_CATALOG.get(spec_key)
    if spec is None:
        raise ActionRejected(f"未定义的操作: {spec_key}")

    if not spec.enabled:
        raise ActionRejected(f"操作「{spec.label}」已被禁用。{spec.description}")

    if spec.confirm_required and not confirm:
        raise ActionRejected(f"操作「{spec.label}」需要显式确认")

    if not project.work_dir:
        raise ActionRejected(f"项目 {project.name} 未配置工作目录")

    return spec


def validate_container_action(spec_key: str, *, confirm: bool) -> ContainerActionSpec:
    """校验单容器操作是否允许执行。"""
    spec = CONTAINER_ACTION_CATALOG.get(spec_key)
    if spec is None:
        raise ActionRejected(f"未定义的容器操作: {spec_key}")
    if spec.confirm_required and not confirm:
        raise ActionRejected(f"操作「{spec.label}」需要显式确认")
    return spec


def build_container_command(spec: ContainerActionSpec, name: str, *, use_sudo: bool) -> str:
    """构造单容器命令。动作来自固定目录,容器名必须通过白名单字符校验。"""
    if not CONTAINER_NAME_RE.match(name):
        raise ActionRejected("容器名包含非法字符,无法执行操作")
    prefix = "sudo -n " if use_sudo else ""
    return f"{prefix}docker {spec.verb} {name}"
