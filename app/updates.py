"""项目更新检测与受控升级。

边界:
  - 检测只读:Git 用 ls-remote,镜像用 registry API,Release 用 GitHub API。
  - 升级只认来源类型:git 走 pull + build + up,registry 走 pull + up,
    release / manual 不自动执行 —— 版本升级往往带数据库迁移,必须人工确认步骤。
  - 所有升级都写入 action_logs 与 audit_logs,失败同样留痕。
"""

from __future__ import annotations

import hashlib
import json
import logging
import re
import shlex
from dataclasses import dataclass
from typing import Any

import httpx

from app.config import settings
from app.executor import execute
from app.models import Project, ProjectUpdateConfig, Server

logger = logging.getLogger(__name__)

GIT_TIMEOUT = 30
# 构建镜像可能远超普通命令的 120 秒;这里给 15 分钟,并在界面上提示可能较慢。
UPDATE_TIMEOUT = 900
GITHUB_API = "https://api.github.com"

MANIFEST_ACCEPT = ", ".join(
    [
        "application/vnd.oci.image.index.v1+json",
        "application/vnd.docker.distribution.manifest.list.v2+json",
        "application/vnd.oci.image.manifest.v1+json",
        "application/vnd.docker.distribution.manifest.v2+json",
    ]
)

# 这些镜像属于项目的依赖,不是项目本身。推断更新来源时必须跳过,
# 否则 Dify 的 postgres / nginx 会让"项目当前版本"变成 15 / latest。
INFRA_IMAGE_NAMES = {
    "postgres",
    "postgresql",
    "redis",
    "nginx",
    "mysql",
    "mariadb",
    "mongo",
    "mongodb",
    "rabbitmq",
    "minio",
    "traefik",
    "caddy",
    "squid",
    "warp",
    "weaviate",
    "qdrant",
    "etcd",
    "consul",
    "vault",
    "memcached",
    "clickhouse",
}

_VERSION_RE = re.compile(r"^v?(\d+\.\d+(?:\.\d+)*)(?:[-+](.+))?$", re.IGNORECASE)
_REPO_RE = re.compile(r"^([A-Za-z0-9_.-]+)/([A-Za-z0-9_.-]+)$")


class UpdateError(Exception):
    """检测或升级无法继续,消息直接展示给用户。"""


@dataclass
class CheckResult:
    """一次检测的结论。由 API 层写回 project_update_configs。"""

    status: str
    current_version: str | None
    latest_version: str | None
    detail: str
    release_url: str | None = None
    extra: dict[str, Any] | None = None


@dataclass(frozen=True)
class ImageRef:
    """解析后的镜像引用。"""

    registry: str
    repository: str
    tag: str
    digest: str | None = None

    @property
    def base(self) -> str:
        """不含 tag / digest 的完整仓库名。"""
        if self.registry == "docker.io":
            return f"docker.io/{self.repository}"
        return f"{self.registry}/{self.repository}"

    @property
    def canonical(self) -> str:
        """用于比较与展示的规范形式。"""
        if self.digest:
            return f"{self.base}@{self.digest}"
        return f"{self.base}:{self.tag}"


def parse_image_ref(value: str) -> ImageRef:
    """解析镜像引用,补全 Docker Hub 的 library/ 前缀。"""
    raw = value.strip()
    if not raw:
        raise UpdateError("镜像引用为空")

    name, digest = raw, None
    if "@" in raw:
        name, digest = raw.split("@", 1)

    slash = name.rfind("/")
    colon = name.rfind(":")
    tag = "latest"
    if colon > slash:
        tag = name[colon + 1 :]
        name = name[:colon]

    parts = name.split("/")
    if len(parts) > 1 and ("." in parts[0] or ":" in parts[0] or parts[0] == "localhost"):
        registry = parts[0]
        repository = "/".join(parts[1:])
    else:
        registry = "docker.io"
        repository = name

    if not repository:
        raise UpdateError(f"无法解析镜像引用: {value}")
    if registry == "docker.io" and "/" not in repository:
        repository = f"library/{repository}"

    return ImageRef(registry=registry, repository=repository, tag=tag, digest=digest)


