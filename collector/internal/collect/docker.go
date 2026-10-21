package collect

import (
	"context"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"path"
	"regexp"
	"strings"
	"sync"
	"time"
)

const (
	maxPorts         = 50
	maxMounts        = 50
	maxEnvKeys       = 100
	maxWorkDir       = 512
	maxCompose       = 255
	maxPolicy        = 64
	maxImage         = 255
	maxImageDigest   = 128
	maxHealthDetail  = 500
	maxName          = 255
	maxShortText     = 32
)

// dockerPort 对应 /containers/json 的 Ports 元素。
// PublicPort 为 0 表示端口只在容器网络内暴露,没有映射到宿主机。
type dockerPort struct {
	IP          string `json:"IP"`
	PrivatePort int    `json:"PrivatePort"`
	PublicPort  int    `json:"PublicPort"`
	Type        string `json:"Type"`
}

// dockerContainer 对应 Docker API /containers/json 的元素。
//
// /containers/json 不返回 HostConfig,内存上限、挂载、重启策略等
// 运行配置需要通过 inspect 单独查询。
type dockerContainer struct {
	ID      string            `json:"Id"`
	Names   []string          `json:"Names"`
	Image   string            `json:"Image"`
	ImageID string            `json:"ImageID"`
	State   string            `json:"State"`
	Status  string            `json:"Status"`
	Labels  map[string]string `json:"Labels"`
	Ports   []dockerPort      `json:"Ports"`
}

// dockerMount 对应 inspect 返回的 Mounts 元素。RW 为 true 表示可写。
type dockerMount struct {
	Type        string `json:"Type"`
	Name        string `json:"Name"`
	Source      string `json:"Source"`
	Destination string `json:"Destination"`
	RW          bool   `json:"RW"`
}

// dockerHealth 对应 inspect 的 State.Health。只有配置了 HEALTHCHECK 才存在。
type dockerHealth struct {
	Status string `json:"Status"`
	Log    []struct {
		ExitCode int    `json:"ExitCode"`
		Output   string `json:"Output"`
	} `json:"Log"`
}

// dockerInspect 只解码需要的字段。
type dockerInspect struct {
	HostConfig struct {
		Memory        int64 `json:"Memory"`
		RestartPolicy struct {
			Name              string `json:"Name"`
			MaximumRetryCount int    `json:"MaximumRetryCount"`
		} `json:"RestartPolicy"`
	} `json:"HostConfig"`
	Config struct {
		Env []string `json:"Env"`
	} `json:"Config"`
	Mounts []dockerMount `json:"Mounts"`
	State  struct {
		ExitCode     int           `json:"ExitCode"`
		StartedAt    string        `json:"StartedAt"`
		FinishedAt   string        `json:"FinishedAt"`
		RestartCount int           `json:"RestartCount"`
		OOMKilled    bool          `json:"OOMKilled"`
		Health       *dockerHealth `json:"Health"`
	} `json:"State"`
}

