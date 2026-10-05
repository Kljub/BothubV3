package main

import (
	"context"
	"log/slog"
	"net/http"
	"regexp"
	"slices"
	"strings"
	"sync"
	"time"
)

// Self-registration (Admin → Invite Policies → Registration): when it is on,
// the login page offers "Create account" and anyone can make an account with
// the chosen role. Only roles without admin rights can be chosen; the default
// is "guest" (view only). Each IP may register registerPerIP accounts per hour.

const registerPerIP = 3

var usernamePattern = regexp.MustCompile(`^[A-Za-z0-9_.-]{3,32}$`)

type registration struct {
	Enabled bool  `json:"enabled"`
	RoleID  int64 `json:"roleId"`
}

// registerLimiter counts registrations per IP within the last hour.
type registerLimiter struct {
	mu   sync.Mutex
	hits map[string][]time.Time
}

func (l *registerLimiter) allow(ip string, now time.Time) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.hits == nil {
		l.hits = map[string][]time.Time{}
	}
	recent := slices.DeleteFunc(l.hits[ip], func(t time.Time) bool { return now.Sub(t) > time.Hour })
	if len(recent) >= registerPerIP {
		l.hits[ip] = recent
		return false
	}
	l.hits[ip] = append(recent, now)
	return true
}

// registerableRole: a role new accounts may get (no admin rights, not banned). Caller holds s.mu.
func (s *store) registerableRole(id int64) bool {
	ro := s.roleByID(id)
	if ro == nil || ro.Key == "banned" {
		return false
	}
	return !slices.Contains(ro.Permissions, "admin.access") && !slices.Contains(ro.Permissions, "users.manage")
}

// guestRoleID is the default role of registered accounts. Caller holds s.mu.
func (s *store) guestRoleID() int64 {
	for _, ro := range s.roles {
		if ro.Key == "guest" {
			return ro.ID
		}
	}
	return 0
}

func (s *store) loadRegistration() {
	if s.php == nil {
		return
	}
	var out struct{ Value *registration }
	in := registration{}
	out.Value = &in
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := s.php.do(ctx, http.MethodGet, "/internal/settings/registration", nil, &out); err != nil {
		slog.Error("mockapi: registration settings not loaded", "err", err)
		return
	}
	s.mu.Lock()
	s.registration = in
	s.mu.Unlock()
}

// registrationOpen: public, for the login page.
func (s *store) registrationOpen(w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	defer s.mu.Unlock()
	writeJSON(w, 200, map[string]bool{"enabled": s.registration.Enabled && len(s.users) > 0})
}

func (s *store) getRegistration(w http.ResponseWriter, r *http.Request, _ string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := s.registration
	if out.RoleID == 0 {
		out.RoleID = s.guestRoleID()
	}
	roles := []map[string]any{}
	for _, ro := range s.roles {
		if s.registerableRole(ro.ID) {
			roles = append(roles, map[string]any{"id": ro.ID, "key": ro.Key, "name": ro.Name})
		}
	}
	writeJSON(w, 200, map[string]any{"enabled": out.Enabled, "roleId": out.RoleID, "roles": roles})
}

func (s *store) putRegistration(w http.ResponseWriter, r *http.Request, sid string) {
	var in registration
	if !readJSON(w, r, &in) {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if in.RoleID == 0 {
		in.RoleID = s.guestRoleID()
	}
	if !s.registerableRole(in.RoleID) {
		apiError(w, 422, "error.registration.role")
		return
	}
	s.registration = in
	if s.php != nil {
		go s.phpSync(http.MethodPut, "/internal/settings/registration", in)
	}
	key := "log.server.registration_off"
	if in.Enabled {
		key = "log.server.registration_on"
	}
	s.addServerLog(time.Now(), "change", "", key, "api", s.nameOfLocked(sid), nil, nil)
	writeJSON(w, 200, in)
}

// register makes an account and signs it in (public, when registration is on).
func (s *store) register(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Username, Password, Email string
		sessionOpts
	}
	if !readJSON(w, r, &in) {
		return
	}
	in.Username, in.Email = strings.TrimSpace(in.Username), strings.TrimSpace(in.Email)
	s.mu.Lock()
	open := s.registration.Enabled && len(s.users) > 0
	roleID := s.registration.RoleID
	if roleID == 0 {
		roleID = s.guestRoleID()
	}
	taken := s.userByName(in.Username) != nil
	s.mu.Unlock()
	switch {
	case !open:
		apiError(w, 403, "error.registration.closed")
		return
	case !usernamePattern.MatchString(in.Username):
		apiError(w, 422, "error.registration.username")
		return
	case len([]rune(in.Password)) < minPassword:
		apiErrorParams(w, 422, "error.password.too_short", map[string]any{"min": minPassword})
		return
	case len(in.Email) > 254 || (in.Email != "" && !strings.Contains(in.Email, "@")):
		apiError(w, 422, "error.registration.email")
		return
	case taken:
		apiError(w, 409, "error.user.name_taken")
		return
	case !s.registerLimit.allow(clientIP(r), time.Now()):
		apiError(w, 429, "error.registration.too_many")
		return
	}
	hash := hashPassword(in.Password) // outside the lock: Argon2id takes a moment
	s.mu.Lock()
	if s.userByName(in.Username) != nil || !s.registerableRole(roleID) {
		s.mu.Unlock()
		apiError(w, 409, "error.user.name_taken")
		return
	}
	var email *string
	if in.Email != "" {
		email = &in.Email
	}
	s.userSeq++
	u := &mockUser{ID: s.userSeq, Username: in.Username, RoleID: roleID, CreatedAt: time.Now().UTC(), passwordHash: hash, Email: email, locale: s.defaultLocale, theme: "system"}
	s.users = append(s.users, u)
	s.persistUser(u)
	s.addServerLog(time.Now(), "change", "", "log.server.user_registered", "api", in.Username, map[string]any{"ip": clientIP(r)}, nil)
	s.mu.Unlock()
	s.startSession(w, r, 201, u.ID, in.sessionOpts)
}