def normalize_github_repo(value: str | None) -> str:
    """把 GitHub 地址归一化成 owner/repo。只接受 github.com。"""
    if not value:
        raise UpdateError("未配置 GitHub 仓库")

    raw = value.strip().rstrip("/")
    if raw.startswith("git@"):
        raw = raw.removeprefix("git@")
        raw = raw.replace(":", "/", 1)
    raw = raw.removeprefix("https://").removeprefix("http://")
    raw = raw.removeprefix("www.")

    if raw.startswith("github.com/"):
        raw = raw.removeprefix("github.com/")
    elif "github.com/" in raw:
        raise UpdateError("只支持 github.com 上的仓库")
    elif raw.startswith(("gitlab.com/", "gitee.com/")):
        raise UpdateError("Release 来源目前只支持 GitHub;其他平台请使用 Git 或 Registry 来源")

    raw = raw.removesuffix(".git")
    if not _REPO_RE.match(raw):
        raise UpdateError(f"GitHub 仓库格式应为 owner/repo: {value}")
    return raw


def version_key(value: str | None) -> tuple[tuple[int, ...], int, str] | None:
    """提取版本号的可比较形式。无法识别时返回 None。"""
    if not value:
        return None
    match = _VERSION_RE.match(value.strip())
    if not match:
        return None
    numbers = tuple(int(part) for part in match.group(1).split("."))
    prerelease = match.group(2) or ""
    # 正式版高于同号的预发布版;预发布之间按字典序,足够区分 alpha / beta / rc。
    return numbers, 0 if prerelease else 1, prerelease


def compare_versions(left: str | None, right: str | None) -> int | None:
    """比较两个版本。无法识别时返回 None。"""
    lk, rk = version_key(left), version_key(right)
    if lk is None or rk is None:
        return None

    ln, lp, ls = lk
    rn, rp, rs = rk
    width = max(len(ln), len(rn))
    ln += (0,) * (width - len(ln))
    rn += (0,) * (width - len(rn))

    if ln != rn:
        return 1 if ln > rn else -1
    if lp != rp:
        return 1 if lp > rp else -1
    if ls != rs:
        return 1 if ls > rs else -1
    return 0


def _safe_parse(value: str) -> ImageRef | None:
    try:
        return parse_image_ref(value)
    except UpdateError:
        return None


def is_infra_image(value: str) -> bool:
    """判断镜像是否是常见基础设施依赖。"""
    parsed = _safe_parse(value)
    if parsed is None:
        return False
    name = parsed.repository.rsplit("/", 1)[-1].lower()
    return name in INFRA_IMAGE_NAMES or name.startswith(("dify-sandbox", "dify-plugin-daemon"))


def preferred_image(project_name: str, images: list[str]) -> str | None:
    """从项目已采集的镜像里挑一个最像"项目本体"的。

    优先名字包含项目名的镜像;跳过 postgres / redis 这类依赖。
    """
    candidates = [image for image in images if not is_infra_image(image)]
    if not candidates:
        candidates = images
    if not candidates:
        return None

    lowered = project_name.lower()

    def score(image: str) -> int:
        parsed = _safe_parse(image)
        if parsed is None:
            return -1
        name = parsed.repository.rsplit("/", 1)[-1].lower()
        points = 0
        if lowered and (lowered in name or name in lowered):
            points += 100
        if parsed.registry != "docker.io":
            points += 10
        if parsed.tag != "latest":
            points += 1
        return points

    return max(candidates, key=score)


def guess_upstream_repo(images: list[str]) -> str | None:
    """从镜像名推断 GitHub 仓库。

    ghcr.io/<owner>/<repo> 本身就是 owner/repo;Docker Hub 的
    langgenius/dify-* 则统一归到 langgenius/dify 这个发布仓库。
    """
    for image in images:
        parsed = _safe_parse(image)
        if parsed is None:
            continue

        parts = parsed.repository.split("/")
        if parsed.registry == "ghcr.io" and len(parts) >= 2:
            return f"{parts[0]}/{parts[1]}"

        if parsed.registry == "docker.io" and len(parts) == 2 and parts[0] != "library":
            owner, name = parts
            if is_infra_image(image):
                continue
            if owner == "langgenius" and name.startswith("dify"):
                return "langgenius/dify"
            return f"{owner}/{name}"
    return None


