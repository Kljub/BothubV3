package web

import (
	"fmt"
	"net/http"
	"slices"
	"strings"

	"github.com/Kljub/BothubV3/dashboard/internal/api"
)

// Updates (Admin → Server settings → Updates): check the git repository for
// new commits and start the update; the box follows the run until it ends.

type updateView struct {
	Info   api.UpdateInfo
	Check  *api.UpdateCheck
	Locale string
}

// newestFirst reverses the lines of a log, so the newest is on top.
func newestFirst(log string) string {
	lines := strings.Split(strings.TrimRight(strings.ReplaceAll(log, "\r\n", "\n"), "\n"), "\n")
	slices.Reverse(lines)
	return strings.Join(lines, "\n")
}

// LastCheck: when the last check ran (empty before the first).
func (v updateView) LastCheck() string {
	if v.Info.LastCheck == nil {
		return ""
	}
	return formatDateTime(v.Info.LastCheck.At, v.Locale)
}

// UpdateAvailable: the last check (this one, else the gateway's last) found
// new commits. Only then the box offers "Update now".
func (v updateView) UpdateAvailable() bool {
	if v.Check != nil {
		return v.Check.Error == "" && v.Check.Behind > 0
	}
	return v.Info.LastCheck != nil && v.Info.LastCheck.Behind > 0
}

// Running: the update helper still works (the box polls).
func (v updateView) Running() bool {
	return v.Info.Run != nil && (v.Info.Run.Status == "running" || v.Info.Run.Status == "created")
}

// Duration "08:34" (mm:ss) or "1:02:03" for the time left.
func clockDuration(sec int) string {
	if sec < 0 {
		return ""
	}
	if sec >= 3600 {
		return fmt.Sprintf("%d:%02d:%02d", sec/3600, sec%3600/60, sec%60)
	}
	return fmt.Sprintf("%02d:%02d", sec/60, sec%60)
}

// Eta: "08:34" while an update runs and the time left is known.
func (v updateView) Eta() string {
	if v.Info.Run == nil || v.Info.Run.Progress == nil || !v.Running() {
		return ""
	}
	return clockDuration(v.Info.Run.Progress.EtaSeconds)
}

// NewVersion: the newest commit of the last check when it is ahead.
func (v updateView) NewVersion() string {
	if v.Check != nil && v.Check.Error == "" && v.Check.Behind > 0 {
		return v.Check.Remote
	}
	if v.Info.LastCheck != nil && v.Info.LastCheck.Behind > 0 {
		return v.Info.LastCheck.Remote
	}
	return ""
}

// handleUpdateBadge: the "Update available" button at the bottom of the
// admin sidebar (empty when there is none or updates are not set up).
func (s *Server) handleUpdateBadge(w http.ResponseWriter, r *http.Request, p Page) {
	info, err := s.api.UpdateInfo(r.Context(), session(r))
	if err != nil || !info.Configured {
		w.WriteHeader(http.StatusOK)
		return
	}
	s.render(w, http.StatusOK, "admin", "update_badge_fragment", withData(p, updateView{Info: info, Locale: p.Locale}))
}

func (s *Server) updateBox(w http.ResponseWriter, r *http.Request, p Page, check *api.UpdateCheck) {
	info, err := s.api.UpdateInfo(r.Context(), session(r))
	if err != nil {
		s.failTo(w, r, p, err, "#update-error")
		return
	}
	s.render(w, http.StatusOK, "admin", "update_box_fragment", withData(p, updateView{Info: info, Check: check, Locale: p.Locale}))
}

func (s *Server) handleUpdateStatus(w http.ResponseWriter, r *http.Request, p Page) {
	s.updateBox(w, r, p, nil)
}

func (s *Server) handleUpdateCheck(w http.ResponseWriter, r *http.Request, p Page) {
	check, err := s.api.CheckUpdate(r.Context(), session(r))
	if err != nil {
		s.failTo(w, r, p, err, "#update-error")
		return
	}
	s.updateBox(w, r, p, &check)
}

func (s *Server) handleUpdateRun(w http.ResponseWriter, r *http.Request, p Page) {
	if err := s.api.RunUpdate(r.Context(), session(r)); err != nil {
		s.failTo(w, r, p, err, "#update-error")
		return
	}
	s.updateBox(w, r, p, nil)
}
