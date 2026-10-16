// Package collect 采集本机资源指标与容器状态。
//
// 只使用只读数据源:Linux /proc、/sys,以及 Docker Engine API。
package collect

import (
	"bufio"
	"context"
	"os"
	"strconv"
	"strings"
	"time"
)

// Metrics 是一次资源快照。
type Metrics struct {
	CPUPercent  float64 `json:"cpu_percent"`
	MemUsedMB   int64   `json:"mem_used_mb"`
	MemTotalMB  int64   `json:"mem_total_mb"`
	SwapUsedMB  int64   `json:"swap_used_mb"`
	SwapTotalMB int64   `json:"swap_total_mb"`
	DiskUsedGB  float64 `json:"disk_used_gb"`
	DiskTotalGB float64 `json:"disk_total_gb"`
	Load1       float64 `json:"load_1"`
	Load5       float64 `json:"load_5"`
	Load15      float64 `json:"load_15"`
}

// Instance 是一个容器或进程实例。
//
// 注意:StartedAt 使用 *string 而非 time.Time —— 零值 time.Time 会序列化成
// 非法时间字符串 "" 而被后端契约拒绝,指针在未采集时直接省略该字段。
type Instance struct {
	Name       string  `json:"name"`
	Project    string  `json:"project"`
	Image      string  `json:"image"`
	State      string  `json:"state"`
	Health     string  `json:"health"`
	ExitCode   int     `json:"exit_code"`
	StartedAt  *string `json:"started_at,omitempty"`
	MemUsedMB  int64   `json:"mem_used_mb"`
	MemLimitMB int64   `json:"mem_limit_mb"`
}

// Host 是主机基本信息。
type Host struct {
	Hostname   string `json:"hostname"`
	OSInfo     string `json:"os_info"`
	CPUCores   int    `json:"cpu_cores"`
	MemTotalMB int64  `json:"mem_total_mb"`
}

// Snapshot 是单次采集的完整结果。
type Snapshot struct {
	Host      Host       `json:"host"`
	Metrics   Metrics    `json:"metrics"`
	Instances []Instance `json:"instances"`
	Captured  time.Time  `json:"captured_at"`
}

// Take 采集主机、指标与容器,返回一次完整快照。
//
// 容器采集失败不会导致整体失败:主机指标仍然上报,只在 Instances 上体现为空。
func Take(ctx context.Context, dockerHost string) (*Snapshot, error) {
	host := collectHost()
	metrics, err := collectMetrics()
	if err != nil {
		return nil, err
	}

	instances := []Instance{}
	if dockerHost != "" {
		if list, derr := collectContainers(ctx, dockerHost); derr == nil {
			instances = list
		}
	}

	return &Snapshot{
		Host:      host,
		Metrics:   metrics,
		Instances: instances,
		Captured:  time.Now().UTC(),
	}, nil
}

// ---------------------------------------------------------------- 主机信息

func collectHost() Host {
	hostname, _ := os.Hostname()

	h := Host{
		Hostname: hostname,
		OSInfo:   readOSInfo(),
		CPUCores: numCPU(),
	}

	if mem, err := readMemInfo(); err == nil {
		h.MemTotalMB = mem.total
	}
	return h
}

// readOSInfo 从 /etc/os-release 读取可读的系统名。
func readOSInfo() string {
	f, err := os.Open("/etc/os-release")
	if err != nil {
		return ""
	}
	defer f.Close()

	scanner := bufio.NewScanner(f)
	for scanner.Scan() {
		line := scanner.Text()
		if name, ok := strings.CutPrefix(line, "PRETTY_NAME="); ok {
			return strings.Trim(name, `"`)
		}
	}
	return ""
}

// numCPU 统计 /proc/stat 中的 cpuN 行数,避免依赖 cgo。
func numCPU() int {
	f, err := os.Open("/proc/stat")
	if err != nil {
		return 0
	}
	defer f.Close()

	count := 0
	scanner := bufio.NewScanner(f)
	for scanner.Scan() {
		if strings.HasPrefix(scanner.Text(), "cpu") && !strings.HasPrefix(scanner.Text(), "cpu ") {
			count++
		}
	}
	return count
}

