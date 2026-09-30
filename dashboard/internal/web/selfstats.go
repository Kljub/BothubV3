package web

import (
	"os"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/Kljub/BothubV3/dashboard/internal/api"
)

// The dashboard measures itself for the resource overview: memory (RSS),
// CPU since the previous poll and uptime. On Linux (the container) the
// numbers come from /proc/self; elsewhere memory falls back to the Go
// runtime and CPU stays 0.

// clockTicks is USER_HZ on Linux (100 on every common platform).
const clockTicks = 100

type selfSampler struct {
	started time.Time

	mu       sync.Mutex
	lastAt   time.Time
	lastTick int64
}

func newSelfSampler() *selfSampler { return &selfSampler{started: time.Now()} }

func (s *selfSampler) process() api.Process {
	return api.Process{
		Key:           "dashboard",
		Kind:          "service",
		PID:           os.Getpid(),
		Status:        "running",
		CPUPercent:    s.cpuPercent(),
		MemoryBytes:   rssBytes(),
		UptimeSeconds: int64(time.Since(s.started).Seconds()),
	}
}

// cpuPercent: CPU time used since the last call, as a share of one core.
func (s *selfSampler) cpuPercent() float64 {
	ticks, ok := cpuTicks()
	if !ok {
		return 0
	}
	now := time.Now()
	s.mu.Lock()
	defer s.mu.Unlock()
	prevAt, prevTicks := s.lastAt, s.lastTick
	s.lastAt, s.lastTick = now, ticks
	if prevAt.IsZero() {
		// First poll: average since start.
		prevAt, prevTicks = s.started, 0
	}
	elapsed := now.Sub(prevAt).Seconds()
	if elapsed <= 0 {
		return 0
	}
	pct := float64(ticks-prevTicks) / clockTicks / elapsed * 100
	if pct < 0 {
		return 0
	}
	return float64(int(pct*10+0.5)) / 10
}

// cpuTicks reads utime + stime from /proc/self/stat.
func cpuTicks() (int64, bool) {
	raw, err := os.ReadFile("/proc/self/stat")
	if err != nil {
		return 0, false
	}
	// The command name can contain spaces; the fields start after ")".
	s := string(raw)
	i := strings.LastIndexByte(s, ')')
	if i < 0 {
		return 0, false
	}
	f := strings.Fields(s[i+1:])
	// After ")": state is field 3; utime is 14, stime 15 (1-based in proc(5)).
	if len(f) < 13 {
		return 0, false
	}
	utime, err1 := strconv.ParseInt(f[11], 10, 64)
	stime, err2 := strconv.ParseInt(f[12], 10, 64)
	if err1 != nil || err2 != nil {
		return 0, false
	}
	return utime + stime, true
}

// rssBytes reads VmRSS from /proc/self/status, else the Go runtime's memory.
func rssBytes() int64 {
	if raw, err := os.ReadFile("/proc/self/status"); err == nil {
		for _, line := range strings.Split(string(raw), "\n") {
			if rest, ok := strings.CutPrefix(line, "VmRSS:"); ok {
				f := strings.Fields(rest)
				if len(f) >= 1 {
					if kb, err := strconv.ParseInt(f[0], 10, 64); err == nil {
						return kb * 1024
					}
				}
			}
		}
	}
	var m runtime.MemStats
	runtime.ReadMemStats(&m)
	return int64(m.Sys)
}
