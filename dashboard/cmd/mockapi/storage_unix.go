//go:build !windows

package main

import "syscall"

// diskSpace: size and free space of the disk holding dir (0, 0 when unknown).
func diskSpace(dir string) (total, free int64) {
	var st syscall.Statfs_t
	if syscall.Statfs(dir, &st) != nil {
		return 0, 0
	}
	return int64(st.Blocks) * int64(st.Bsize), int64(st.Bavail) * int64(st.Bsize)
}
