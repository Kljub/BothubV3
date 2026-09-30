package web

import (
	"fmt"
	"math"
	"net/http"
	"strconv"
	"time"

	"github.com/Kljub/BothubV3/dashboard/internal/api"
)

// Resource overview in the admin settings: every BotHub process with its
// load and whether it runs stable.

type processRow struct {
	api.Process
	CPU     string
	CPUPct  float64 // 0–100
	Gauge   gaugeView
	Memory  string
	Storage string // database: "12 MB · 40 GB free"
	Latency string // external and database
	Uptime  string
	Health  string // stable, unstable, crashed, stopped
	// Restartable: the restart button is shown (restartProcesses).
	Restartable bool
	Restarts    int
}

// processHealth rates a process: crashed/stopped from the status, unstable
// after restarts in the last 24 h, with a CPU above 90 % or, for external
// services, a latency above 500 ms.
func processHealth(p api.Process) string {
	switch {
	case p.Status == "crashed":
		return "crashed"
	case p.Status == "stopped":
		return "stopped"
	case p.Kind == "external" && p.LatencyMs > 500:
		return "unstable"
	case p.Kind == "database" && p.LatencyMs > 50:
		return "unstable"
	case p.Restarts24h > 0 || p.CPUPercent > 90:
		return "unstable"
	}
	return "stable"
}

func (s *Server) processRows(r *http.Request, p Page) ([]processRow, error) {
	procs, err := s.api.Processes(r.Context(), session(r))
	if err != nil {
		return nil, err
	}
	// The dashboard itself comes first; it measures its own process.
	procs = append([]api.Process{s.self.process()}, procs...)
	rows := make([]processRow, len(procs))
	for i, pr := range procs {
		rows[i] = processRow{
			Process:     pr,
			CPU:         fmt.Sprintf("%.1f %%", pr.CPUPercent),
			CPUPct:      math.Min(100, math.Round(pr.CPUPercent*10)/10),
			Memory:      formatBytes(pr.MemoryBytes, p.Locale),
			Uptime:      formatDuration(time.Duration(pr.UptimeSeconds) * time.Second),
			Health:      processHealth(pr),
			Restartable: restartProcesses[pr.Key],
			Restarts:    pr.Restarts24h,
		}
		if pr.Kind == "external" || pr.Kind == "database" {
			rows[i].Latency = strconv.FormatFloat(pr.LatencyMs, 'f', -1, 64)
		}
		if pr.StorageBytes > 0 {
			rows[i].Storage = formatBytes(pr.StorageBytes, p.Locale)
			if pr.DiskFreeBytes > 0 {
				rows[i].Storage += " · " + s.i18n.T(p.Locale, "resources.disk_free", "size", formatBytes(pr.DiskFreeBytes, p.Locale))
			}
		}
		// External services (Discord API) and the database show their response time as text, no gauge.
		if pr.Kind != "external" && pr.Kind != "database" {
			rows[i].Gauge = newGauge(pr.CPUPercent, rows[i].CPU)
		}
	}
	return rows, nil
}

// restartProcesses can be restarted from the overview: they exit and their
// supervisor (Docker, later supervisord) starts them again.
var restartProcesses = map[string]bool{"dashboard": true, "botcore": true}

// handleRestartProcess restarts one process. The API authorizes it; the
// dashboard then exits itself after the answer went out.
func (s *Server) handleRestartProcess(w http.ResponseWriter, r *http.Request, p Page) {
	key := r.PathValue("key")
	if !restartProcesses[key] {
		s.fail(w, r, p, &api.Error{Status: http.StatusUnprocessableEntity, Key: "error.process.not_restartable"})
		return
	}
	if err := s.api.RestartProcess(r.Context(), session(r), key); err != nil {
		s.fail(w, r, p, err)
		return
	}
	s.flash(w, p, "resources.restart_started."+key)
	if key == "dashboard" && s.exit != nil {
		if f, ok := w.(http.Flusher); ok {
			f.Flush()
		}
		time.AfterFunc(500*time.Millisecond, s.exit)
	}
}

// handleResources refreshes the process table (polling).
func (s *Server) handleResources(w http.ResponseWriter, r *http.Request, p Page) {
	rows, err := s.processRows(r, p)
	if err != nil {
		s.fail(w, r, p, err)
		return
	}
	s.render(w, http.StatusOK, "admin", "resources_fragment", withData(p, rows))
}

// formatDuration renders an uptime compactly: 3d 4h, 5h 12m, 42m, 18s.
func formatDuration(d time.Duration) string {
	switch {
	case d >= 24*time.Hour:
		return fmt.Sprintf("%dd %dh", int(d.Hours())/24, int(d.Hours())%24)
	case d >= time.Hour:
		return fmt.Sprintf("%dh %dm", int(d.Hours()), int(d.Minutes())%60)
	case d >= time.Minute:
		return fmt.Sprintf("%dm", int(d.Minutes()))
	}
	return fmt.Sprintf("%ds", int(d.Seconds()))
}

// gaugeView is the data for the "gauge" template: Pct 0–100 sets the fill and
// the needle (-90° at 0, +90° at 100); Level picks the color.
type gaugeView struct {
	Pct   float64
	Angle float64
	Level string // ok, warn, high
	Label string
}

func newGauge(pct float64, label string) gaugeView {
	pct = math.Max(0, math.Min(100, pct))
	level := "ok"
	switch {
	case pct >= 90:
		level = "high"
	case pct >= 60:
		level = "warn"
	}
	return gaugeView{Pct: math.Round(pct*10) / 10, Angle: math.Round((pct*1.8-90)*10) / 10, Level: level, Label: label}
}
