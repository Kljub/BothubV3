package web

import (
	"net/http"

	"github.com/Kljub/BothubV3/dashboard/internal/api"
)

// Recovery key box of Admin → Security: status, create a new key (shown once).

type recoveryView struct {
	Key    api.RecoveryKey
	NewKey string // only right after creating
	Locale string
}

func (v recoveryView) CreatedAt() string {
	if v.Key.CreatedAt == nil {
		return ""
	}
	return formatDateTime(*v.Key.CreatedAt, v.Locale)
}

func (s *Server) recoveryView(r *http.Request, p Page) recoveryView {
	k, _ := s.api.RecoveryKey(r.Context(), session(r)) // optional: "none yet" on error
	return recoveryView{Key: k, Locale: p.Locale}
}

func (s *Server) handleNewRecoveryKey(w http.ResponseWriter, r *http.Request, p Page) {
	key, err := s.api.NewRecoveryKey(r.Context(), session(r))
	if err != nil {
		s.failTo(w, r, p, err, "#recovery-error")
		return
	}
	v := s.recoveryView(r, p)
	v.NewKey = key
	// The key must not stay in a cache or the browser history.
	w.Header().Set("Cache-Control", "no-store")
	s.render(w, http.StatusOK, "admin", "recovery_box_fragment", withData(p, v))
}