def infer_current_version(project_name: str, images: list[str], upstream_repo: str | None) -> str | None:
    """从部署镜像的 tag 推断项目当前版本。

    只接受带小数点的版本号:20260928-amd64 这类构建日期标签不是版本,
    把它当作"当前版本 20260928"会得出完全错误的升级结论。
    """
    upstream_name = upstream_repo.rsplit("/", 1)[-1].lower() if upstream_repo else ""
    project_key = project_name.lower()

    best: tuple[tuple[int, ...], int, str] | None = None
    best_score = -1
    best_tag: str | None = None

    for image in images:
        if is_infra_image(image):
            continue
        parsed = _safe_parse(image)
        if parsed is None:
            continue
        key = version_key(parsed.tag)
        if key is None:
            continue

        name = parsed.repository.rsplit("/", 1)[-1].lower()
        score = 0
        if upstream_name and (upstream_name in name or name in upstream_name):
            score += 10
        if project_key and (project_key in name or name in project_key):
            score += 5
        if parsed.registry in ("docker.io", "ghcr.io"):
            score += 1

        if best is None or key > best or (key == best and score > best_score):
            best, best_score, best_tag = key, score, parsed.tag

    return best_tag


# ---------------------------------------------------------------- Git


def _git_probe_command(work_dir: str, branch: str | None) -> str:
    quoted_dir = shlex.quote(work_dir)
    quoted_branch = shlex.quote(branch or "")
    return (
        f"cd {quoted_dir} && "
        f"B={quoted_branch}; "
        'CURRENT=$(git rev-parse --abbrev-ref HEAD 2>/dev/null); '
        'if [ -z "$B" ]; then B=$CURRENT; fi; '
        "printf 'CURRENT=%s\\n' \"$CURRENT\"; "
        "printf 'HEAD='; git rev-parse HEAD 2>/dev/null; "
        "printf '\\nREMOTE='; git config --get remote.origin.url 2>/dev/null; "
        "printf '\\nBRANCH=%s\\n' \"$B\"; "
        "printf 'LS='; "
        'if [ -n "$B" ] && [ "$B" != "HEAD" ]; then '
        'git ls-remote origin "refs/heads/$B" 2>/dev/null; '
        "else git ls-remote origin HEAD 2>/dev/null; fi; "
        "printf '\\n'"
    )


def _parse_git_probe(output: str) -> dict[str, str]:
    state: dict[str, str] = {}
    for line in output.splitlines():
        if line.startswith("HEAD="):
            state["head"] = line.removeprefix("HEAD=").strip()
        elif line.startswith("REMOTE="):
            state["remote"] = line.removeprefix("REMOTE=").strip()
        elif line.startswith("BRANCH="):
            state["branch"] = line.removeprefix("BRANCH=").strip()
        elif line.startswith("CURRENT="):
            state["current"] = line.removeprefix("CURRENT=").strip()
        elif line.startswith("LS="):
            state["ls"] = line.removeprefix("LS=").strip()

    latest = state.get("ls", "").split()[0] if state.get("ls") else ""
    if latest:
        state["latest"] = latest
    return state


def inspect_git(server: Server, work_dir: str | None, branch: str | None = None) -> dict[str, str]:
    """通过 SSH 读取工作目录的 Git 状态与远端分支头。只读。"""
    if not work_dir:
        raise UpdateError("项目未配置工作目录,无法检查 Git 提交")
    if not server.ip and not server.hostname:
        raise UpdateError(f"服务器 {server.name} 未配置 IP 或主机名")

    result = execute(server, _git_probe_command(work_dir, branch), timeout=GIT_TIMEOUT)
    state = _parse_git_probe(result.output or "")

    if not state.get("head"):
        detail = (result.output or "").strip() or "无输出"
        raise UpdateError(f"无法读取 Git 状态: {detail[:300]}")
    current = state.get("current")
    if not current or current == "HEAD":
        raise UpdateError("仓库处于 detached HEAD 状态,无法确定要跟踪的分支")
    # 比较的是 HEAD 与远端分支;两者不是同一分支时会得出错误结论,
    # 而且 git pull 也只会更新当前检出分支。
    if branch and current != branch:
        raise UpdateError(
            f"当前检出分支为 {current},与配置跟踪的 {branch} 不一致;"
            "请先在服务器切换分支,或将分支留空以跟踪当前分支"
        )
    if not state.get("latest"):
        raise UpdateError(f"无法读取远端分支 {state.get('branch') or 'HEAD'} 的最新提交")
    return state


def check_git(config: ProjectUpdateConfig, project: Project, server: Server) -> CheckResult:
    state = inspect_git(server, project.work_dir, config.branch)
    head = state["head"]
    latest = state["latest"]
    branch = state.get("branch") or config.branch or "HEAD"
    remote = state.get("remote") or config.repo_url or ""

    same = head == latest
    detail = (
        f"分支 {branch}: {head[:7]} 已是最新"
        if same
        else f"分支 {branch}: {head[:7]} → {latest[:7]}"
    )
    return CheckResult(
        status="up_to_date" if same else "update_available",
        current_version=head,
        latest_version=latest,
        detail=detail,
        extra={
            "deployed_commit": head,
            "latest_commit": latest,
            "branch": branch,
            "remote_url": remote,
        },
    )


