# OpsDeck 开发命令
.PHONY: help dev-api dev-web db-up db-down migrate lint test type-check check build clean

help:
	@echo "OpsDeck 开发命令:"
	@echo "  make db-up        启动本地 PostgreSQL"
	@echo "  make db-down      停止本地 PostgreSQL"
	@echo "  make migrate      应用数据库迁移"
	@echo "  make dev-api      启动后端(热重载)"
	@echo "  make dev-web      启动前端(热重载)"
	@echo "  make collector    构建采集器(本机)"
	@echo "  make collector-linux 交叉编译 Linux 采集器"
	@echo "  make lint         代码检查与格式化"
	@echo "  make test         运行测试"
	@echo "  make type-check   前端类型检查"
	@echo "  make check        运行全部检查"
	@echo "  make build        构建前端产物"
	@echo "  make clean        清理构建产物"

db-up:
	docker compose -f docker-compose.dev.yml up -d

db-down:
	docker compose -f docker-compose.dev.yml down

migrate:
	uv run alembic upgrade head

dev-api:
	uv run uvicorn app.main:app --reload --host 127.0.0.1 --port 8000

dev-web:
	cd frontend && pnpm dev

collector:
	cd collector && go build -o ../bin/opsdeck-collector .

collector-linux:
	cd collector && GOOS=linux GOARCH=amd64 CGO_ENABLED=0 \
		go build -ldflags="-s -w" -o ../bin/opsdeck-collector-linux-amd64 .

lint:
	uv run ruff format .
	uv run ruff check --fix .
	cd collector && gofmt -w . && go vet ./...

test:
	uv run pytest -q

type-check:
	cd frontend && pnpm exec tsc --noEmit

check: lint test type-check
	uv run ruff format --check .
	uv run ruff check .
	cd collector && gofmt -l .

build:
	cd frontend && pnpm build

clean:
	rm -rf frontend/dist bin .pytest_cache .ruff_cache
	find . -name __pycache__ -type d -prune -exec rm -rf {} +
