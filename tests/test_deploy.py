"""部署参数校验、预检解析与命令构造的纯逻辑测试。

不连接数据库与目标机,只验证"哪些参数会被拒绝"和"最终执行什么命令"。
"""

import pytest

from app.deploy import (
    DeployError,
    build_deploy_command,
    build_preflight_command,
    evaluate_existing,
    evaluate_git,
    normalize_branch,
    normalize_compose_file,
    normalize_repo_url,
    normalize_spec,
    normalize_work_dir,
    parse_state,
)


def test_work_dir_is_normalized() -> None:
    assert normalize_work_dir(" /opt/app/ ") == "/opt/app"
    assert normalize_work_dir("/opt//app/./docker") == "/opt/app/docker"


@pytest.mark.parametrize(
    "value",
    ["", "opt/app", "/", "/opt/../etc", "/opt/app\nrm -rf /", "~/app"],
)
def test_work_dir_rejects_unsafe_paths(value: str) -> None:
    with pytest.raises(DeployError):
        normalize_work_dir(value)


@pytest.mark.parametrize("value", ["/etc/compose.yml", "../compose.yml", "-f", "a b.yml", "deploy/../../x.yml"])
def test_compose_file_rejects_unsafe_paths(value: str) -> None:
    with pytest.raises(DeployError):
        normalize_compose_file(value)


def test_compose_file_normalizes_relative_path() -> None:
    assert normalize_compose_file(" deploy/./compose.yml ") == "deploy/compose.yml"
    assert normalize_compose_file("") is None


@pytest.mark.parametrize(
    "value",
    [
        "https://github.com/owner/repo.git",
        "http://git.example.com/owner/repo",
        "ssh://git@git.example.com:2222/owner/repo.git",
        "git@github.com:owner/repo.git",
    ],
)
def test_repo_url_accepts_supported_forms(value: str) -> None:
    assert normalize_repo_url(value) == value


@pytest.mark.parametrize(
    "value",
    [
        "",
        "owner/repo",
        "ftp://example.com/repo.git",
        "https://user:token@github.com/owner/repo.git",
        "https://token@github.com/owner/repo.git",
        "git@github.com:owner/repo with space.git",
        "-oProxyCommand=evil",
    ],
)
def test_repo_url_rejects_unsafe_forms(value: str) -> None:
    with pytest.raises(DeployError):
        normalize_repo_url(value)


@pytest.mark.parametrize("value", ["main", "release/1.2", "feature-中文".replace("中文", "x")])
def test_branch_accepts_valid_names(value: str) -> None:
    assert normalize_branch(value) == value


@pytest.mark.parametrize("value", ["", "HEAD", "-x", "../main", "main..x", "main branch", "release/", ".hidden"])
def test_branch_rejects_invalid_names(value: str) -> None:
    if value == "":
        assert normalize_branch(value) is None
        return
    with pytest.raises(DeployError):
        normalize_branch(value)


def test_git_spec_requires_repo_url() -> None:
    with pytest.raises(DeployError):
        normalize_spec("git", "/opt/app")


def test_existing_command_only_starts_containers() -> None:
    spec = normalize_spec("existing", "/opt/my app", "deploy/compose.yml")
    command = build_deploy_command(spec)
    assert command == "cd '/opt/my app' && docker compose -f deploy/compose.yml up -d"
    assert "pull" not in command
    assert "build" not in command


def test_git_command_clones_and_builds() -> None:
    spec = normalize_spec(
        "git",
        "/opt/apps/demo",
        None,
        "https://github.com/owner/repo.git",
        "release/1.2",
    )
    command = build_deploy_command(spec)
    assert "mkdir -p /opt/apps" in command
    assert (
        "git clone --branch release/1.2 --single-branch https://github.com/owner/repo.git /opt/apps/demo"
        in command
    )
    assert "docker compose build && docker compose up -d" in command


def test_git_command_without_branch_uses_remote_default() -> None:
    spec = normalize_spec("git", "/opt/demo", None, "git@github.com:owner/repo.git")
    command = build_deploy_command(spec)
    assert "--branch" not in command
    assert "--single-branch" not in command


def test_existing_preflight_checks_directory_and_compose_config() -> None:
    spec = normalize_spec("existing", "/opt/app/", "docker-compose.yml")
    script = build_preflight_command(spec)
    assert 'DIR=missing' in script
    assert "COMPOSE_FILE=present" in script
    assert "config --quiet" in script
    assert "/opt/app/docker-compose.yml" in script


