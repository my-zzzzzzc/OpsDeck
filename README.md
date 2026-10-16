# OpsDeck

自用的**服务器与项目管理台**:统一查看多台机器上的服务状态,并接入 [Dify](https://dify.ai) 提供 AI 问答与排障能力。

面向运维与开发人员:一个界面看清"哪些服务在跑、资源用了多少、什么挂了、怎么重启"。

## 功能

| 模块 | 能力 |
|---|---|
| **资产** | 服务器与项目登记(路径、端口、URL、重启/升级命令、依赖、标签) |
| **观测** | 采集器上报 CPU/内存/Swap/磁盘/负载与容器状态,含内存用量与上限 |
| **告警** | 离线检测、资源阈值(内存/Swap/磁盘/CPU)、容器退出;自动去重与恢复 |
| **用户** | 三角色权限(管理员/运维/只读)、JWT 登录、操作审计 |
| **Dify** | 多应用登记、SSE 流式对话代理、工具接口让 AI 回查真实数据 |
| **操作** | 白名单运维操作(查看状态/日志、重启、启停),全部留痕 |

## 架构

```
被监控服务器                      OpsDeck 服务
┌──────────────────────┐         ┌────────────────────────────┐
│ opsdeck-collector    │  HTTPS  │ FastAPI                    │
│ (Go 单二进制, 只读)  │ ──────► │  ├─ 资产 / 观测 / 告警      │
│  · 读 /proc、sys     │  Token  │  ├─ 用户 / 审计             │
│  · 读 Docker socket  │         │  ├─ Dify 代理与工具接口     │
└──────────────────────┘         │  └─ 白名单操作执行          │
                                 │        │                    │
                                 │   PostgreSQL                │
                                 │   React SPA (后端托管)      │
                                 └────────────────────────────┘
                                            ▲
                                       Caddy (自动 HTTPS)
```

**采集与 AI 都不自己造轮子**:采集器只做只读上报,AI 能力全部交给 Dify。

## 快速开始(本地开发)

前置:Python 3.12+、[uv](https://docs.astral.sh/uv/)、Docker、Node 24 + pnpm。

```bash
# 1. 数据库
docker compose -f docker-compose.dev.yml up -d

# 2. 配置
cp .env.example .env
# 生成密钥并填入 SECRET_KEY: openssl rand -hex 32

# 3. 后端
uv sync
uv run alembic upgrade head
uv run uvicorn app.main:app --reload
# → http://127.0.0.1:8000/docs

# 4. 前端(另开终端)
cd frontend && pnpm install && pnpm dev
# → http://127.0.0.1:5173
```

首次启动会自动创建管理员。未设 `INITIAL_ADMIN_PASSWORD` 时会生成随机密码并**在终端打印一次**。

## 生产部署

前置:一台 2 核 4G 的机器、Docker、一个解析到该机器的域名。

```bash
cp .env.prod.example .env
# 必填: POSTGRES_PASSWORD、SECRET_KEY、SITE_ADDRESS
docker compose up -d --build
```

Caddy 会自动申请并续期 HTTPS 证书。内存占用约 320MB(数据库 100 + API 200 + Caddy 20)。

## 采集器

部署到每台被监控的服务器:

```bash
# 交叉编译(在开发机执行)
cd collector
GOOS=linux GOARCH=amd64 CGO_ENABLED=0 go build -o opsdeck-collector .

# 复制到目标服务器后运行
./opsdeck-collector \
  -endpoint https://opsdeck.example.com \
  -token <在界面「服务器详情」获取> \
  -interval 30s
```

单二进制约 6MB,常驻内存约 20MB。**只读**——不执行任何改变系统状态的命令。

建议用 systemd 托管:

```ini
[Unit]
Description=OpsDeck Collector
After=network.target docker.service

[Service]
ExecStart=/usr/local/bin/opsdeck-collector -endpoint https://opsdeck.example.com -token <TOKEN>
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
```

## 接入 Dify

1. 在 Dify 的应用页面进入「访问 API」,生成 API Key
2. 登录 OpsDeck → 「Dify」标签 → 登记应用(填 Key 与类型)
3. 点「测试」验证连通

之后前端可调用 `POST /api/chat/stream` 获得 SSE 流式对话。**API Key 只存在服务端**,不会下发给浏览器。

### 让 AI 能查真实数据

OpsDeck 提供一组只读工具接口(`/api/dify-tools/*`),让 Dify 应用能回答"内存用了多少""worker 为什么重启":

| 端点 | 用途 |
|---|---|
| `GET /api/dify-tools/summary` | 整体健康度概览 |
| `GET /api/dify-tools/servers` | 服务器状态与资源 |
| `GET /api/dify-tools/containers` | 容器列表与内存 |
| `GET /api/dify-tools/events` | 最近告警 |
| `GET /api/dify-tools/project?name=` | 项目部署信息与重启命令 |

在 Dify 的「自定义工具」中导入 `GET /api/dify-tools/openapi`,并在请求头加 `X-Tool-Token: <DIFY_TOOL_TOKEN>`。

## 权限模型

| 角色 | 查看 | 运维操作 | 资产管理 | 用户管理 |
|---|:---:|:---:|:---:|:---:|
| **admin** 管理员 | ✅ | ✅ | ✅ | ✅ |
| **operator** 运维 | ✅ | ✅ | ❌ | ❌ |
| **viewer** 只读 | ✅ | ❌ | ❌ | ❌ |

保护规则:
- 不能停用/降级/删除自己
- 系统必须保留至少一个管理员
- 失败登录与权限拒绝都写入审计

## 操作安全

**命令注入在架构上不可能**:请求只能传"项目 ID + 操作名",命令由后端白名单模板构造并做 shell 转义。

| 操作 | 风险 | 默认 |
|---|---|---|
| 查看状态 / 日志 | 无 | ✅ 启用 |
| 重启 / 启动 | 低 | ✅ 启用 |
| 停止 | 中 | ✅ 启用(需确认) |
| 拉取镜像 | 中 | ❌ **禁用** |
| 升级并重启 | 高 | ❌ **禁用** |

升级类操作默认关闭是刻意的:版本升级可能触发数据库迁移,失败会导致数据不一致,必须人工执行并先备份。

## 开发

```bash
make lint          # ruff
make test          # pytest
make type-check    # tsc(前端)
```

或直接:

```bash
uv run ruff check . && uv run ruff format --check .
uv run pytest -q
cd frontend && pnpm exec tsc --noEmit && pnpm build
```

## 项目结构

```
opsdeck/
├── app/
│   ├── main.py             应用入口、静态资源挂载
│   ├── config.py           配置(pydantic-settings)
│   ├── db.py               引擎与会话
│   ├── models.py           ORM 模型(11 张表)
│   ├── auth.py             密码、JWT、权限
│   ├── audit.py            审计写入
│   ├── actions.py          白名单操作目录与命令构造
│   ├── executor.py         SSH 执行器
│   ├── detection.py        告警检测与数据清理
│   ├── scheduler.py        内置后台调度
│   ├── dify.py             Dify 客户端
│   ├── api/                路由
│   │   ├── auth.py         登录与用户管理
│   │   ├── servers.py      服务器资产
│   │   ├── projects.py     项目资产
│   │   ├── observability.py 上报接收与查询
│   │   ├── chat.py         Dify 应用与对话代理
│   │   ├── dify_tools.py   供 Dify 调用的工具接口
│   │   ├── actions.py      白名单操作
│   │   └── audit.py        审计查询
│   └── schemas/            Pydantic 契约
├── collector/              Go 采集器
│   ├── main.go
│   └── internal/
│       ├── collect/        /proc 与 Docker 采集
│       └── report/         上报客户端
├── frontend/               React + TypeScript + Tailwind v4
├── tests/                  pytest
├── Dockerfile              多阶段构建(前端 + 后端)
├── docker-compose.yml      生产编排
├── Caddyfile               反向代理与自动 HTTPS
└── alembic/                数据库迁移
```

## 设计说明

- **前端设计令牌取自 [Dify UI](https://github.com/langgenius/dify)**,而非自造配色,保证视觉一致性并支持深浅色自动切换。
- **不引入 Celery/Redis**:告警检测与数据清理用进程内 `asyncio` 任务,自用规模下够用且少两个中间件。
- **采集器与用户鉴权分离**:采集器用 `X-Agent-Token`(机器身份),用户用 JWT(人的身份)。
- **Dify 工具接口用独立令牌**:Dify 是机器调用方,不应持有某个用户的长期凭据。
