package main

import (
	"context"
	"net/http"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Memory of the dashboard overview (Memory now, average, the admin chart):
// once a minute the memory of the app container (dashboard, gateway and PHP
// API: cgroup usage without the page cache, like `docker stats`) and the
// BotCore (its heartbeat via the PHP API) are added up. The last 7 days are
// kept in memory, so the average starts again after a restart.

const (
	memEvery = time.Minute
	memKeep  = 7 * 24 * time.Hour
)

type memSample struct {
	t        time.Time
	app, bot int64
}

type memSampler struct {
	mu      sync.Mutex
	samples []memSample
}

// cgroupMemory: bytes the container uses without the inactive page cache; 0 when unknown.
func cgroupMemory() int64 {
	raw, err := os.ReadFile("/sys/fs/cgroup/memory.current")
	if err != nil {
		return 0
	}
	cur, err := strconv.ParseInt(strings.TrimSpace(string(raw)), 10, 64)
	if err != nil {
		return 0
	}
	if stat, err := os.ReadFile("/sys/fs/cgroup/memory.stat"); err == nil {
		for _, line := range strings.Split(string(stat), "\n") {
			if rest, ok := strings.CutPrefix(line, "inactive_file "); ok {
				if n, err := strconv.ParseInt(strings.TrimSpace(rest), 10, 64); err == nil && n < cur {
					cur -= n
				}
			}
		}
	}
	return cur
}

// selfRSS: resident memory of this process (when there is no cgroup, e.g. a dev run).
func selfRSS() int64 {
	raw, err := os.ReadFile("/proc/self/status")
	if err != nil {
		return 0
	}
	for _, line := range strings.Split(string(raw), "\n") {
		if rest, ok := strings.CutPrefix(line, "VmRSS:"); ok {
			if f := strings.Fields(rest); len(f) > 0 {
				if kb, err := strconv.ParseInt(f[0], 10, 64); err == nil {
					return kb * 1024
				}
			}
		}
	}
	return 0
}

// sampleMemory takes one measurement.
func (s *store) sampleMemory(ctx context.Context) memSample {
	m := memSample{t: time.Now().UTC(), app: cgroupMemory()}
	if m.app == 0 {
		m.app = selfRSS()
	}
	if s.php != nil {
		var out struct {
			Items []struct {
				Key         string `json:"key"`
				MemoryBytes int64  `json:"memoryBytes"`
			} `json:"items"`
		}
		if err := s.php.do(ctx, http.MethodGet, "/internal/processes", nil, &out); err == nil {
			for _, it := range out.Items {
				if it.Key == "botcore" {
					m.bot = it.MemoryBytes
				}
			}
		}
	}
	return m
}

func (ms *memSampler) add(m memSample) {
	ms.mu.Lock()
	defer ms.mu.Unlock()
	ms.samples = append(ms.samples, m)
	cut := 0
	for cut < len(ms.samples) && m.t.Sub(ms.samples[cut].t) > memKeep {
		cut++
	}
	ms.samples = ms.samples[cut:]
}

// between: the samples in [from, to].
func (ms *memSampler) between(from, to time.Time) []memSample {
	ms.mu.Lock()
	defer ms.mu.Unlock()
	out := []memSample{}
	for _, m := range ms.samples {
		if !m.t.Before(from) && !m.t.After(to) {
			out = append(out, m)
		}
	}
	return out
}

func (s *store) runMemorySampler() {
	for {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		s.mem.add(s.sampleMemory(ctx))
		cancel()
		time.Sleep(memEvery)
	}
}

// memoryStats: the numbers and chart of a time range (at most 120 points).
func (s *store) memoryStats(ctx context.Context, rng string, from, to time.Time) map[string]any {
	list := s.mem.between(from, to)
	now := s.sampleMemory(ctx) // "Memory now" is always fresh
	var sum, peak int64
	for _, m := range list {
		total := m.app + m.bot
		sum += total
		peak = max(peak, total)
	}
	avg := now.app + now.bot
	if len(list) > 0 {
		avg = sum / int64(len(list))
	}
	peak = max(peak, now.app+now.bot)
	series := []map[string]any{}
	if n := len(list); n > 0 {
		size := (n + 119) / 120
		for i := 0; i < n; i += size {
			end := min(i+size, n)
			var b int64
			for _, m := range list[i:end] {
				b += m.app + m.bot
			}
			series = append(series, map[string]any{"t": list[i].t, "bytes": b / int64(end-i)})
		}
	}
	services := []map[string]any{{"name": "dashboard", "currentBytes": now.app}}
	if s.php != nil {
		services = append(services, map[string]any{"name": "bot", "currentBytes": now.bot})
	}
	return map[string]any{
		"range": rng, "currentBytes": now.app + now.bot, "averageBytes": avg, "peakBytes": peak, "limitBytes": nil,
		"services": services, "series": series,
	}
}
