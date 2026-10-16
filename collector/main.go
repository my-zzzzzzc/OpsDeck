// Command collector 采集本机资源与容器状态,周期性上报到 OpsDeck。
//
// 设计约束(见项目 README):
//   - 只读:不执行任何会改变系统状态的命令,不写入被监控主机。
//   - 最小依赖:仅需 Docker socket(只读)与 /proc、/sys。
//   - 幂等上报:失败只记日志并重试,不影响被监控主机。
package main

import (
	"context"
	"flag"
	"fmt"
	"log"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/opsdeck/collector/internal/collect"
	"github.com/opsdeck/collector/internal/report"
)

// version 由构建时的 -ldflags 注入。
var version = "dev"

func main() {
	var (
		endpoint   = flag.String("endpoint", envOr("OPSDECK_ENDPOINT", "http://127.0.0.1:8000"), "OpsDeck 服务地址")
		token      = flag.String("token", envOr("OPSDECK_TOKEN", ""), "服务器采集凭证(必填)")
		interval   = flag.Duration("interval", 30*time.Second, "上报间隔")
		once       = flag.Bool("once", false, "只采集并上报一次,然后退出")
		showVer    = flag.Bool("version", false, "打印版本后退出")
		dockerHost = flag.String("docker-host", envOr("DOCKER_HOST", "unix:///var/run/docker.sock"), "Docker socket 地址")
	)
	flag.Parse()

	if *showVer {
		fmt.Printf("opsdeck-collector %s\n", version)
		return
	}

	if *token == "" {
		log.Fatal("缺少采集凭证:请通过 -token 或 OPSDECK_TOKEN 提供")
	}

	reporter := report.NewClient(*endpoint, *token, version)

	// 一次上报:采集 → 发送。失败仅记录,不中断主循环。
	reportOnce := func(ctx context.Context) {
		snapshot, err := collect.Take(ctx, *dockerHost)
		if err != nil {
			log.Printf("采集失败: %v", err)
			return
		}
		if err := reporter.Send(ctx, snapshot); err != nil {
			log.Printf("上报失败: %v", err)
			return
		}
		log.Printf(
			"已上报 cpu=%.1f%% mem=%d/%dMB swap=%d/%dMB 容器=%d",
			snapshot.Metrics.CPUPercent,
			snapshot.Metrics.MemUsedMB, snapshot.Metrics.MemTotalMB,
			snapshot.Metrics.SwapUsedMB, snapshot.Metrics.SwapTotalMB,
			len(snapshot.Instances),
		)
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	if *once {
		reportOnce(ctx)
		return
	}

	log.Printf("opsdeck-collector %s 启动:上报到 %s,间隔 %s", version, *endpoint, *interval)
	reportOnce(ctx)

	ticker := time.NewTicker(*interval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			log.Println("收到退出信号,停止采集")
			return
		case <-ticker.C:
			reportOnce(ctx)
		}
	}
}

// envOr 返回环境变量值,为空时回退到默认值。
func envOr(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}
