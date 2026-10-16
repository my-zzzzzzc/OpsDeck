package collect

import (
	"context"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"strings"
	"time"
)

// dockerContainer 对应 Docker API /containers/json 的元素。
//
// 注意:/containers/json 不返回 HostConfig.Memory(该字段属于 inspect 接口),
// 内存上限通过 containerMemLimitMB 单独查询。
type dockerContainer struct {
	ID     string            `json:"Id"`
	Names  []string          `json:"Names"`
	Image  string            `json:"Image"`
	State  string            `json:"State"`
	Status string            `json:"Status"`
	Labels map[string]string `json:"Labels"`
}

// collectContainers 列出所有容器(含已停止的),并补充内存占用。
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
	for _, c := range raw {
		name := ""
		if len(c.Names) > 0 {
			name = strings.TrimPrefix(c.Names[0], "/")
		}

		inst := Instance{
			Name:    name,
			Project: c.Labels["com.docker.compose.project"],
			Image:   c.Image,
			State:   c.State,
			Health:  parseHealth(c.Status),
		}

		// 运行中的容器才有意义查询内存;inspect 提供内存上限,stats 提供实际占用
		if c.State == "running" {
			if limit, err := containerMemLimitMB(ctx, client, baseURL, c.ID); err == nil {
				inst.MemLimitMB = limit
			}
			if used, err := containerMemUsedMB(ctx, client, baseURL, c.ID); err == nil {
				inst.MemUsedMB = used
			}
		}

		instances = append(instances, inst)
	}

	return instances, nil
}

// containerInspect 对应 Docker API /containers/{id}/json 的所需字段。
type containerInspect struct {
	HostConfig struct {
		Memory int64 `json:"Memory"`
	} `json:"HostConfig"`
}

// containerMemLimitMB 查询容器的内存上限(MB)。未设上限时 Docker 返回 0。
func containerMemLimitMB(ctx context.Context, client *http.Client, baseURL, id string) (int64, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, baseURL+"/containers/"+id+"/json", nil)
	if err != nil {
		return 0, err
	}

	resp, err := client.Do(req)
	if err != nil {
		return 0, err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return 0, fmt.Errorf("docker inspect 返回 %d", resp.StatusCode)
	}

	var info containerInspect
	if err := json.NewDecoder(resp.Body).Decode(&info); err != nil {
		return 0, err
	}
	return info.HostConfig.Memory / 1024 / 1024, nil
}

// containerStats 对应 Docker API /containers/{id}/stats 的所需字段。
type containerStats struct {
	MemoryStats struct {
		Usage int64 `json:"usage"`
		Stats struct {
			InactiveFile int64 `json:"inactive_file"`
		} `json:"stats"`
	} `json:"memory_stats"`
}

// containerMemUsedMB 查询单个容器的实际内存占用。
// Docker 的 usage 含可回收的 page cache,减去 inactive_file 才接近真实占用。
func containerMemUsedMB(ctx context.Context, client *http.Client, baseURL, id string) (int64, error) {
	url := fmt.Sprintf("%s/containers/%s/stats?stream=false&one-shot=true", baseURL, id)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return 0, err
	}

	resp, err := client.Do(req)
	if err != nil {
		return 0, err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return 0, fmt.Errorf("docker stats 返回 %d", resp.StatusCode)
	}

	var stats containerStats
	if err := json.NewDecoder(resp.Body).Decode(&stats); err != nil {
		return 0, err
	}

	used := stats.MemoryStats.Usage - stats.MemoryStats.Stats.InactiveFile
	if used < 0 {
		used = stats.MemoryStats.Usage
	}
	return used / 1024 / 1024, nil
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
