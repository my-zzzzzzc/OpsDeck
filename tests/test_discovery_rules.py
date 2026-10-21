"""Compose 项目自动发现的规则测试。"""

import pytest

from app.discovery import (
    compose_label,
    event_detail,
    normalized_work_dir,
    observed_compose_file,
    observed_work_dir,
    validate_bare_compose_file,
)


def test_compose_label_trims_and_limits():
    assert compose_label("  dify  ") == "dify"
    assert compose_label("") is None
    assert compose_label(None) is None
    assert compose_label("a" * 80) == "a" * 64
    assert compose_label("bad\nlabel") is None


def test_observed_work_dir_requires_absolute_posix_path():
    assert observed_work_dir("/opt/dify/docker/") == "/opt/dify/docker"
    assert observed_work_dir("/opt//dify/./docker") == "/opt/dify/docker"
    assert observed_work_dir("relative/dir") is None
    assert observed_work_dir("") is None
    assert observed_work_dir("/" + "a" * 600) is None
    assert observed_work_dir("/opt/bad\x00dir") is None


def test_normalized_work_dir_matches_observed():
    assert normalized_work_dir("/opt/app/") == normalized_work_dir("/opt/app")
    assert normalized_work_dir(None) is None


def test_observed_compose_file_uses_first_basename():
    assert observed_compose_file("/opt/app/docker-compose.yml") == "docker-compose.yml"
    assert observed_compose_file("/opt/app/docker-compose.yml,/opt/app/override.yml") == "docker-compose.yml"
    assert observed_compose_file("compose.yaml") == "compose.yaml"
    assert observed_compose_file("") is None
    assert observed_compose_file("   ") is None


def test_validate_bare_compose_file():
    assert validate_bare_compose_file("docker-compose.yaml") == "docker-compose.yaml"
    with pytest.raises(ValueError):
        validate_bare_compose_file("../compose.yaml")
    with pytest.raises(ValueError):
        validate_bare_compose_file("/opt/compose.yaml")
    with pytest.raises(ValueError):
        validate_bare_compose_file("sub/compose.yaml")
    with pytest.raises(ValueError):
        validate_bare_compose_file("   ")


def test_event_detail_appends_nonzero_exit_code():
    assert event_detail("dify", "api", 0) == "项目 dify 的容器 api 处于 exited 状态。"
    assert event_detail("dify", "api", None) == "项目 dify 的容器 api 处于 exited 状态。"
    assert "退出码 137" in event_detail("dify", "api", 137)
