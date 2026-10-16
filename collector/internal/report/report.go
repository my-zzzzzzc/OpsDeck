// Package report 负责把采集结果上报到 OpsDeck。
package report

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"time"

	"github.com/opsdeck/collector/internal/collect"
)

// Client 是上报客户端。
type Client struct {
	endpoint string
	token    string
	version  string
	http     *http.Client
}

// NewClient 构造上报客户端。endpoint 末尾的斜杠会被去掉。
func NewClient(endpoint, token, version string) *Client {
	for len(endpoint) > 0 && endpoint[len(endpoint)-1] == '/' {
		endpoint = endpoint[:len(endpoint)-1]
	}
	return &Client{
		endpoint: endpoint,
		token:    token,
		version:  version,
		http:     &http.Client{Timeout: 20 * time.Second},
	}
}

type reportPayload struct {
	*collect.Snapshot
	AgentVersion string `json:"agent_version"`
}

// Send 上报一次快照。非 2xx 响应视为失败并返回错误。
func (c *Client) Send(ctx context.Context, snapshot *collect.Snapshot) error {
	body, err := json.Marshal(reportPayload{Snapshot: snapshot, AgentVersion: c.version})
	if err != nil {
		return fmt.Errorf("序列化失败: %w", err)
	}

	req, err := http.NewRequestWithContext(
		ctx, http.MethodPost, c.endpoint+"/api/ingest/report", bytes.NewReader(body),
	)
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Agent-Token", c.token)

	resp, err := c.http.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("上报被拒绝: HTTP %d", resp.StatusCode)
	}
	return nil
}
