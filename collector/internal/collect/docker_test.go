package collect

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestComposeFileTakesFirstBasename(t *testing.T) {
	cases := map[string]string{
		"/opt/app/docker-compose.yml":                       "docker-compose.yml",
		"/opt/app/docker-compose.yml,/opt/app/override.yml": "docker-compose.yml",
		"compose.yaml": "compose.yaml",
		"":             "",
		"   ":          "",
	}
	for raw, want := range cases {
		if got := composeFile(raw); got != want {
			t.Fatalf("composeFile(%q) = %q, want %q", raw, got, want)
		}
	}
}

func TestMapPortsDeduplicatesIPv4AndIPv6(t *testing.T) {
	got := mapPorts([]dockerPort{
		{IP: "0.0.0.0", PrivatePort: 80, PublicPort: 8080, Type: "tcp"},
		{IP: "::", PrivatePort: 80, PublicPort: 8080, Type: "tcp"},
		{IP: "0.0.0.0", PrivatePort: 5432, Type: "tcp"},
		{PrivatePort: 0, PublicPort: 9999, Type: "tcp"},
	})

	if len(got) != 2 {
		t.Fatalf("expected 2 ports, got %d: %+v", len(got), got)
	}
	if got[0] != (Port{Host: 8080, Container: 80, Proto: "tcp"}) {
		t.Fatalf("unexpected first port: %+v", got[0])
	}
	if got[1].Host != 0 || got[1].Container != 5432 {
		t.Fatalf("unexpected second port: %+v", got[1])
	}
}

func TestEnvKeysNeverIncludeValues(t *testing.T) {
	keys := envKeys([]string{"DB_PASSWORD=secret", "DB_PASSWORD=again", "EMPTY=", "NOEQUALS"})
	want := []string{"DB_PASSWORD", "EMPTY", "NOEQUALS"}
	if len(keys) != len(want) {
		t.Fatalf("keys = %v, want %v", keys, want)
	}
	for i := range want {
		if keys[i] != want[i] {
			t.Fatalf("keys = %v, want %v", keys, want)
		}
	}

	encoded, err := json.Marshal(keys)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(encoded), "secret") {
		t.Fatalf("环境变量值泄露到上报体: %s", encoded)
	}
}

func TestMapMountsReadonlyAndLimit(t *testing.T) {
	mounts := make([]dockerMount, 0, maxMounts+5)
	for i := 0; i < maxMounts+5; i++ {
		mounts = append(mounts, dockerMount{
			Type:        "bind",
			Source:      "/data",
			Destination: "/app/data",
			RW:          i%2 == 0,
		})
	}
	got := mapMounts(mounts)
	if len(got) != maxMounts {
		t.Fatalf("expected cap %d, got %d", maxMounts, len(got))
	}
	if got[0].Readonly {
		t.Fatal("RW=true should map to Readonly=false")
	}
	if !got[1].Readonly {
		t.Fatal("RW=false should map to Readonly=true")
	}
}

func TestFormatRestartPolicy(t *testing.T) {
	if got := formatRestartPolicy("on-failure", 3); got != "on-failure:3" {
		t.Fatalf("got %q", got)
	}
	if got := formatRestartPolicy("always", 0); got != "always" {
		t.Fatalf("got %q", got)
	}
	if got := formatRestartPolicy("", 0); got != "" {
		t.Fatalf("got %q", got)
	}
}

func TestNormalizeDockerTimeDropsZeroTime(t *testing.T) {
	if normalizeDockerTime("") != nil {
		t.Fatal("empty time should be omitted")
	}
	if normalizeDockerTime("0001-01-01T00:00:00Z") != nil {
		t.Fatal("zero time should be omitted")
	}
	got := normalizeDockerTime("2026-10-20T10:00:00.123456789Z")
	if got == nil || *got != "2026-10-20T10:00:00.123456789Z" {
		t.Fatalf("unexpected started_at: %v", got)
	}
}

