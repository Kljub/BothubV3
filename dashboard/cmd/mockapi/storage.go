package main

import (
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// Storage of the admin overview: what the data folder holds (database,
// plugins, Redis, the rest) and the space of its disk. Walking the folder
// costs a moment, so the numbers are kept for 5 minutes.

type storageInfo struct {
	DatabaseBytes  int64 `json:"databaseBytes"`
	PluginsBytes   int64 `json:"pluginsBytes"`
	RedisBytes     int64 `json:"redisBytes"`
	OtherBytes     int64 `json:"otherBytes"`
	DiskTotalBytes int64 `json:"diskTotalBytes"`
	DiskFreeBytes  int64 `json:"diskFreeBytes"`
}

var storageCache struct {
	mu   sync.Mutex
	at   time.Time
	info storageInfo
}

func dirSize(dir string) int64 {
	var n int64
	_ = filepath.WalkDir(dir, func(_ string, d fs.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		if !d.IsDir() {
			if fi, err := d.Info(); err == nil {
				n += fi.Size()
			}
		}
		return nil
	})
	return n
}

func storageStats() storageInfo {
	storageCache.mu.Lock()
	defer storageCache.mu.Unlock()
	if !storageCache.at.IsZero() && time.Since(storageCache.at) < 5*time.Minute {
		return storageCache.info
	}
	dir := envOr("DATA_DIR", "/data")
	var info storageInfo
	entries, _ := os.ReadDir(dir)
	for _, e := range entries {
		p := filepath.Join(dir, e.Name())
		size := int64(0)
		if e.IsDir() {
			size = dirSize(p)
		} else if fi, err := e.Info(); err == nil {
			size = fi.Size()
		}
		switch {
		case strings.HasPrefix(e.Name(), "bothub.sqlite"):
			info.DatabaseBytes += size
		case e.Name() == "plugins":
			info.PluginsBytes += size
		case e.Name() == "redis":
			info.RedisBytes += size
		default:
			info.OtherBytes += size
		}
	}
	info.DiskTotalBytes, info.DiskFreeBytes = diskSpace(dir)
	storageCache.at, storageCache.info = time.Now(), info
	return info
}