// collectContainers 列出所有容器(含已停止的),并补充运行配置与内存占用。
func collectContainers(ctx context.Context, dockerHost string) ([]Instance, error) {
	client, baseURL, err := dockerClient(dockerHost)
	if err != nil {
		return nil, err
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, baseURL+"/containers/json?all=1", nil)
	if err != nil {
		return nil, err
	}

	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("docker API 返回 %d", resp.StatusCode)
	}

	var raw []dockerContainer
	if err := json.NewDecoder(resp.Body).Decode(&raw); err != nil {
		return nil, err
	}

	instances := make([]Instance, 0, len(raw))
	// 同一镜像通常被多个容器共用,RepoDigests 每个镜像只查一次。
	digestCache := make(map[string]string)
	running := make(map[string]struct{})

	for _, c := range raw {
		name := ""
		if len(c.Names) > 0 {
			name = strings.TrimPrefix(c.Names[0], "/")
		}

		inst := Instance{
			Name:    truncate(name, maxName),
			Project: truncate(strings.TrimSpace(c.Labels["com.docker.compose.project"]), 64),
			Image:   truncate(c.Image, maxImage),
			State:   truncate(c.State, maxShortText),
			Health:  truncate(parseHealth(c.Status), maxShortText),
			Ports:   mapPorts(c.Ports),
			// 只有 docker compose run 创建的容器才会带这个标签。普通 service 的
			// "跑完退出"与"被人工停止"在 Docker 侧无法区分,不能仅凭退出码猜测。
			OneOff: strings.EqualFold(strings.TrimSpace(c.Labels["com.docker.compose.oneoff"]), "true"),
			// 列表接口即可给出 Compose 路径,不依赖 inspect
			ComposeWorkingDir: bounded(
				strings.TrimSpace(c.Labels["com.docker.compose.project.working_dir"]), maxWorkDir,
			),
			ComposeFile: composeFile(c.Labels["com.docker.compose.project.config_files"]),
		}

		if c.ImageID != "" {
			digest, ok := digestCache[c.ImageID]
			if !ok {
				digest = resolveImageDigest(ctx, client, baseURL, c.ImageID)
				digestCache[c.ImageID] = digest
			}
			if digest != "" {
				inst.ImageDigest = &digest
			}
		}

		// 每个容器只 inspect 一次;失败时保留列表接口的端口与基础字段,
		// 其余字段留空(null),后端会保留上一轮的值。
		if info, ierr := inspectContainer(ctx, client, baseURL, c.ID); ierr == nil {
			limit := info.HostConfig.Memory / 1024 / 1024
			exit := info.State.ExitCode
			restarts := info.State.RestartCount
			oom := info.State.OOMKilled
			inst.MemLimitMB = &limit
			inst.ExitCode = &exit
			inst.RestartCount = &restarts
			inst.OOMKilled = &oom
			inst.StartedAt = normalizeDockerTime(info.State.StartedAt)
			inst.FinishedAt = normalizeDockerTime(info.State.FinishedAt)
			inst.HealthDetail = lastHealthOutput(info.State.Health)
			inst.RestartPolicy = formatRestartPolicy(
				info.HostConfig.RestartPolicy.Name, info.HostConfig.RestartPolicy.MaximumRetryCount,
			)
			inst.Mounts = mapMounts(info.Mounts)
			inst.EnvKeys = envKeys(info.Config.Env)
		}

		// 只有运行中的容器才有实际内存/CPU/IO;stopped 容器查询 stats 没有意义。
		if c.State == "running" {
			running[c.ID] = struct{}{}
			if stats, err := containerStatsFor(ctx, client, baseURL, c.ID); err == nil {
				inst.MemUsedMB = stats.MemUsedMB
				inst.CPUPercent = stats.CPUPercent
				inst.NetRxBps = stats.NetRxBps
				inst.NetTxBps = stats.NetTxBps
				inst.BlockReadBps = stats.BlockReadBps
				inst.BlockWriteBps = stats.BlockWriteBps
			}
		}

		instances = append(instances, inst)
	}

	pruneStatsCache(running)

	return instances, nil
}

