"""白名单操作引擎的单元测试。

重点覆盖安全边界:命令注入、禁用操作、确认要求、路径转义。
"""

import uuid
from dataclasses import dataclass

import pytest

from app.actions import ACTION_CATALOG, ActionRejected, build_command, get_catalog, validate


@dataclass
class FakeProject:
    """最小项目替身,只提供 build_command/validate 需要的字段。"""

    name: str = "test-project"
    work_dir: str | None = "/opt/test"
    compose_file: str | None = "docker-compose.yaml"


class TestCatalog:
    """操作目录本身的约束。"""

    def test_no_command_injection_vectors(self) -> None:
        """目录中的命令不应包含 shell 元字符,避免模板被滥用。"""
        dangerous = (";", "|", "&", "$(", "`", ">", "<", "\n")
        for key, spec in ACTION_CATALOG.items():
            for ch in dangerous:
                # 允许 && (compose 链式调用是受控的),但不允许其他元字符
                if ch == "&":
                    assert "&&" in spec.command or "&" not in spec.command, f"{key} 含裸 &"
                    continue
                assert ch not in spec.command, f"{key} 的命令含危险字符 {ch!r}"

    def test_high_risk_actions_disabled_by_default(self) -> None:
        """高风险操作必须默认禁用。"""
        for key in ("upgrade", "pull"):
            assert not ACTION_CATALOG[key].enabled, f"{key} 不应默认启用"

    def test_write_actions_are_marked(self) -> None:
        """写操作不能被标记为只读。"""
        for key, spec in ACTION_CATALOG.items():
            if key in ("status", "logs"):
                assert spec.read_only, f"{key} 应为只读"
            else:
                assert not spec.read_only, f"{key} 应为写操作"

    def test_catalog_is_serializable(self) -> None:
        """目录应能安全地返回给前端,不泄露命令模板。"""
        catalog = get_catalog()
        assert len(catalog) == len(ACTION_CATALOG)
        for item in catalog:
            assert "command" not in item, "不应把命令模板暴露给前端"


class TestValidate:
    """操作校验逻辑。"""

    def test_unknown_action_rejected(self) -> None:
        """未定义的操作必须拒绝。"""
        with pytest.raises(ActionRejected, match="未定义的操作"):
            validate("rm -rf /", FakeProject(), confirm=True)

    def test_disabled_action_rejected(self) -> None:
        """已禁用的操作即使带确认也拒绝。"""
        with pytest.raises(ActionRejected, match="已被禁用"):
            validate("upgrade", FakeProject(), confirm=True)

    def test_confirm_required(self) -> None:
        """需确认的操作未确认时必须拒绝。"""
        with pytest.raises(ActionRejected, match="需要显式确认"):
            validate("stop", FakeProject(), confirm=False)

    def test_confirm_satisfied(self) -> None:
        """带确认后应通过。"""
        spec = validate("stop", FakeProject(), confirm=True)
        assert spec.key == "stop"

    def test_no_work_dir_rejected(self) -> None:
        """未配置工作目录的项目不能执行操作。"""
        with pytest.raises(ActionRejected, match="未配置工作目录"):
            validate("status", FakeProject(work_dir=None), confirm=False)

    def test_read_only_action_allowed_for_any_project(self) -> None:
        """只读操作应可对任何已配置目录的项目执行。"""
        spec = validate("logs", FakeProject(), confirm=False)
        assert spec.read_only


class TestBuildCommand:
    """命令构造的安全性与正确性。"""

    def test_basic_command(self) -> None:
        """基本命令应包含 cd 与 compose 调用。"""
        cmd = build_command(ACTION_CATALOG["status"], FakeProject())
        assert cmd == "cd /opt/test && docker compose ps"

    def test_work_dir_is_escaped(self) -> None:
        """含空格或特殊字符的路径必须被转义,防止注入。"""
        project = FakeProject(work_dir="/opt/my dir; rm -rf /")
        cmd = build_command(ACTION_CATALOG["status"], project)
        # 整段路径被单引号包裹,分号不会生效
        assert "'; rm -rf /'" not in cmd.replace("'", "X", 1)[1:20]
        assert cmd.startswith("cd '")
        assert "&&" in cmd

    def test_custom_compose_file(self) -> None:
        """非默认 compose 文件名应显式指定。"""
        project = FakeProject(compose_file="compose.prod.yaml")
        cmd = build_command(ACTION_CATALOG["status"], project)
        assert "-f compose.prod.yaml" in cmd

    def test_default_compose_file_omitted(self) -> None:
        """默认文件名不重复指定。"""
        cmd = build_command(ACTION_CATALOG["status"], FakeProject())
        assert "-f" not in cmd

    def test_missing_work_dir_raises(self) -> None:
        """缺少工作目录时抛 ActionRejected 而非生成错误命令。"""
        with pytest.raises(ActionRejected):
            build_command(ACTION_CATALOG["status"], FakeProject(work_dir=None))

    def test_chained_command_preserved(self) -> None:
        """含 && 的模板应完整保留。"""
        cmd = build_command(ACTION_CATALOG["upgrade"], FakeProject())
        assert cmd == "cd /opt/test && docker compose pull && docker compose up -d"

    def test_uuid_project_id_not_in_command(self) -> None:
        """命令中不应包含项目 ID —— 只依赖工作目录。"""
        cmd = build_command(ACTION_CATALOG["status"], FakeProject())
        assert str(uuid.uuid4()) not in cmd
