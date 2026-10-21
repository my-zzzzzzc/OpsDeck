"""部署接口:接管已有目录 / 从 Git 新建。

权限为 manage(仅管理员):部署会在目标机上创建目录、拉取代码、启动容器,
影响面远大于单个白名单操作。

安全边界:
  - 命令全部由 app.deploy 按来源构造,前端不能提交命令。
  - 执行前必须通过只读预检;执行时按 (服务器, 工作目录) 加锁,避免并发。
  - 命令成功后才会登记项目;失败也写入操作历史与审计。
"""

import logging
import threading
import uuid
from datetime import UTC, datetime

from fastapi import APIRouter, Depends, HTTPException, Request, status
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.audit import record_audit
from app.auth import client_ip, require
from app.db import get_db
from app.deploy import (
    DEPLOY_TIMEOUT,
    DeployError,
    DeploySpec,
    build_deploy_command,
    normalize_name,
    normalize_spec,
    run_preflight,
)
from app.discovery import normalized_work_dir
from app.executor import execute
from app.models import ActionLog, Project, ProjectUpdateConfig, Server, User
from app.schemas.assets import ProjectRead
from app.schemas.deployments import (
    DeployCheck,
    DeployPreflightRead,
    DeployPreflightRequest,
    DeployRequest,
    DeployResultRead,
)
from app.schemas.updates import UpdateConfigRead

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/deployments", tags=["deployments"])

# 同一目标目录不允许并发部署:两个请求同时 compose up 会互相覆盖容器。
_deploy_locks: dict[tuple[uuid.UUID, str], threading.Lock] = {}
_deploy_locks_guard = threading.Lock()


def _lock_for(server_id: uuid.UUID, work_dir: str) -> threading.Lock:
    with _deploy_locks_guard:
        return _deploy_locks.setdefault((server_id, work_dir), threading.Lock())


def _get_server_or_404(db: Session, server_id: uuid.UUID) -> Server:
    server = db.get(Server, server_id)
    if server is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="服务器不存在")
    return server


def _parse_spec(payload: DeployPreflightRequest) -> DeploySpec:
    try:
        return normalize_spec(
            payload.source,
            payload.work_dir,
            payload.compose_file,
            payload.repo_url,
            payload.branch,
        )
    except DeployError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from None


def _parse_name(value: str) -> str:
    try:
        return normalize_name(value)
    except DeployError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from None


def _project_with_name(db: Session, server_id: uuid.UUID, name: str) -> Project | None:
    return db.scalar(select(Project).where(Project.server_id == server_id, Project.name == name))


def _name_conflict_detail(project: Project) -> str:
    """同名冲突按生命周期给出不同的下一步,而不是笼统的「已存在」。"""
    if project.lifecycle == "discovered":
        return f"该服务器下存在同名未托管项目「{project.name}」,请先在项目页接管"
    if project.lifecycle == "ignored":
        return f"同名项目「{project.name}」已忽略,请先在项目页恢复并接管"
    return f"该服务器下项目名已存在: {project.name}"


def _project_with_work_dir(db: Session, server_id: uuid.UUID, work_dir: str) -> Project | None:
    """同一工作目录只允许一条项目记录,避免同栈出现两个资产。"""
    key = normalized_work_dir(work_dir)
    if key is None:
        return None
    candidates = db.scalars(
        select(Project).where(
            Project.server_id == server_id,
            Project.lifecycle.in_(("managed", "discovered")),
            Project.work_dir.is_not(None),
        )
    )
    for project in candidates:
        if normalized_work_dir(project.work_dir) == key:
            return project
    return None


def _work_dir_conflict_detail(project: Project) -> str:
    if project.lifecycle == "discovered":
        return f"工作目录已由未托管项目「{project.name}」使用,请先在项目页接管"
    return f"工作目录已被项目「{project.name}」使用"


@router.post("/preflight", response_model=DeployPreflightRead, summary="部署前检查")
def preflight(
    payload: DeployPreflightRequest,
    db: Session = Depends(get_db),
    _: User = Depends(require("manage")),
) -> DeployPreflightRead:
    """只读检查目标机环境,不创建目录、不拉代码、不启动容器。"""
    server = _get_server_or_404(db, payload.server_id)
    name = _parse_name(payload.name)
    spec = _parse_spec(payload)

    checks: list[DeployCheck] = []
    taken = _project_with_name(db, server.id, name)
    checks.append(
        DeployCheck(
            key="name",
            label="项目名",
            ok=taken is None,
            detail=_name_conflict_detail(taken) if taken is not None else f"可以使用:{name}",
        )
    )
    dir_taken = _project_with_work_dir(db, server.id, spec.work_dir)
    checks.append(
        DeployCheck(
            key="work_dir",
            label="工作目录",
            ok=dir_taken is None,
            detail=_work_dir_conflict_detail(dir_taken) if dir_taken is not None else f"可以使用:{spec.work_dir}",
        )
    )
    checks.extend(
        DeployCheck(key=check.key, label=check.label, ok=check.ok, detail=check.detail)
        for check in run_preflight(server, spec)
    )

    return DeployPreflightRead(
        ok=all(check.ok for check in checks),
        checks=checks,
        command=build_deploy_command(spec),
        work_dir=spec.work_dir,
    )


