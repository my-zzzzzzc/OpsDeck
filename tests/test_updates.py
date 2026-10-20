"""更新来源检测的纯逻辑测试。

这些用例不访问网络、不连接数据库,只验证解析、比较与命令构造。
真正的 SSH / registry / GitHub 检测由界面联调验证。
"""

from types import SimpleNamespace

import pytest

from app.updates import (
    UpdateError,
    _parse_git_probe,
    build_update_command,
    check_release,
    compare_versions,
    guess_upstream_repo,
    infer_current_version,
    inspect_git,
    is_infra_image,
    normalize_github_repo,
    parse_image_ref,
    preferred_image,
)


def test_parse_docker_hub_official_image() -> None:
    image = parse_image_ref("nginx:1.27")
    assert image.registry == "docker.io"
    assert image.repository == "library/nginx"
    assert image.tag == "1.27"
    assert image.canonical == "docker.io/library/nginx:1.27"


def test_parse_ghcr_image() -> None:
    image = parse_image_ref("ghcr.io/chenyme/grok2api:v3.1.6")
    assert image.registry == "ghcr.io"
    assert image.repository == "chenyme/grok2api"
    assert image.tag == "v3.1.6"


def test_parse_registry_with_port_and_digest() -> None:
    image = parse_image_ref("registry.example.com:5000/team/app@sha256:abc123")
    assert image.registry == "registry.example.com:5000"
    assert image.repository == "team/app"
    assert image.digest == "sha256:abc123"
    assert image.tag == "latest"


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("https://github.com/langgenius/dify", "langgenius/dify"),
        ("https://github.com/langgenius/dify.git", "langgenius/dify"),
        ("git@github.com:chenyme/grok2api.git", "chenyme/grok2api"),
        ("owner/repo", "owner/repo"),
    ],
)
def test_normalize_github_repo(raw: str, expected: str) -> None:
    assert normalize_github_repo(raw) == expected


def test_normalize_github_repo_rejects_other_hosts() -> None:
    with pytest.raises(UpdateError):
        normalize_github_repo("https://gitlab.com/owner/repo")


@pytest.mark.parametrize(
    ("left", "right", "expected"),
    [
        ("1.17.1", "1.18.0", -1),
        ("v3.1.6", "3.1.6", 0),
        ("1.18.0", "1.18.0-rc1", 1),
        ("1.17.1-local", "1.17.1", -1),
        ("2.0", "2.0.0", 0),
    ],
)
def test_compare_versions(left: str, right: str, expected: int) -> None:
    assert compare_versions(left, right) == expected


def test_compare_versions_ignores_build_dates() -> None:
    # 20260928-amd64 是构建日期,不是版本号;不能拿它判断升级。
    assert compare_versions("20260928-amd64", "20261001-amd64") is None


def test_infer_dify_version_skips_dependencies() -> None:
    images = [
        "postgres:15-alpine",
        "redis:6-alpine",
        "langgenius/dify-api:1.17.1",
        "langgenius/dify-web:1.17.1",
        "langgenius/dify-plugin-daemon:0.6.10-local",
        "weaviate:1.39.2",
    ]
    assert infer_current_version("docker", images, "langgenius/dify") == "1.17.1"


def test_infer_version_returns_none_for_local_build_tags() -> None:
    assert infer_current_version("code-gateway", ["code-gateway:20260928-amd64"], None) is None


def test_guess_upstream_from_ghcr() -> None:
    assert guess_upstream_repo(["ghcr.io/chenyme/grok2api:v3.1.6"]) == "chenyme/grok2api"


def test_guess_upstream_for_dify_images() -> None:
    images = [
        "postgres:15-alpine",
        "langgenius/dify-api:1.17.1",
        "langgenius/dify-web:1.17.1",
    ]
    assert guess_upstream_repo(images) == "langgenius/dify"


def test_guess_upstream_for_local_image_is_none() -> None:
    assert guess_upstream_repo(["adobe2api-adobe2api"]) is None


def test_infra_image_detection() -> None:
    assert is_infra_image("postgres:15-alpine") is True
    assert is_infra_image("langgenius/dify-sandbox:0.2.15") is True
    assert is_infra_image("langgenius/dify-api:1.17.1") is False


def test_preferred_image_prefers_project_name() -> None:
    images = ["postgres:15-alpine", "ghcr.io/chenyme/grok2api:v3.1.6", "redis:6-alpine"]
    assert preferred_image("grok2api", images) == "ghcr.io/chenyme/grok2api:v3.1.6"


