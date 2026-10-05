package main

import (
	"net/http"
	"regexp"
	"strconv"
)

// Dashboard preferences per account. ModuleGroups: per bot ID the module
// groups the user closed on the Modules page (open is the default).
type uiPrefs struct {
	ModuleGroups map[string][]string `json:"moduleGroups,omitempty"`
}

var groupKey = regexp.MustCompile(`^[a-z]{1,24}$`)

// getModuleGroups: the closed groups of this bot for the signed-in user.
func (s *store) getModuleGroups(w http.ResponseWriter, r *http.Request, b *bot) {
	s.mu.Lock()
	defer s.mu.Unlock()
	closed := []string{}
	if u := s.sessUserFromRequest(r); u != nil {
		closed = append(closed, u.uiPrefs.ModuleGroups[strconv.FormatInt(b.ID, 10)]...)
	}
	writeJSON(w, 200, map[string]any{"closed": closed})
}

func (s *store) putModuleGroups(w http.ResponseWriter, r *http.Request, b *bot) {
	var in struct {
		Closed []string `json:"closed"`
	}
	if !readJSON(w, r, &in) {
		return
	}
	if len(in.Closed) > 30 {
		apiError(w, 422, "error.validation.failed")
		return
	}
	closed := []string{}
	for _, k := range in.Closed {
		if groupKey.MatchString(k) {
			closed = append(closed, k)
		}
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	u := s.sessUserFromRequest(r)
	if u == nil {
		apiError(w, 401, "error.auth.required")
		return
	}
	if u.uiPrefs.ModuleGroups == nil {
		u.uiPrefs.ModuleGroups = map[string][]string{}
	}
	key := strconv.FormatInt(b.ID, 10)
	if len(closed) == 0 {
		delete(u.uiPrefs.ModuleGroups, key)
	} else {
		u.uiPrefs.ModuleGroups[key] = closed
	}
	// Bots that no longer exist are forgotten on the way.
	for k := range u.uiPrefs.ModuleGroups {
		id, _ := strconv.ParseInt(k, 10, 64)
		if _, ok := s.bots[id]; !ok {
			delete(u.uiPrefs.ModuleGroups, k)
		}
	}
	s.persistUser(u)
	writeJSON(w, 200, map[string]any{"closed": closed})
}