@router.post("", response_model=DeployResultRead, summary="执行部署")
def deploy(
    payload: DeployRequest,
    request: Request,
    db: Session = Depends(get_db),
    actor: User = Depends(require("manage")),
) -> DeployResultRead:
    """在目标机上执行部署,成功后登记项目。

    Git 来源会同时创建已确认的 Git 更新配置,部署完即可在「更新」页检查提交。
    """
    if not payload.confirm:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="执行部署需要显式确认")

    server = _get_server_or_404(db, payload.server_id)
    name = _parse_name(payload.name)
    spec = _parse_spec(payload)

    taken = _project_with_name(db, server.id, name)
    if taken is not None:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=_name_conflict_detail(taken))
    dir_taken = _project_with_work_dir(db, server.id, spec.work_dir)
    if dir_taken is not None:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=_work_dir_conflict_detail(dir_taken))

    lock = _lock_for(server.id, spec.work_dir)
    if not lock.acquire(blocking=False):
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="该目录正在部署,请稍后再试")

    try:
        # 预检通过才执行;预检本身只读,但能挡住目录不存在、Compose 配置错误等问题。
        failed = [check for check in run_preflight(server, spec) if not check.ok]
        if failed:
            detail = "部署前检查未通过:" + "; ".join(f"{check.label} - {check.detail}" for check in failed[:4])
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=detail)

        taken = _project_with_name(db, server.id, name)
        if taken is not None:
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=_name_conflict_detail(taken))
        dir_taken = _project_with_work_dir(db, server.id, spec.work_dir)
        if dir_taken is not None:
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=_work_dir_conflict_detail(dir_taken))

        command = build_deploy_command(spec)
        log = ActionLog(
            project_id=None,
            project_name=name,
            action="deploy",
            command=command,
            status="running",
            triggered_by="manual",
            user_id=actor.id,
            username=actor.username,
        )
        db.add(log)
        db.commit()
        db.refresh(log)

        # 执行期间不持有事务;构建可能持续数分钟。
        result = execute(server, command, timeout=DEPLOY_TIMEOUT)

        log.status = "success" if result.ok else "failed"
        log.output = result.output
        log.exit_code = result.exit_code
        log.finished_at = datetime.now(UTC)
        db.commit()

        project: Project | None = None
        config: ProjectUpdateConfig | None = None
        message = "部署完成,项目已登记"
        if spec.source == "git":
            message = "部署完成,项目已登记,并创建了 Git 更新来源"

        if not result.ok:
            message = f"部署失败(退出码 {result.exit_code}),请查看输出"
        elif (taken := _project_with_name(db, server.id, name)) is not None:
            message = f"部署命令已完成,但{_name_conflict_detail(taken)},未自动登记;请确认容器与项目列表"
        else:
            project = Project(
                server_id=server.id,
                name=name,
                lifecycle="managed",
                kind="docker-compose",
                work_dir=spec.work_dir,
                compose_file=spec.compose_file,
                url=(payload.url or "").strip() or None,
                note=(payload.note or "").strip() or None,
            )
            try:
                db.add(project)
                db.flush()

                # 部署日志最初没有 project_id(项目尚不存在);登记成功后补上关联,
                # 卡片才能显示这次部署。失败或未登记时保持为空,避免关联错项目。
                log.project_id = project.id

                if spec.source == "git":
                    config = ProjectUpdateConfig(
                        project_id=project.id,
                        source_type="git",
                        confirmed=True,
                        auto_detected=False,
                        repo_url=spec.repo_url,
                        branch=spec.branch,
                        status="unknown",
                        detail="部署时自动创建,尚未检查更新",
                    )
                    db.add(config)

                record_audit(
                    db,
                    user_id=actor.id,
                    username=actor.username,
                    action="execute",
                    target_type="project",
                    target_id=str(project.id),
                    target_name=name,
                    ip=client_ip(request),
                    success=True,
                    detail=f"部署({spec.source}): {command}",
                )
                db.commit()
            except IntegrityError:
                # 并发登记同名项目:部署本身已成功,不能把结果报成失败。
                db.rollback()
                project = None
                config = None
                message = "部署命令已完成,但同名项目在登记时已被创建;请确认容器与项目列表"
                record_audit(
                    db,
                    user_id=actor.id,
                    username=actor.username,
                    action="execute",
                    target_type="project",
                    target_name=name,
                    ip=client_ip(request),
                    success=True,
                    detail=f"部署({spec.source})成功但项目未登记: {command}",
                )
                db.commit()
            else:
                db.refresh(project)
                if config is not None:
                    db.refresh(config)

        if project is None:
            record_audit(
                db,
                user_id=actor.id,
                username=actor.username,
                action="execute",
                target_type="project",
                target_name=name,
                ip=client_ip(request),
                success=result.ok,
                detail=f"部署({spec.source}): {command}",
            )
            db.commit()

        logger.info(
            "部署%s: %s 在 %s 上 %s,操作人 %s",
            "完成" if result.ok else "失败",
            name,
            server.name,
            spec.source,
            actor.username,
        )

        return DeployResultRead(
            ok=result.ok,
            message=message,
            command=command,
            output=result.output,
            project=ProjectRead.model_validate(project) if project is not None else None,
            config=UpdateConfigRead.model_validate(config) if config is not None else None,
        )
    finally:
        lock.release()