# ---------------------------------------------------------------- Registry


def _registry_base(image: ImageRef) -> str:
    if image.registry == "docker.io":
        return "https://registry-1.docker.io/v2"
    return f"https://{image.registry}/v2"


def _registry_token(client: httpx.Client, challenge: str, image: ImageRef) -> str:
    params = dict(re.findall(r'(\w+)="([^"]*)"', challenge))
    realm = params.get("realm")
    if not realm:
        raise UpdateError("镜像仓库要求认证,但未返回认证地址")

    scope = params.get("scope") or f"repository:{image.repository}:pull"
    query: dict[str, str] = {"scope": scope}
    if params.get("service"):
        query["service"] = params["service"]

    response = client.get(realm, params=query)
    if response.status_code != 200:
        raise UpdateError(f"镜像仓库认证失败(HTTP {response.status_code})")

    try:
        payload = response.json()
    except ValueError as exc:
        raise UpdateError("镜像仓库认证返回了非 JSON 内容") from exc

    token = payload.get("token") or payload.get("access_token")
    if not token:
        raise UpdateError("镜像仓库认证未返回 token")
    return token


def fetch_registry_digest(image: ImageRef) -> str:
    """读取远端 manifest 的 digest。支持公开的 Docker Hub / GHCR 等 v2 仓库。"""
    reference = image.digest or image.tag
    url = f"{_registry_base(image)}/{image.repository}/manifests/{reference}"
    headers = {"Accept": MANIFEST_ACCEPT, "User-Agent": "OpsDeck/0.3"}

    try:
        with httpx.Client(timeout=20, follow_redirects=True) as client:
            response = client.get(url, headers=headers)

            if response.status_code == 401:
                token = _registry_token(client, response.headers.get("www-authenticate", ""), image)
                response = client.get(url, headers={**headers, "Authorization": f"Bearer {token}"})

            if response.status_code in (401, 403):
                raise UpdateError("镜像仓库需要认证;当前仅支持公开镜像")
            if response.status_code == 404:
                raise UpdateError(f"仓库中不存在 {image.tag} 标签")
            if response.status_code != 200:
                raise UpdateError(f"镜像仓库返回 HTTP {response.status_code}")
    except httpx.HTTPError as exc:
        raise UpdateError(f"无法访问镜像仓库 {image.registry}: {exc}") from exc

    digest = response.headers.get("docker-content-digest")
    if not digest:
        digest = f"sha256:{hashlib.sha256(response.content).hexdigest()}"
    return digest


def local_image_digests(server: Server, image_ref: str) -> list[str]:
    """读取目标机上该镜像的 RepoDigests(只读)。"""
    command = "docker image inspect --format '{{json .RepoDigests}}' " + shlex.quote(image_ref)
    result = execute(server, command, timeout=GIT_TIMEOUT)
    if not result.ok:
        raise UpdateError((result.output or "读取本地镜像失败").strip()[:300])

    line = next((row for row in reversed(result.output.splitlines()) if row.strip().startswith("[")), "")
    if not line:
        return []
    try:
        values = json.loads(line)
    except ValueError:
        return []
    return [value for value in values if isinstance(value, str)]


def _pick_local_digest(digests: list[str], image: ImageRef) -> str | None:
    for value in digests:
        parsed = _safe_parse(value)
        if parsed and parsed.digest and parsed.repository == image.repository:
            return parsed.digest
    for value in digests:
        parsed = _safe_parse(value)
        if parsed and parsed.digest:
            return parsed.digest
    return None


