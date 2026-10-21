"""应用配置。

所有配置项通过环境变量或 `.env` 文件提供,使用 pydantic-settings 校验。
"""

from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """OpsDeck 运行时配置。"""

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    # 数据库
    database_url: str = "postgresql+psycopg://opsdeck:opsdeck@localhost:5432/opsdeck"

    # 应用
    app_name: str = "OpsDeck"
    debug: bool = False
    log_level: str = "INFO"

    # 认证。secret_key 必须通过环境变量提供,不设默认值以免生产误用。
    secret_key: str = "dev-only-insecure-secret-change-me"
    access_token_expire_minutes: int = 60 * 12

    # 限流。Redis 可用时用 Redis 计数(多进程共享),否则降级为进程内计数。
    rate_limit_use_redis: bool = False
    redis_url: str = "redis://localhost:6379/0"

    # 终端安全
    # 是否允许通过 IP 白名单限制终端访问(默认关闭)
    terminal_ip_allowlist_enabled: bool = False
    terminal_ip_allowlist: str = ""
    # 终端空闲超时(秒)与硬上限(秒)
    terminal_idle_timeout: int = 900
    terminal_max_duration: int = 4 * 3600
    # 终端并发上限
    terminal_max_per_user: int = 3
    terminal_max_global: int = 5
    # 终端录制文件目录
    terminal_recording_dir: str = "recordings"
    # 会话录制保留天数与单文件上限(MB)
    terminal_recording_days: int = 7
    terminal_recording_max_mb: int = 10

    # 本地开发 SSH 密钥覆盖。服务器上记录的是容器内 POSIX 路径,
    # 在 Windows 开发机上不可读;覆盖目录按文件名映射到本机密钥。
    ssh_key_override_dir: str = ""
    # 服务器未配置 ssh_key_path 时使用的默认私钥;留空则用 OpenSSH 默认身份文件。
    ssh_default_key_path: str = ""

    # 首次启动时自动创建的管理员账号(仅当用户表为空时生效)
    initial_admin_username: str = "admin"
    initial_admin_password: str = ""

    # CORS:逗号分隔的来源列表
    cors_origins: str = "http://localhost:5173,http://127.0.0.1:5173"

    # Dify 接入。base_url 是 Dify 部署地址;具体应用在界面上登记(见 DifyApp 模型)。
    dify_base_url: str = ""
    dify_api_key: str = ""
    # 单次对话请求超时(秒)。Dify 首字可能较慢,给足余量。
    dify_timeout_seconds: int = 120
    # 是否允许 Dify 通过工具接口回查本系统数据
    dify_tools_enabled: bool = True
    # Dify 工具接口的访问令牌(留空则使用已登录用户的 JWT)
    dify_tool_token: str = ""

    # GitHub API 只读令牌。Release 检测不配置也能用,但未认证时每小时仅 60 次。
    github_token: str = ""

    # 前端构建产物目录。生产镜像中由 Dockerfile 复制到 /app/static。
    static_dir: str = "static"

    # 指标数据保留天数,超过由清理任务删除
    metric_retention_days: int = 30
    # 已处理事件的保留天数
    event_retention_days: int = 90
    # 是否启用内置后台调度(告警检测与数据清理)。
    # 本地开发若指向生产库,应设为 false,否则会重复跑检测并修改生产数据。
    scheduler_enabled: bool = True

    @property
    def terminal_ip_allowlist_list(self) -> list[str]:
        """解析终端 IP 白名单。"""
        return [ip.strip() for ip in self.terminal_ip_allowlist.split(",") if ip.strip()]

    @property
    def cors_origin_list(self) -> list[str]:
        """把逗号分隔的 CORS 配置解析为列表,忽略空白项。"""
        return [origin.strip() for origin in self.cors_origins.split(",") if origin.strip()]


@lru_cache
def get_settings() -> Settings:
    """返回进程内缓存的配置实例。"""
    return Settings()


settings = get_settings()
