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

// Storage history for the overview chart: the data folder every 5 minutes,
// the last 7 days, kept in memory like the memory chart.
const storageEvery = 5 * time.Minute

type storageSample struct {
	t     time.Time
	bytes int64
}

type storageHistory struct {
	mu      sync.Mutex
	samples []storageSample
}

func (h *storageHistory) add(v storageSample) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.samples = append(h.samples, v)
	cut := 0
	for cut < len(h.samples) && v.t.Sub(h.samples[cut].t) > memKeep {
		cut++
	}
	h.samples = h.samples[cut:]
}

// stats: storage now plus the chart of [from, to] (at most 120 points), its average and peak.
func (h *storageHistory) stats(rng string, from, to time.Time) map[string]any {
	info := storageStats()
	used := info.DatabaseBytes + info.PluginsBytes + info.RedisBytes + info.OtherBytes
	h.mu.Lock()
	list := []storageSample{}
	for _, s := range h.samples {
		if !s.t.Before(from) && !s.t.After(to) {
			list = append(list, s)
		}
	}
	h.mu.Unlock()
	var sum, peak int64
	for _, s := range list {
		sum += s.bytes
		peak = max(peak, s.bytes)
	}
	avg := used
	if len(list) > 0 {
		avg = sum / int64(len(list))
	}
	series := []map[string]any{}
	if n := len(list); n > 0 {
		size := (n + 119) / 120
		for i := 0; i < n; i += size {
			end := min(i+size, n)
			var b int64
			for _, s := range list[i:end] {
				b += s.bytes
			}
			series = append(series, map[string]any{"t": list[i].t, "bytes": b / int64(end-i)})
		}
	}
	return map[string]any{
		"databaseBytes": info.DatabaseBytes, "pluginsBytes": info.PluginsBytes, "redisBytes": info.RedisBytes, "otherBytes": info.OtherBytes,
		"diskTotalBytes": info.DiskTotalBytes, "diskFreeBytes": info.DiskFreeBytes,
		"range": rng, "averageBytes": avg, "peakBytes": max(peak, used), "series": series,
	}
}

func (s *store) runStorageSampler() {
	for {
		info := storageStats()
		s.storage.add(storageSample{t: time.Now().UTC(), bytes: info.DatabaseBytes + info.PluginsBytes + info.RedisBytes + info.OtherBytes})
		time.Sleep(storageEvery)
	}
}

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