def check_registry(config: ProjectUpdateConfig, server: Server, images: list[str], project_name: str) -> CheckResult:
    image_ref = config.image_ref or preferred_image(project_name, images)
    if not image_ref:
        raise UpdateError("未配置镜像引用,项目也还没有采集到镜像")

    image = parse_image_ref(image_ref)
    if image.digest:
        return CheckResult(
            status="up_to_date",
            current_version=image.digest,
            latest_version=image.digest,
            detail="镜像已按 digest 固定,不会漂移;需要升级时请修改镜像引用",
            extra={"image": image.canonical},
        )

    local = _pick_local_digest(local_image_digests(server, image_ref), image)
    if not local:
        raise UpdateError("本地镜像没有仓库 digest,可能是本地构建;这类项目应使用 Git 来源")

    remote = fetch_registry_digest(image)
    same = local == remote
    detail = (
        f"标签 {image.tag}: {local[:19]}… 与远端一致"
        if same
        else f"标签 {image.tag}: 本地 {local[:19]}… → 远端 {remote[:19]}…"
    )
    return CheckResult(
        status="up_to_date" if same else "update_available",
        current_version=local,
        latest_version=remote,
        detail=detail,
        extra={
            "image": image.canonical,
            "tag": image.tag,
            "local_digest": local,
            "remote_digest": remote,
        },
    )


# ---------------------------------------------------------------- Release


def _github_headers() -> dict[str, str]:
    headers = {
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "OpsDeck/0.3",
    }
    if settings.github_token:
        headers["Authorization"] = f"Bearer {settings.github_token}"
    return headers


def fetch_latest_release(repo: str) -> dict[str, Any]:
    """读取 GitHub 最新 Release;没有 Release 时退回第一个 tag。"""
    try:
        with httpx.Client(timeout=20, follow_redirects=True, headers=_github_headers()) as client:
            response = client.get(f"{GITHUB_API}/repos/{repo}/releases/latest")

            if response.status_code == 404:
                tags = client.get(f"{GITHUB_API}/repos/{repo}/tags", params={"per_page": 1})
                if tags.status_code == 404:
                    raise UpdateError(f"GitHub 仓库不存在或不可见: {repo}")
                if tags.status_code != 200:
                    raise UpdateError(f"读取 GitHub tags 失败(HTTP {tags.status_code})")
                items = tags.json()
                if not items:
                    raise UpdateError(f"仓库 {repo} 没有任何 tag")
                tag = items[0]
                return {
                    "tag": tag.get("name", ""),
                    "name": tag.get("name", ""),
                    "url": f"https://github.com/{repo}/tags",
                    "published_at": None,
                    "notes": "",
                }

            if response.status_code == 403:
                remaining = response.headers.get("x-ratelimit-remaining")
                if remaining == "0":
                    raise UpdateError("GitHub API 触发限流;请配置 GITHUB_TOKEN 后重试")
                raise UpdateError("GitHub 拒绝访问(HTTP 403),仓库可能是私有的")
            if response.status_code != 200:
                raise UpdateError(f"读取 GitHub Release 失败(HTTP {response.status_code})")

            payload = response.json()
    except httpx.HTTPError as exc:
        raise UpdateError(f"无法访问 GitHub: {exc}") from exc

    tag = payload.get("tag_name") or ""
    if not tag:
        raise UpdateError("GitHub Release 没有 tag")
    return {
        "tag": tag,
        "name": payload.get("name") or tag,
        "url": payload.get("html_url") or f"https://github.com/{repo}/releases",
        "published_at": payload.get("published_at"),
        "notes": (payload.get("body") or "")[:4000],
    }


def check_release(
    config: ProjectUpdateConfig,
    project: Project,
    images: list[str],
) -> CheckResult:
    repo = normalize_github_repo(config.upstream_repo)
    release = fetch_latest_release(repo)
    latest = release["tag"]
    current = config.current_version or infer_current_version(project.name, images, repo)

    extra = {
        "repo": repo,
        "release_name": release["name"],
        "published_at": release["published_at"],
        "notes": release["notes"],
    }

    if not current:
        return CheckResult(
            status="unknown",
            current_version=None,
            latest_version=latest,
            detail=f"最新版本 {latest};未能从部署镜像识别当前版本,请填写当前版本",
            release_url=release["url"],
            extra=extra,
        )

    comparison = compare_versions(current, latest)
    if comparison is None:
        same_text = current.strip().lower().removeprefix("v") == latest.strip().lower().removeprefix("v")
        return CheckResult(
            status="up_to_date" if same_text else "unknown",
            current_version=current,
            latest_version=latest,
            detail=(
                f"当前 {current},最新 {latest}"
                if same_text
                else f"当前 {current},最新 {latest};版本号格式不同,无法自动比较"
            ),
            release_url=release["url"],
            extra=extra,
        )

    if comparison >= 0:
        detail = f"当前 {current} 已是最高版本(最新 Release: {latest})"
        status = "up_to_date"
    else:
        detail = f"当前 {current} → 最新 {latest}"
        status = "update_available"

    return CheckResult(
        status=status,
        current_version=current,
        latest_version=latest,
        detail=detail,
        release_url=release["url"],
        extra=extra,
    )