// ---------------------------------------------------------------- 指标

type memInfo struct {
	total     int64
	available int64
	swapTotal int64
	swapFree  int64
}

// readMemInfo 解析 /proc/meminfo,单位统一转为 MB。
func readMemInfo() (memInfo, error) {
	f, err := os.Open("/proc/meminfo")
	if err != nil {
		return memInfo{}, err
	}
	defer f.Close()

	var m memInfo
	scanner := bufio.NewScanner(f)
	for scanner.Scan() {
		fields := strings.Fields(scanner.Text())
		if len(fields) < 2 {
			continue
		}
		// /proc/meminfo 以 kB 为单位
		value, err := strconv.ParseInt(fields[1], 10, 64)
		if err != nil {
			continue
		}
		mb := value / 1024

		switch strings.TrimSuffix(fields[0], ":") {
		case "MemTotal":
			m.total = mb
		case "MemAvailable":
			m.available = mb
		case "SwapTotal":
			m.swapTotal = mb
		case "SwapFree":
			m.swapFree = mb
		}
	}
	return m, nil
}

// collectMetrics 采集 CPU、内存、swap、磁盘与负载。
func collectMetrics() (Metrics, error) {
	var m Metrics

	mem, err := readMemInfo()
	if err != nil {
		return m, err
	}
	m.MemTotalMB = mem.total
	m.MemUsedMB = mem.total - mem.available
	m.SwapTotalMB = mem.swapTotal
	m.SwapUsedMB = mem.swapTotal - mem.swapFree

	if used, total, err := diskUsage("/"); err == nil {
		m.DiskUsedGB = used
		m.DiskTotalGB = total
	}

	m.Load1, m.Load5, m.Load15 = readLoadAvg()

	// CPU 使用率需要两次采样求差
	if pct, err := cpuPercent(200 * time.Millisecond); err == nil {
		m.CPUPercent = pct
	}

	return m, nil
}

// readLoadAvg 读取 /proc/loadavg 的 1/5/15 分钟负载。
func readLoadAvg() (float64, float64, float64) {
	data, err := os.ReadFile("/proc/loadavg")
	if err != nil {
		return 0, 0, 0
	}
	fields := strings.Fields(string(data))
	if len(fields) < 3 {
		return 0, 0, 0
	}
	l1, _ := strconv.ParseFloat(fields[0], 64)
	l5, _ := strconv.ParseFloat(fields[1], 64)
	l15, _ := strconv.ParseFloat(fields[2], 64)
	return l1, l5, l15
}

type cpuTimes struct {
	idle  uint64
	total uint64
}

// readCPUTimes 汇总 /proc/stat 第一行的各 CPU 时间片。
func readCPUTimes() (cpuTimes, error) {
	f, err := os.Open("/proc/stat")
	if err != nil {
		return cpuTimes{}, err
	}
	defer f.Close()

	scanner := bufio.NewScanner(f)
	for scanner.Scan() {
		line := scanner.Text()
		if !strings.HasPrefix(line, "cpu ") {
			continue
		}
		fields := strings.Fields(line)[1:]
		var total, idle uint64
		for i, fv := range fields {
			v, err := strconv.ParseUint(fv, 10, 64)
			if err != nil {
				continue
			}
			total += v
			// user,nice,system,idle,iowait,... → idle 在第 4 位, iowait 第 5 位
			if i == 3 || i == 4 {
				idle += v
			}
		}
		return cpuTimes{idle: idle, total: total}, nil
	}
	return cpuTimes{}, os.ErrNotExist
}

// cpuPercent 通过两次采样计算 CPU 使用率。
func cpuPercent(sample time.Duration) (float64, error) {
	first, err := readCPUTimes()
	if err != nil {
		return 0, err
	}
	time.Sleep(sample)
	second, err := readCPUTimes()
	if err != nil {
		return 0, err
	}

	totalDelta := float64(second.total - first.total)
	idleDelta := float64(second.idle - first.idle)
	if totalDelta <= 0 {
		return 0, nil
	}

	pct := (totalDelta - idleDelta) / totalDelta * 100
	if pct < 0 {
		pct = 0
	}
	if pct > 100 {
		pct = 100
	}
	return pct, nil
}