// resolveImageDigest 取镜像的 registry digest(RepoDigests)。
// 本地构建的镜像没有 RepoDigests,返回空串,不上报猜测值。
func resolveImageDigest(ctx context.Context, client *http.Client, baseURL, imageID string) string {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, baseURL+"/images/"+imageID+"/json", nil)
	if err != nil {
		return ""
	}

	resp, err := client.Do(req)
	if err != nil {
		return ""
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return ""
	}

	var info struct {
		RepoDigests []string `json:"RepoDigests"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&info); err != nil {
		return ""
	}

	for _, ref := range info.RepoDigests {
		if _, digest, ok := strings.Cut(ref, "@"); ok && strings.HasPrefix(digest, "sha256:") {
			return truncate(digest, maxImageDigest)
		}
	}
	return ""
}

var ansiEscapeRE = regexp.MustCompile("\x1b\\[[0-9;]*[A-Za-z]")

// lastHealthOutput 取最近一条非空探测输出。健康检查可能配了多行脚本,
// 保留换行,由前端决定折行;控制字符与 ANSI 颜色在这里清掉。
func lastHealthOutput(health *dockerHealth) *string {
	if health == nil {
		return nil
	}
	for i := len(health.Log) - 1; i >= 0; i-- {
		out := sanitizeHealthOutput(health.Log[i].Output)
		if out != "" {
			return &out
		}
	}
	return nil
}

func sanitizeHealthOutput(raw string) string {
	raw = ansiEscapeRE.ReplaceAllString(raw, "")
	raw = strings.Map(func(r rune) rune {
		if r == '\n' || r == '\t' || r >= 32 {
			return r
		}
		return -1
	}, raw)
	return truncate(strings.TrimSpace(raw), maxHealthDetail)
}

// inspectContainer 查询容器的运行配置。
func inspectContainer(ctx context.Context, client *http.Client, baseURL, id string) (*dockerInspect, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, baseURL+"/containers/"+id+"/json", nil)
	if err != nil {
		return nil, err
	}

	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("docker inspect 返回 %d", resp.StatusCode)
	}

	var info dockerInspect
	if err := json.NewDecoder(resp.Body).Decode(&info); err != nil {
		return nil, err
	}
	return &info, nil
}

// containerStats 对应 Docker API /containers/{id}/stats 的所需字段。
type containerStats struct {
	CPUStats struct {
		CPUUsage struct {
			TotalUsage uint64 `json:"total_usage"`
		} `json:"cpu_usage"`
		SystemCPUUsage uint64 `json:"system_cpu_usage"`
		OnlineCPUs     uint32 `json:"online_cpus"`
	} `json:"cpu_stats"`
	PreCPUStats struct {
		CPUUsage struct {
			TotalUsage uint64 `json:"total_usage"`
		} `json:"cpu_usage"`
		SystemCPUUsage uint64 `json:"system_cpu_usage"`
	} `json:"precpu_stats"`
	MemoryStats struct {
		Usage int64 `json:"usage"`
		Limit int64 `json:"limit"`
		Stats struct {
			InactiveFile int64 `json:"inactive_file"`
		} `json:"stats"`
	} `json:"memory_stats"`
	Networks map[string]struct {
		RxBytes uint64 `json:"rx_bytes"`
		TxBytes uint64 `json:"tx_bytes"`
	} `json:"networks"`
	BlkioStats struct {
		IOServiceBytesRecursive []struct {
			Op    string `json:"op"`
			Value uint64 `json:"value"`
		} `json:"io_service_bytes_recursive"`
	} `json:"blkio_stats"`
}

// instanceStats 是一次容器资源采样。速率为 nil 表示没有上一帧基线。
type instanceStats struct {
	MemUsedMB     int64
	CPUPercent    *float64
	NetRxBps      *float64
	NetTxBps      *float64
	BlockReadBps  *float64
	BlockWriteBps *float64
}

type statsCounters struct {
	cpuTotal    uint64
	systemTotal uint64
	netRx       uint64
	netTx       uint64
	blockRead   uint64
	blockWrite  uint64
}

type statsSample struct {
	at       time.Time
	counters statsCounters
}

// 采集器是单进程单循环;这里保留上一帧计数器用于计算速率。
var statsBaseline = struct {
	sync.Mutex
	entries map[string]statsSample
}{entries: make(map[string]statsSample)}

// containerStatsFor 查询单个容器的内存、CPU、网络与块 IO。
// Docker 的 usage 含可回收的 page cache,减去 inactive_file 才接近真实占用。
func containerStatsFor(ctx context.Context, client *http.Client, baseURL, id string) (instanceStats, error) {
	var out instanceStats

	url := fmt.Sprintf("%s/containers/%s/stats?stream=false&one-shot=true", baseURL, id)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return out, err
	}

	resp, err := client.Do(req)
	if err != nil {
		return out, err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return out, fmt.Errorf("docker stats 返回 %d", resp.StatusCode)
	}

	var stats containerStats
	if err := json.NewDecoder(resp.Body).Decode(&stats); err != nil {
		return out, err
	}

	used := stats.MemoryStats.Usage - stats.MemoryStats.Stats.InactiveFile
	if used < 0 {
		used = stats.MemoryStats.Usage
	}
	out.MemUsedMB = used / 1024 / 1024

	counters := statsCounters{
		cpuTotal:    stats.CPUStats.CPUUsage.TotalUsage,
		systemTotal: stats.CPUStats.SystemCPUUsage,
	}
	for _, network := range stats.Networks {
		counters.netRx += network.RxBytes
		counters.netTx += network.TxBytes
	}
	for _, entry := range stats.BlkioStats.IOServiceBytesRecursive {
		switch strings.ToLower(entry.Op) {
		case "read":
			counters.blockRead += entry.Value
		case "write":
			counters.blockWrite += entry.Value
		}
	}

	now := time.Now()
	statsBaseline.Lock()
	previous, hasPrevious := statsBaseline.entries[id]
	statsBaseline.entries[id] = statsSample{at: now, counters: counters}
	statsBaseline.Unlock()

	if hasPrevious {
		seconds := now.Sub(previous.at).Seconds()
		out.NetRxBps = byteRate(counters.netRx, previous.counters.netRx, seconds)
		out.NetTxBps = byteRate(counters.netTx, previous.counters.netTx, seconds)
		out.BlockReadBps = byteRate(counters.blockRead, previous.counters.blockRead, seconds)
		out.BlockWriteBps = byteRate(counters.blockWrite, previous.counters.blockWrite, seconds)
		out.CPUPercent = cpuPercentBetween(
			counters.cpuTotal, previous.counters.cpuTotal,
			counters.systemTotal, previous.counters.systemTotal,
		)
	} else {
		// 第一次采样没有基线;如果 Docker 自带 preCPU 统计,先用它算 CPU。
		out.CPUPercent = cpuPercentBetween(
			counters.cpuTotal, stats.PreCPUStats.CPUUsage.TotalUsage,
			counters.systemTotal, stats.PreCPUStats.SystemCPUUsage,
		)
	}

	return out, nil
}

// cpuPercentBetween 用两次采样的 CPU 累计值算整机占比(0-100)。
// 任一侧计数回退(容器重启/计数器重置)都返回 nil,不编造 0。
func cpuPercentBetween(current, previous, systemCurrent, systemPrevious uint64) *float64 {
	if current < previous || systemCurrent <= systemPrevious {
		return nil
	}
	systemDelta := systemCurrent - systemPrevious
	if systemDelta == 0 {
		return nil
	}
	value := float64(current-previous) / float64(systemDelta) * 100
	if value < 0 {
		value = 0
	}
	if value > 100 {
		value = 100
	}
	return &value
}

// byteRate 把累计字节数换算成字节/秒。计数回退或时间窗非正时返回 nil。
func byteRate(current, previous uint64, seconds float64) *float64 {
	if seconds <= 0 || current < previous {
		return nil
	}
	value := float64(current-previous) / seconds
	return &value
}

func pruneStatsCache(running map[string]struct{}) {
	statsBaseline.Lock()
	defer statsBaseline.Unlock()
	for id := range statsBaseline.entries {
		if _, ok := running[id]; !ok {
			delete(statsBaseline.entries, id)
		}
	}
}

// mapPorts 把 Docker 端口映射整理成去重后的列表。
// 同一端口可能同时绑定 IPv4 与 IPv6,IP 不参与去重也不上报。
func mapPorts(raw []dockerPort) []Port {
	out := make([]Port, 0, len(raw))
	seen := make(map[string]struct{}, len(raw))
	for _, p := range raw {
		if p.PrivatePort <= 0 {
			continue
		}
		proto := p.Type
		if proto == "" {
			proto = "tcp"
		}
		item := Port{Host: p.PublicPort, Container: p.PrivatePort, Proto: proto}
		key := fmt.Sprintf("%d/%d/%s", item.Host, item.Container, item.Proto)
		if _, ok := seen[key]; ok {
			continue
		}
		seen[key] = struct{}{}
		out = append(out, item)
		if len(out) >= maxPorts {
			break
		}
	}
	return out
}

// mapMounts 把 inspect 的挂载信息转成稳定结构。RW=false 即只读。
func mapMounts(raw []dockerMount) []Mount {
	out := make([]Mount, 0, len(raw))
	for _, m := range raw {
		if m.Destination == "" {
			continue
		}
		out = append(out, Mount{
			Type:        truncate(m.Type, maxShortText),
			Name:        truncate(m.Name, 128),
			Source:      bounded(m.Source, maxWorkDir),
			Destination: bounded(m.Destination, maxWorkDir),
			Readonly:    !m.RW,
		})
		if len(out) >= maxMounts {
			break
		}
	}
	return out
}

// envKeys 只提取环境变量的键名。值可能包含密钥,绝不进入上报体。
func envKeys(env []string) []string {
	out := make([]string, 0, len(env))
	seen := make(map[string]struct{}, len(env))
	for _, entry := range env {
		key, _, _ := strings.Cut(entry, "=")
		key = strings.TrimSpace(key)
		if key == "" {
			continue
		}
		key = truncate(key, 255)
		if _, ok := seen[key]; ok {
			continue
		}
		seen[key] = struct{}{}
		out = append(out, key)
		if len(out) >= maxEnvKeys {
			break
		}
	}
	return out
}

// formatRestartPolicy 还原 Docker 的重启策略;on-failure 带重试次数。
func formatRestartPolicy(name string, maxRetry int) string {
	name = strings.TrimSpace(name)
	if name == "" {
		return ""
	}
	if name == "on-failure" && maxRetry > 0 {
		return truncate(fmt.Sprintf("on-failure:%d", maxRetry), maxPolicy)
	}
	return truncate(name, maxPolicy)
}

// composeFile 从 config_files 标签中取第一个文件的 basename。
func composeFile(raw string) string {
	first, _, _ := strings.Cut(raw, ",")
	first = strings.TrimSpace(first)
	if first == "" {
		return ""
	}
	return bounded(path.Base(first), maxCompose)
}

// normalizeDockerTime 校验 Docker 的时间格式,零值时间返回 nil,
// 避免把 0001-01-01T00:00:00Z 当成真实时间。运行中的容器 FinishedAt 正是这个零值。
func normalizeDockerTime(raw string) *string {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return nil
	}
	t, err := time.Parse(time.RFC3339Nano, raw)
	if err != nil || t.IsZero() || t.Year() <= 1 {
		return nil
	}
	s := t.UTC().Format(time.RFC3339Nano)
	return &s
}

// bounded 超长时返回空。路径类字段宁可缺失,也不要截断成另一个看起来合法的路径。
func bounded(value string, limit int) string {
	if len([]rune(value)) > limit {
		return ""
	}
	return value
}

// truncate 按字符数截断,用于名称、镜像、健康状态这类展示字段。
func truncate(value string, limit int) string {
	runes := []rune(value)
	if len(runes) <= limit {
		return value
	}
	return string(runes[:limit])
}

// dockerClient 构造访问 Docker socket 的 HTTP 客户端。
// 支持 unix:// 与 tcp:// 两种形式。
func dockerClient(dockerHost string) (*http.Client, string, error) {
	switch {
	case strings.HasPrefix(dockerHost, "unix://"):
		socketPath := strings.TrimPrefix(dockerHost, "unix://")
		transport := &http.Transport{
			DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
				var d net.Dialer
				return d.DialContext(ctx, "unix", socketPath)
			},
			DisableCompression: true,
		}
		return &http.Client{Transport: transport, Timeout: 10 * time.Second},
			"http://docker", nil

	case strings.HasPrefix(dockerHost, "tcp://"):
		base := "http://" + strings.TrimPrefix(dockerHost, "tcp://")
		return &http.Client{Timeout: 10 * time.Second}, base, nil

	default:
		return nil, "", fmt.Errorf("不支持的 docker host: %s", dockerHost)
	}
}

// parseHealth 从 Docker 的 Status 文本中提取健康状态。
// 形如 "Up 6 days (healthy)" → "healthy";无健康检查时返回 "none"。
func parseHealth(status string) string {
	open := strings.LastIndex(status, "(")
	if open < 0 || !strings.HasSuffix(status, ")") {
		if strings.HasPrefix(status, "Up") {
			return "running"
		}
		return "none"
	}
	return status[open+1 : len(status)-1]
}
