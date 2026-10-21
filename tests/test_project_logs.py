"""项目日志命令构造测试。"""

from types import SimpleNamespace

import pytest

from app.api.project_logs import MAX_TAIL_LINES, _build_command
from app.log_stream import LogError, validate_since


def _project(**overrides: object) -> SimpleNamespace:
    values: dict[str, object] = {"work_dir": "/opt/app", "compose_file": None, "compose_project": None}
    values.update(overrides)
    return SimpleNamespace(**values)


def test_build_command_quotes_work_dir_and_compose_file():
    command = _build_command(
        _project(work_dir="/opt/my app", compose_file="my compose.yml"),
        since="15m",
        tail=200,
        follow=True,
    )
    assert command == (
        "cd '/opt/my app' && docker compose -f 'my compose.yml' logs "
        "--timestamps --no-color --since 15m --tail 200 --follow"
    )


def test_build_command_without_compose_file_lets_compose_autodetect():
    command = _build_command(_project(), since=None, tail=200, follow=False)
    assert command == "cd /opt/app && docker compose logs --timestamps --no-color --tail 200"


def test_build_command_tail_is_clamped():
    assert "--tail 0" in _build_command(_project(), since=None, tail=-5, follow=True)
    assert f"--tail {MAX_TAIL_LINES}" in _build_command(_project(), since=None, tail=99_999, follow=False)


def test_build_command_falls_back_to_compose_project_label():
    command = _build_command(
        _project(work_dir=None, compose_project="dify"),
        since="15m",
        tail=200,
        follow=True,
    )
    assert command == (
        "cd / && docker compose -p dify logs --timestamps --no-color --since 15m --tail 200 --follow"
    )


def test_build_command_rejects_missing_work_dir_without_compose_project():
    with pytest.raises(LogError):
        _build_command(_project(work_dir=None), since=None, tail=200, follow=False)


def test_build_command_rejects_relative_work_dir():
    with pytest.raises(LogError):
        _build_command(_project(work_dir="relative/dir"), since=None, tail=200, follow=False)


def test_build_command_rejects_shell_in_since():
    with pytest.raises(LogError):
        _build_command(_project(), since="15m; rm -rf /", tail=200, follow=True)


def test_validate_since_accepts_relative_and_rfc3339():
    assert validate_since("15m") == "15m"
    assert validate_since("1h") == "1h"
    assert validate_since("2026-10-21T00:00:00Z") == "2026-10-21T00:00:00Z"
    with pytest.raises(LogError):
        validate_since("15 m")
    with pytest.raises(LogError):
        validate_since("$(whoami)")
