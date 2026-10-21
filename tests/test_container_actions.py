"""单容器操作的目录约束与命令构造安全边界。"""

import pytest

from app.actions import (
    CONTAINER_ACTION_CATALOG,
    ActionRejected,
    build_container_command,
    validate_container_action,
)


class TestContainerCatalog:
    def test_only_fixed_verbs(self) -> None:
        """容器级只允许启停重启,升级必须走项目级流程。"""
        assert {spec.verb for spec in CONTAINER_ACTION_CATALOG.values()} == {"restart", "stop", "start"}

    def test_stop_requires_confirm(self) -> None:
        assert CONTAINER_ACTION_CATALOG["container_stop"].confirm_required
        assert not CONTAINER_ACTION_CATALOG["container_restart"].confirm_required
        assert not CONTAINER_ACTION_CATALOG["container_start"].confirm_required


class TestValidateContainerAction:
    def test_unknown_action_rejected(self) -> None:
        with pytest.raises(ActionRejected, match="未定义的容器操作"):
            validate_container_action("container_rm", confirm=True)

    def test_stop_requires_explicit_confirm(self) -> None:
        with pytest.raises(ActionRejected, match="需要显式确认"):
            validate_container_action("container_stop", confirm=False)
        spec = validate_container_action("container_stop", confirm=True)
        assert spec.verb == "stop"


class TestBuildContainerCommand:
    def test_basic_command_with_sudo(self) -> None:
        spec = validate_container_action("container_restart", confirm=False)
        assert build_container_command(spec, "docker-api-1", use_sudo=True) == (
            "sudo -n docker restart docker-api-1"
        )

    def test_root_skips_sudo(self) -> None:
        spec = validate_container_action("container_start", confirm=False)
        assert build_container_command(spec, "grok2api", use_sudo=False) == "docker start grok2api"

    @pytest.mark.parametrize(
        "name",
        [
            "api; rm -rf /",
            "api && reboot",
            "$(id)",
            "api`whoami`",
            "/api",
            "-api",
            "api\nstop",
            "api stop",
            "",
        ],
    )
    def test_rejects_injection_vectors(self, name: str) -> None:
        spec = validate_container_action("container_stop", confirm=True)
        with pytest.raises(ActionRejected, match="非法字符"):
            build_container_command(spec, name, use_sudo=True)

    @pytest.mark.parametrize("name", ["api", "docker-api_1.old", "a" * 255])
    def test_accepts_normal_docker_names(self, name: str) -> None:
        spec = validate_container_action("container_restart", confirm=False)
        assert build_container_command(spec, name, use_sudo=False).endswith(name)
