package web

import (
	"net/http"

	"github.com/Kljub/BothubV3/dashboard/internal/api"
)

// Updates (Admin → Server settings → Updates): check the git repository for
// new commits and start the update; the box follows the run until it ends.

type updateView struct {
	Info   api.UpdateInfo
	Check  *api.UpdateCheck
	Locale string
}

// LastCheck: when the last check ran (empty before the first).
func (v updateView) LastCheck() string {
	if v.Info.LastCheck == nil {
		return ""
	}
	return formatDateTime(v.Info.LastCheck.At, v.Locale)
}

// Running: the update helper still works (the box polls).
func (v updateView) Running() bool {
	return v.Info.Run != nil && (v.Info.Run.Status == "running" || v.Info.Run.Status == "created")
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