def test_git_preflight_rejects_nonempty_target_and_checks_branch() -> None:
    spec = normalize_spec("git", "/opt/demo", None, "https://github.com/owner/repo.git", "main")
    script = build_preflight_command(spec)
    assert "TARGET=nonempty" in script
    assert "ls-remote --exit-code --heads" in script
    assert "refs/heads/main" in script


def test_git_preflight_without_branch_checks_head() -> None:
    spec = normalize_spec("git", "/opt/demo", None, "https://github.com/owner/repo.git")
    script = build_preflight_command(spec)
    assert "ls-remote --exit-code --symref" in script


def test_parse_state_ignores_lowercase_and_keeps_values_with_equals() -> None:
    state = parse_state(
        "DIR=present\n"
        "COMPOSE_MSG=line one = line two\n"
        "lowercase=ignored\n"
        "not a marker\n"
        "CONFIG_EXIT=0\n"
    )
    assert state["DIR"] == "present"
    assert state["COMPOSE_MSG"] == "line one = line two"
    assert "lowercase" not in state
    assert state["CONFIG_EXIT"] == "0"


def test_evaluate_existing_reports_all_environment_checks() -> None:
    spec = normalize_spec("existing", "/opt/app")
    checks = evaluate_existing(
        {
            "DIR": "present",
            "DOCKER": "yes",
            "DAEMON": "yes",
            "COMPOSE": "yes",
            "CONFIG_EXIT": "0",
            "CONFIG_MSG": "",
        },
        spec,
    )
    assert all(check.ok for check in checks)
    assert {check.key for check in checks} == {"dir", "compose_file", "docker", "daemon", "compose", "config"}


def test_evaluate_existing_surfaces_compose_error() -> None:
    spec = normalize_spec("existing", "/opt/app", "docker-compose.yml")
    checks = evaluate_existing(
        {
            "DIR": "present",
            "COMPOSE_FILE": "missing",
            "DOCKER": "yes",
            "DAEMON": "yes",
            "COMPOSE": "yes",
            "CONFIG_EXIT": "1",
            "CONFIG_MSG": "no such file",
        },
        spec,
    )
    failed = {check.key: check for check in checks if not check.ok}
    assert "compose_file" in failed
    assert failed["config"].detail == "no such file"


def test_evaluate_existing_missing_directory_stops_early() -> None:
    spec = normalize_spec("existing", "/opt/app")
    checks = evaluate_existing({"DIR": "missing"}, spec)
    assert len(checks) == 1
    assert checks[0].ok is False


@pytest.mark.parametrize("target", ["missing", "empty"])
def test_evaluate_git_accepts_missing_or_empty_target(target: str) -> None:
    spec = normalize_spec("git", "/opt/demo", None, "https://github.com/owner/repo.git")
    checks = evaluate_git(
        {
            "TARGET": target,
            "GIT": "yes",
            "REMOTE_EXIT": "0",
            "PARENT": "writable",
            "DOCKER": "yes",
            "DAEMON": "yes",
            "COMPOSE": "yes",
        },
        spec,
    )
    assert all(check.ok for check in checks)


def test_evaluate_git_rejects_nonempty_target() -> None:
    spec = normalize_spec("git", "/opt/demo", None, "https://github.com/owner/repo.git")
    checks = evaluate_git(
        {
            "TARGET": "nonempty",
            "GIT": "yes",
            "REMOTE_EXIT": "0",
            "PARENT": "writable",
            "DOCKER": "yes",
            "DAEMON": "yes",
            "COMPOSE": "yes",
        },
        spec,
    )
    target = next(check for check in checks if check.key == "target")
    assert target.ok is False


def test_evaluate_git_surfaces_remote_error() -> None:
    spec = normalize_spec("git", "/opt/demo", None, "https://github.com/owner/repo.git", "main")
    checks = evaluate_git(
        {
            "TARGET": "missing",
            "GIT": "yes",
            "REMOTE_EXIT": "2",
            "REMOTE_MSG": "couldn't find remote ref refs/heads/main",
            "PARENT": "writable",
            "DOCKER": "yes",
            "DAEMON": "yes",
            "COMPOSE": "yes",
        },
        spec,
    )
    remote = next(check for check in checks if check.key == "remote")
    assert remote.ok is False
    assert "remote ref" in remote.detail
