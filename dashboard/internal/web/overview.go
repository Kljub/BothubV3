package web

import (
	"net/http"
	"slices"
	"time"

	"github.com/Kljub/BothubV3/dashboard/internal/api"
)

var statRanges = []string{"1h", "24h", "7d"}

const (
	// inputTime is the value format of <input type="datetime-local">.
	inputTime = "2006-01-02T15:04"
)

type memoryPanel struct {
	Range        string // 1h, 24h, 7d or custom
	Ranges       []string
	Stats        api.MemoryStats
	AverageLabel string
	Chart        lineChart
	// Custom range: input values (local time, server TZ).
	From, To string
}

// storagePanel: the data folder over time (chart like memory) and the disk.
type storagePanel struct {
	Range        string
	Ranges       []string
	Stats        api.StorageStats
	AverageLabel string
	Chart        lineChart
}

func (s *Server) storagePanel(st api.StorageStats, rng, locale string) storagePanel {
	pts := make([]chartPoint, len(st.Series))
	for i, v := range st.Series {
		pts[i] = chartPoint{T: v.T, V: v.Bytes}
	}
	return storagePanel{Range: rng, Ranges: statRanges, Stats: st, AverageLabel: formatBytes(st.AverageBytes, locale),
		Chart: buildLineChart(pts, st.AverageBytes, rng, locale, func(v int64) string { return formatBytes(v, locale) })}
}

// handleOverviewStorage re-renders the storage panel (range buttons, polling).
func (s *Server) handleOverviewStorage(w http.ResponseWriter, r *http.Request, p Page) {
	rng := r.URL.Query().Get("range")
	if !slices.Contains(statRanges, rng) {
		rng = "24h"
	}
	stats, err := s.api.OverviewStats(r.Context(), session(r), rng)
	if err != nil {
		s.fail(w, r, p, err)
		return
	}
	s.render(w, http.StatusOK, "admin", "storage_panel_fragment", withData(p, s.storagePanel(stats.Storage, rng, p.Locale)))
}

func (s *Server) handleOverview(w http.ResponseWriter, r *http.Request, p Page) {
	sess := session(r)
	tiles, err := s.api.OverviewStats(r.Context(), sess, "24h")
	if err != nil {
		s.fail(w, r, p, err)
		return
	}
	p.Nav = "overview"
	// Co-Work invites to the user (none when the API cannot say).
	invites, _ := s.api.MyInvites(r.Context(), sess)
	s.render(w, http.StatusOK, "overview", "layout", withData(p, map[string]any{
		"Tiles":   tiles,
		"Grid":    botGrid(p.Bots, pageParam(r)),
		"Invites": invites,
	}))
}

// handleOverviewTiles refreshes the stat tiles (htmx polling).
func (s *Server) handleOverviewTiles(w http.ResponseWriter, r *http.Request, p Page) {
	tiles, err := s.api.OverviewStats(r.Context(), session(r), "24h")
	if err != nil {
		s.fail(w, r, p, err)
		return
	}
	s.render(w, http.StatusOK, "overview", "overview_tiles_fragment", withData(p, tiles))
}

// handleOverviewMemory refreshes the memory chart: range switch, custom range
// and polling. range=custom takes from/to in the datetime-local format.
func (s *Server) handleOverviewMemory(w http.ResponseWriter, r *http.Request, p Page) {
	q := r.URL.Query()
	rng := q.Get("range")
	if rng == "custom" {
		s.customMemory(w, r, p)
		return
	}
	if !slices.Contains(statRanges, rng) {
		rng = "24h"
	}
	stats, err := s.api.OverviewStats(r.Context(), session(r), rng)
	if err != nil {
		s.fail(w, r, p, err)
		return
	}
	s.render(w, http.StatusOK, "admin", "memory_panel_fragment", withData(p, s.memoryPanel(stats.Memory, p.Locale)))
}

// customMemory renders the chart for a user-chosen range inside the retention.
// Errors show inside the panel (#memory-error), the chart stays.
func (s *Server) customMemory(w http.ResponseWriter, r *http.Request, p Page) {
	from, to, errKey := customRange(r, 5*time.Minute, 24*time.Hour, "error.range.too_short")
	if errKey != "" {
		s.failTo(w, r, p, &api.Error{Status: http.StatusUnprocessableEntity, Key: errKey}, "#memory-error")
		return
	}

	stats, err := s.api.OverviewStatsBetween(r.Context(), session(r), from, to)
	if err != nil {
		s.failTo(w, r, p, err, "#memory-error")
		return
	}
	panel := s.memoryPanel(stats.Memory, p.Locale)
	panel.Range, panel.From, panel.To = "custom", from.Format(inputTime), to.Format(inputTime)
	s.render(w, http.StatusOK, "admin", "memory_panel_fragment", withData(p, panel))
}

func (s *Server) memoryPanel(m api.MemoryStats, locale string) memoryPanel {
	return memoryPanel{
		Range:        m.Range,
		Ranges:       statRanges,
		Stats:        m,
		AverageLabel: formatBytes(m.AverageBytes, locale),
		Chart:        buildMemoryChart(m, locale),
	}
}

// earliest returns the earlier of two times.
func earliest(a, b time.Time) time.Time {
	if a.Before(b) {
		return a
	}
	return b
}