def test_parse_git_probe_keeps_configured_branch() -> None:
    output = (
        "CURRENT=dev\n"
        "HEAD=aaaaaaaa\n"
        "REMOTE=git@github.com:owner/repo.git\n"
        "BRANCH=main\n"
        "LS=bbbbbbbb\trefs/heads/main\n"
    )
    state = _parse_git_probe(output)
    assert state["current"] == "dev"
    assert state["branch"] == "main"
    assert state["latest"] == "bbbbbbbb"


def test_inspect_git_rejects_branch_mismatch(monkeypatch: pytest.MonkeyPatch) -> None:
    output = (
        "CURRENT=dev\n"
        "HEAD=aaaaaaaa\n"
        "REMOTE=git@github.com:owner/repo.git\n"
        "BRANCH=main\n"
        "LS=bbbbbbbb\trefs/heads/main\n"
    )
    monkeypatch.setattr(
        "app.updates.execute",
        lambda *args, **kwargs: SimpleNamespace(ok=True, exit_code=0, output=output),
    )
    server = SimpleNamespace(name="demo", ip="192.0.2.1", hostname=None)
    with pytest.raises(UpdateError, match="不一致"):
        inspect_git(server, "/opt/app", "main")


def test_inspect_git_follows_current_branch(monkeypatch: pytest.MonkeyPatch) -> None:
    output = (
        "CURRENT=dev\n"
        "HEAD=aaaaaaaa\n"
        "REMOTE=git@github.com:owner/repo.git\n"
        "BRANCH=dev\n"
        "LS=bbbbbbbb\trefs/heads/dev\n"
    )
    monkeypatch.setattr(
        "app.updates.execute",
        lambda *args, **kwargs: SimpleNamespace(ok=True, exit_code=0, output=output),
    )
    server = SimpleNamespace(name="demo", ip="192.0.2.1", hostname=None)
    state = inspect_git(server, "/opt/app", None)
    assert state["branch"] == "dev"
    assert state["latest"] == "bbbbbbbb"


def test_build_git_command() -> None:
    project = SimpleNamespace(name="adobe2api", work_dir="/opt/adobe2api", compose_file="docker-compose.yml")
    config = SimpleNamespace(source_type="git")
    command = build_update_command(config, project)
    assert command.startswith("cd /opt/adobe2api &&")
    assert "git pull --ff-only" in command
    assert "docker compose -f docker-compose.yml build" in command
    assert "docker compose -f docker-compose.yml up -d" in command


def test_build_registry_command() -> None:
    project = SimpleNamespace(name="grok2api", work_dir="/opt/grok2api", compose_file=None)
    config = SimpleNamespace(source_type="registry")
    command = build_update_command(config, project)
    assert command == "cd /opt/grok2api && docker compose pull && docker compose up -d"


def test_release_source_is_not_auto_applied() -> None:
    project = SimpleNamespace(name="dify", work_dir="/opt/dify", compose_file=None)
    config = SimpleNamespace(source_type="release")
    with pytest.raises(UpdateError):
        build_update_command(config, project)


def test_missing_work_dir_is_rejected() -> None:
    project = SimpleNamespace(name="opsdeck", work_dir=None, compose_file=None)
    config = SimpleNamespace(source_type="git")
    with pytest.raises(UpdateError):
        build_update_command(config, project)


def test_check_release_reports_newer_version(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        "app.updates.fetch_latest_release",
        lambda repo: {
            "tag": "v1.18.0",
            "name": "1.18.0",
            "url": "https://github.com/langgenius/dify/releases/tag/1.18.0",
            "published_at": "2026-10-01T00:00:00Z",
            "notes": "upgrade notes",
        },
    )
    config = SimpleNamespace(upstream_repo="langgenius/dify", current_version="1.17.1")
    project = SimpleNamespace(name="dify")
    result = check_release(config, project, ["langgenius/dify-api:1.17.1"])
    assert result.status == "update_available"
    assert result.current_version == "1.17.1"
    assert result.latest_version == "v1.18.0"
    assert result.release_url is not None


def test_check_release_reports_up_to_date(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        "app.updates.fetch_latest_release",
        lambda repo: {
            "tag": "1.17.1",
            "name": "1.17.1",
            "url": "https://github.com/langgenius/dify/releases/tag/1.17.1",
            "published_at": None,
            "notes": "",
        },
    )
    config = SimpleNamespace(upstream_repo="langgenius/dify", current_version=None)
    project = SimpleNamespace(name="dify")
    result = check_release(config, project, ["langgenius/dify-api:1.17.1"])
    assert result.status == "up_to_date"
    assert result.current_version == "1.17.1"
