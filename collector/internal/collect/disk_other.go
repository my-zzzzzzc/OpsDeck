// 非 Linux 平台的占位实现,便于在 macOS 上做本地开发与测试。
//go:build !linux

package collect

// diskUsage 在非 Linux 平台不可用,返回零值,不影响其他指标采集。
func diskUsage(_ string) (usedGB, totalGB float64, err error) {
	return 0, 0, nil
}
