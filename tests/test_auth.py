"""权限模型的单元测试。

这是安全边界,必须有测试覆盖:任何角色越权都是严重缺陷。
"""

import pytest

from app.auth import PERMISSIONS, role_has_permission


class TestRolePermissions:
    """验证三角色的权限矩阵。"""

    @pytest.mark.parametrize("role", ["viewer", "operator", "admin"])
    def test_all_roles_can_view(self, role: str) -> None:
        """所有已定义角色都应能查看数据。"""
        assert role_has_permission(role, "view")

    @pytest.mark.parametrize("role", ["operator", "admin"])
    def test_operator_and_admin_can_operate(self, role: str) -> None:
        """运维与管理员可执行运维操作。"""
        assert role_has_permission(role, "operate")

    def test_viewer_cannot_operate(self) -> None:
        """只读角色不能执行任何写操作。"""
        assert not role_has_permission("viewer", "operate")
        assert not role_has_permission("viewer", "manage")
        assert not role_has_permission("viewer", "users")

    def test_only_admin_can_manage_users(self) -> None:
        """用户管理仅限管理员。"""
        assert role_has_permission("admin", "users")
        assert not role_has_permission("operator", "users")
        assert not role_has_permission("viewer", "users")

    def test_only_admin_can_manage_assets(self) -> None:
        """资产增删改仅限管理员。"""
        assert role_has_permission("admin", "manage")
        assert not role_has_permission("operator", "manage")
        assert not role_has_permission("viewer", "manage")

    def test_unknown_role_has_no_permission(self) -> None:
        """未知角色不应获得任何权限(默认拒绝)。"""
        for permission in ("view", "operate", "manage", "users"):
            assert not role_has_permission("superuser", permission)
            assert not role_has_permission("", permission)
            assert not role_has_permission("ADMIN", permission)  # 大小写敏感

    def test_permission_map_is_consistent(self) -> None:
        """权限映射应只包含已知权限点。"""
        known = {"view", "operate", "manage", "users"}
        for role, perms in PERMISSIONS.items():
            assert perms <= known, f"角色 {role} 含未知权限: {perms - known}"

    def test_permissions_are_cumulative(self) -> None:
        """权限应逐级递增:viewer ⊂ operator ⊂ admin。"""
        assert PERMISSIONS["viewer"] < PERMISSIONS["operator"] < PERMISSIONS["admin"]