func TestCollectContainersFallsBackWhenInspectFails(t *testing.T) {
	statsBaseline.Lock()
	statsBaseline.entries = make(map[string]statsSample)
	statsBaseline.Unlock()

	mux := http.NewServeMux()
	mux.HandleFunc("/containers/json", func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode([]dockerContainer{
			{
				ID:      "abc",
				Names:   []string{"/api"},
				Image:   "langgenius/dify-api:latest",
				ImageID: "sha256:image1",
				State:   "running",
				Status:  "Up 2 hours (healthy)",
				Labels: map[string]string{
					"com.docker.compose.project":              "dify",
					"com.docker.compose.project.working_dir":  "/opt/dify/docker",
					"com.docker.compose.project.config_files": "/opt/dify/docker/docker-compose.yaml,/opt/dify/docker/override.yaml",
				},
				Ports: []dockerPort{{PrivatePort: 5001, PublicPort: 5001, Type: "tcp"}},
			},
			{
				ID:     "def",
				Names:  []string{"/worker"},
				State:  "exited",
				Status: "Exited (137) 2 hours ago",
				Labels: map[string]string{"com.docker.compose.project": "dify"},
			},
		})
	})
	mux.HandleFunc("/images/sha256:image1/json", func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"RepoDigests": ["langgenius/dify-api@sha256:abcdef1234567890"]}`))
	})
	mux.HandleFunc("/containers/abc/json", func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{
			"HostConfig": {"Memory": 536870912, "RestartPolicy": {"Name": "on-failure", "MaximumRetryCount": 3}},
			"Config": {"Env": ["PATH=/usr/bin", "DB_PASSWORD=secret"]},
			"Mounts": [{"Type": "bind", "Source": "/opt/dify/data", "Destination": "/data", "RW": false}],
			"State": {
				"ExitCode": 0,
				"StartedAt": "2026-10-20T10:00:00Z",
				"FinishedAt": "0001-01-01T00:00:00Z",
				"RestartCount": 2,
				"OOMKilled": false,
				"Health": {"Status": "healthy", "Log": [{"ExitCode": 0, "Output": "\u001b[32mok\u001b[0m\n"}]}
			}
		}`))
	})
	mux.HandleFunc("/containers/def/json", func(w http.ResponseWriter, _ *http.Request) {
		http.Error(w, "inspect failed", http.StatusInternalServerError)
	})
	mux.HandleFunc("/containers/abc/stats", func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{
			"cpu_stats": {"cpu_usage": {"total_usage": 1500}, "system_cpu_usage": 20000, "online_cpus": 2},
			"precpu_stats": {"cpu_usage": {"total_usage": 1000}, "system_cpu_usage": 10000},
			"memory_stats": {"usage": 104857600, "stats": {"inactive_file": 10485760}},
			"networks": {"eth0": {"rx_bytes": 1000, "tx_bytes": 2000}},
			"blkio_stats": {"io_service_bytes_recursive": [{"op": "Read", "value": 3000}, {"op": "Write", "value": 4000}]}
		}`))
	})

	server := httptest.NewServer(mux)
	defer server.Close()

	instances, err := collectContainers(context.Background(), "tcp://"+strings.TrimPrefix(server.URL, "http://"))
	if err != nil {
		t.Fatal(err)
	}
	if len(instances) != 2 {
		t.Fatalf("expected 2 instances, got %d", len(instances))
	}

	api := instances[0]
	if api.Name != "api" || api.Project != "dify" || api.Health != "healthy" {
		t.Fatalf("unexpected base fields: %+v", api)
	}
	if api.ComposeWorkingDir != "/opt/dify/docker" || api.ComposeFile != "docker-compose.yaml" {
		t.Fatalf("unexpected compose fields: %+v", api)
	}
	if api.MemLimitMB == nil || *api.MemLimitMB != 512 {
		t.Fatalf("unexpected mem limit: %v", api.MemLimitMB)
	}
	if api.MemUsedMB != 90 {
		t.Fatalf("unexpected mem used: %d", api.MemUsedMB)
	}
	if api.RestartPolicy != "on-failure:3" {
		t.Fatalf("unexpected restart policy: %q", api.RestartPolicy)
	}
	if len(api.Mounts) != 1 || !api.Mounts[0].Readonly {
		t.Fatalf("unexpected mounts: %+v", api.Mounts)
	}
	if len(api.EnvKeys) != 2 || api.EnvKeys[0] != "PATH" || api.EnvKeys[1] != "DB_PASSWORD" {
		t.Fatalf("unexpected env keys: %+v", api.EnvKeys)
	}
	if api.ExitCode == nil || *api.ExitCode != 0 {
		t.Fatalf("unexpected exit code: %v", api.ExitCode)
	}
	if api.StartedAt == nil || *api.StartedAt != "2026-10-20T10:00:00Z" {
		t.Fatalf("unexpected started_at: %v", api.StartedAt)
	}
	if api.FinishedAt != nil {
		t.Fatalf("运行中的容器不应上报退出时间, got %v", *api.FinishedAt)
	}
	if api.RestartCount == nil || *api.RestartCount != 2 {
		t.Fatalf("unexpected restart count: %v", api.RestartCount)
	}
	if api.OOMKilled == nil || *api.OOMKilled {
		t.Fatalf("OOMKilled=false 也应上报, got %v", api.OOMKilled)
	}
	if api.ImageDigest == nil || *api.ImageDigest != "sha256:abcdef1234567890" {
		t.Fatalf("unexpected image digest: %v", api.ImageDigest)
	}
	if api.HealthDetail == nil || *api.HealthDetail != "ok" {
		t.Fatalf("健康检查输出应去掉 ANSI 控制符, got %v", api.HealthDetail)
	}
	if api.OneOff {
		t.Fatal("普通 compose service 不应标记为一次性任务")
	}
	// 第一帧没有速率基线;CPU 用 Docker 的 preCPU 统计兜底。
	if api.CPUPercent == nil || *api.CPUPercent != 5 {
		t.Fatalf("unexpected cpu percent: %v", api.CPUPercent)
	}
	if api.NetRxBps != nil || api.NetTxBps != nil || api.BlockReadBps != nil || api.BlockWriteBps != nil {
		t.Fatalf("第一帧不应编造 IO 速率: %+v", api)
	}

	worker := instances[1]
	if worker.State != "exited" {
		t.Fatalf("unexpected state: %+v", worker)
	}
	if worker.Ports == nil {
		t.Fatal("端口列表应始终上报数组,便于后端清空旧值")
	}
	if worker.Mounts != nil || worker.EnvKeys != nil || worker.ExitCode != nil {
		t.Fatalf("inspect 失败时应省略运行配置, got %+v", worker)
	}
	if worker.RestartPolicy != "" || worker.StartedAt != nil {
		t.Fatalf("inspect 失败时不应上报运行策略, got %+v", worker)
	}
	if worker.RestartCount != nil || worker.OOMKilled != nil || worker.FinishedAt != nil {
		t.Fatalf("inspect 失败时不应上报崩溃字段, got %+v", worker)
	}
}

func TestCPUPercentBetween(t *testing.T) {
	if got := cpuPercentBetween(1500, 1000, 20000, 10000); got == nil || *got != 5 {
		t.Fatalf("expected 5%%, got %v", got)
	}
	if got := cpuPercentBetween(1000, 1500, 20000, 10000); got != nil {
		t.Fatalf("计数器回退时应返回 nil, got %v", *got)
	}
	if got := cpuPercentBetween(1500, 1000, 10000, 10000); got != nil {
		t.Fatalf("系统时间未推进时应返回 nil, got %v", *got)
	}
	if got := cpuPercentBetween(999999, 0, 100, 0); got == nil || *got != 100 {
		t.Fatalf("异常高值应收敛到 100, got %v", got)
	}
}

func TestByteRate(t *testing.T) {
	if got := byteRate(5000, 1000, 2); got == nil || *got != 2000 {
		t.Fatalf("expected 2000 B/s, got %v", got)
	}
	if got := byteRate(1000, 5000, 2); got != nil {
		t.Fatalf("计数器回退时应返回 nil, got %v", *got)
	}
	if got := byteRate(5000, 1000, 0); got != nil {
		t.Fatalf("时间窗为 0 时应返回 nil, got %v", *got)
	}
}

func TestSanitizeHealthOutput(t *testing.T) {
	got := sanitizeHealthOutput("\u001b[31mfail\u001b[0m: connect refused\r\n")
	if got != "fail: connect refused" {
		t.Fatalf("unexpected output: %q", got)
	}
	long := strings.Repeat("x", maxHealthDetail+20)
	if out := sanitizeHealthOutput(long); len([]rune(out)) != maxHealthDetail {
		t.Fatalf("健康检查输出应截断到 %d 字符, got %d", maxHealthDetail, len([]rune(out)))
	}
}

func TestLastHealthOutputPicksNewestNonEmpty(t *testing.T) {
	health := &dockerHealth{Log: []struct {
		ExitCode int    `json:"ExitCode"`
		Output   string `json:"Output"`
	}{
		{ExitCode: 1, Output: "old failure"},
		{ExitCode: 1, Output: "   "},
		{ExitCode: 1, Output: "latest failure"},
	}}
	got := lastHealthOutput(health)
	if got == nil || *got != "latest failure" {
		t.Fatalf("unexpected output: %v", got)
	}
	if lastHealthOutput(nil) != nil {
		t.Fatal("没有健康检查时应返回 nil")
	}
}
