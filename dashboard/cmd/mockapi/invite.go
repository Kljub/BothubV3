package main

import (
	"net/http"
	"regexp"
)

// Custom invite link (<domain>/invite/<application ID>): settings and the
// public page data live in the PHP API (settings key "invite"). GET
// /api/v1/invite/{app} is public (the page shows the bot's name and avatar).
// Without the PHP API the settings stay in memory and no page is found.

type inviteSettings struct {
	Enabled bool   `json:"enabled"`
	Mode    string `json:"mode"`
}

var appIDPattern = regexp.MustCompile(`^\d{17,20}$`)

func (s *store) getInvitePage(w http.ResponseWriter, r *http.Request) {
	if !appIDPattern.MatchString(r.PathValue("app")) {
		apiError(w, 404, "error.not_found")
		return
	}
	if s.php == nil {
		apiError(w, 404, "error.not_found")
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	s.forward(w, r, nil)
}

func (s *store) getInviteSettings(w http.ResponseWriter, r *http.Request, sid string) {
	if s.php != nil {
		s.adminViaPHP(adminPHPRequired)(w, r, sid)
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	out := s.invite
	if out.Mode == "" {
		out.Mode = "private"
	}
	writeJSON(w, 200, out)
}

func (s *store) putInviteSettings(w http.ResponseWriter, r *http.Request, sid string) {
	if s.php != nil {
		s.adminViaPHP(adminPHPRequired)(w, r, sid)
		return
	}
	var in inviteSettings
	if !readJSON(w, r, &in) {
		return
	}
	if in.Mode != "private" && in.Mode != "public" {
		apiError(w, 422, "error.validation.failed")
		return
	}
	s.mu.Lock()
	s.invite = in
	s.mu.Unlock()
	writeJSON(w, 200, in)
}
