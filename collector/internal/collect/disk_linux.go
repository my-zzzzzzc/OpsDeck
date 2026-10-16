// Linux 专属实现:通过 syscall.Statfs 读取磁盘容量。
//go:build linux

package collect

import "syscall"

// diskUsage 返回挂载点的已用与总容量(GB)。
func diskUsage(path string) (usedGB, totalGB float64, err error) {
	var st syscall.Statfs_t
	if err := syscall.Statfs(path, &st); err != nil {
		return 0, 0, err
	}

	const gb = 1024 * 1024 * 1024
	total := float64(st.Blocks) * float64(st.Bsize)
	free := float64(st.Bavail) * float64(st.Bsize)

	return (total - free) / gb, total / gb, nil
}