# ---------------------------------------------------------------- 对外入口


def check_update(
    config: ProjectUpdateConfig,
    project: Project,
    server: Server,
    images: list[str],
) -> CheckResult:
    """按来源类型执行检测。异常收敛为 check_failed,不向接口抛 500。"""
    try:
        if config.source_type == "git":
            return check_git(config, project, server)
        if config.source_type == "registry":
            return check_registry(config, server, images, project.name)
        if config.source_type == "release":
            return check_release(config, project, images)
        if config.source_type == "manual":
            return CheckResult(
                status="manual",
                current_version=config.current_version,
                latest_version=None,
                detail="手动更新来源,不自动检查",
            )
        raise UpdateError(f"未知的更新来源: {config.source_type}")
    except UpdateError as exc:
        return CheckResult(
            status="check_failed",
            current_version=config.current_version,
            latest_version=config.latest_version,
            detail=str(exc),
            extra=config.extra,
        )
    except Exception as exc:  # noqa: BLE001 - 检测失败不应打断整个页面
        logger.exception("更新检测异常: 项目 %s", project.name)
        return CheckResult(
            status="check_failed",
            current_version=config.current_version,
            latest_version=config.latest_version,
            detail=f"检测异常: {exc}",
            extra=config.extra,
        )


def detect_update_source(project: Project, server: Server, images: list[str]) -> dict[str, Any]:
    """自动识别更新来源,返回建议。不会写库,必须由人确认。"""
    # 1. 工作目录是 Git 仓库,且配置了 origin —— 本地构建项目最常见的情况。
    if project.work_dir:
        try:
            state = inspect_git(server, project.work_dir)
            if state.get("remote"):
                return {
                    "source_type": "git",
                    "repo_url": state["remote"],
                    "branch": state.get("branch") or None,
                    "current_version": state.get("head"),
                    "reason": f"工作目录 {project.work_dir} 是 Git 仓库,将从 origin 对比提交",
                    "images": images,
                }
        except UpdateError as exc:
            logger.info("自动识别 Git 来源失败(项目 %s): %s", project.name, exc)

    # 2. 能从镜像推断出 GitHub 仓库 —— 适合按 Release 发版的项目。
    upstream = guess_upstream_repo(images)
    if upstream:
        current = infer_current_version(project.name, images, upstream)
        image_ref = preferred_image(project.name, images)
        reason = f"从镜像推断上游仓库为 {upstream}"
        if current:
            reason += f",当前版本 {current}"
        return {
            "source_type": "release",
            "repo_url": f"https://github.com/{upstream}",
            "upstream_repo": upstream,
            "image_ref": image_ref,
            "current_version": current,
            "reason": reason,
            "images": images,
        }

    # 3. 有可用的远程镜像,但无法确定仓库 —— 交给用户补 GitHub 仓库,
    #    先建议 Registry(同一标签的 digest 对比)。
    image_ref = preferred_image(project.name, images)
    if image_ref:
        parsed = _safe_parse(image_ref)
        if parsed and parsed.registry != "docker.io":
            return {
                "source_type": "registry",
                "image_ref": image_ref,
                "reason": "项目使用远程镜像,但无法推断 GitHub 仓库;Registry 只能发现同一标签的 digest 变化",
                "images": images,
            }

    return {
        "source_type": "manual",
        "reason": "没有发现 Git 仓库或可追踪的远程镜像,建议手动维护版本",
        "images": images,
    }


def build_update_command(config: ProjectUpdateConfig, project: Project) -> str:
    """构造受控升级命令。命令只由来源类型决定,不接受前端传入。"""
    if config.source_type not in ("git", "registry"):
        raise UpdateError("Release / 手动来源不自动执行升级,请按发布说明人工操作")
    if not project.work_dir:
        raise UpdateError(f"项目 {project.name} 未配置工作目录,无法升级")

    work_dir = shlex.quote(project.work_dir)
    compose = "docker compose"
    if project.compose_file and project.compose_file != "docker-compose.yaml":
        compose += f" -f {shlex.quote(project.compose_file)}"

    if config.source_type == "git":
        return f"cd {work_dir} && git pull --ff-only && {compose} build && {compose} up -d"

    return f"cd {work_dir} && {compose} pull && {compose} up -d"
