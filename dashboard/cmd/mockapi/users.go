package main

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"time"
)

// Users and roles of the mock API. Four native roles; the ENV/setup admin is
// user 1 and cannot change or delete itself here.

type role struct {
	ID          int64    `json:"id"`
	Key         string   `json:"key"`
	Name        string   `json:"name"`
	Builtin     bool     `json:"builtin"`
	Permissions []string `json:"permissions"`
	UserCount   int      `json:"userCount"`
}

type mockUser struct {
	ID               int64      `json:"id"`
	Username         string     `json:"username"`
	Email            *string    `json:"email"`
	RoleID           int64      `json:"roleId"`
	TwoFactorEnabled bool       `json:"twoFactorEnabled"`
	Self             bool       `json:"self"`
	CreatedAt        time.Time  `json:"createdAt"`
	LastLoginAt      *time.Time `json:"lastLoginAt"`
	password         string
}

var allPermissions = []string{"admin.access", "users.manage", "bots.create", "bots.manage", "bots.view", "modules.manage", "plugins.manage", "logs.view"}

func (s *store) seedUsers() {
	s.roles = []*role{
		{ID: 1, Key: "admin", Name: "Admin", Builtin: true, Permissions: allPermissions},
		{ID: 2, Key: "user", Name: "User", Builtin: true, Permissions: []string{"bots.view", "bots.manage", "modules.manage", "logs.view"}},
		{ID: 3, Key: "banned", Name: "Banned", Builtin: true, Permissions: []string{}},
		{ID: 4, Key: "guest", Name: "Guest", Builtin: true, Permissions: []string{"bots.view"}},
	}
	s.roleSeq = 4
	// Only the admin (setup wizard or ENV); further users come from Users & Roles.
	s.users = []*mockUser{{ID: 1, Username: s.user, RoleID: 1, CreatedAt: time.Now().UTC()}}
	s.userSeq = 1
}

func (s *store) rolesJSON() []*role {
	for _, r := range s.roles {
		r.UserCount = 0
		for _, u := range s.users {
			if u.RoleID == r.ID {
				r.UserCount++
			}
		}
	}
	return s.roles
}

func (s *store) roleByID(id int64) *role {
	for _, r := range s.roles {
		if r.ID == id {
			return r
		}
	}
	return nil
}

func validPermissions(in []string) []string {
	out := []string{}
	for _, p := range in {
		if slices.Contains(allPermissions, p) && !slices.Contains(out, p) {
			out = append(out, p)
		}
	}
	return out
}

func (s *store) listRoles(w http.ResponseWriter, r *http.Request, _ string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	writeJSON(w, 200, map[string]any{"items": s.rolesJSON()})
}

func (s *store) createRole(w http.ResponseWriter, r *http.Request, _ string) {
	var in struct {
		Name        string   `json:"name"`
		Permissions []string `json:"permissions"`
	}
	if !readJSON(w, r, &in) {
		return
	}
	in.Name = strings.TrimSpace(in.Name)
	s.mu.Lock()
	defer s.mu.Unlock()
	if in.Name == "" || len(in.Name) > 32 {
		apiError(w, 422, "error.field.required")
		return
	}
	for _, r := range s.roles {
		if strings.EqualFold(r.Name, in.Name) {
			apiError(w, 409, "error.role.name_taken")
			return
		}
	}
	s.roleSeq++
	nr := &role{ID: s.roleSeq, Name: in.Name, Permissions: validPermissions(in.Permissions)}
	s.roles = append(s.roles, nr)
	writeJSON(w, 201, nr)
}

func (s *store) updateRole(w http.ResponseWriter, r *http.Request, _ string) {
	var in struct {
		Permissions []string `json:"permissions"`
	}
	if !readJSON(w, r, &in) {
		return
	}
	id, _ := strconv.ParseInt(r.PathValue("id"), 10, 64)
	s.mu.Lock()
	defer s.mu.Unlock()
	ro := s.roleByID(id)
	if ro == nil {
		apiError(w, 404, "error.role.not_found")
		return
	}
	if ro.Key != "admin" { // admin keeps every permission
		ro.Permissions = validPermissions(in.Permissions)
	}
	writeJSON(w, 200, ro)
}

func (s *store) deleteRole(w http.ResponseWriter, r *http.Request, _ string) {
	id, _ := strconv.ParseInt(r.PathValue("id"), 10, 64)
	s.mu.Lock()
	defer s.mu.Unlock()
	ro := s.roleByID(id)
	switch {
	case ro == nil:
		apiError(w, 404, "error.role.not_found")
		return
	case ro.Builtin:
		apiError(w, 409, "error.role.builtin")
		return
	}
	for _, u := range s.users {
		if u.RoleID == id {
			u.RoleID = 2 // back to "User"
		}
	}
	s.roles = slices.DeleteFunc(s.roles, func(x *role) bool { return x.ID == id })
	w.WriteHeader(204)
}

func (s *store) listUsers(w http.ResponseWriter, r *http.Request, _ string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, u := range s.users {
		u.Self = u.ID == 1
		if u.ID == 1 {
			u.Username, u.Email, u.TwoFactorEnabled = s.user, s.account.email, s.account.totpSecret != ""
		}
	}
	writeJSON(w, 200, map[string]any{"items": s.users})
}

func (s *store) createUser(w http.ResponseWriter, r *http.Request, _ string) {
	var in struct {
		Username string `json:"username"`
		Email    string `json:"email"`
		Password string `json:"password"`
		RoleID   int64  `json:"roleId"`
	}
	if !readJSON(w, r, &in) {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	switch {
	case len(in.Username) < 3 || len(in.Username) > 32:
		apiError(w, 422, "error.field.too_short")
		return
	case len([]rune(in.Password)) < minPassword:
		apiErrorParams(w, 422, "error.password.too_short", map[string]any{"min": minPassword})
		return
	case s.roleByID(in.RoleID) == nil:
		apiError(w, 422, "error.role.not_found")
		return
	}
	for _, u := range s.users {
		if strings.EqualFold(u.Username, in.Username) {
			apiError(w, 409, "error.user.name_taken")
			return
		}
	}
	s.userSeq++
	nu := &mockUser{ID: s.userSeq, Username: in.Username, RoleID: in.RoleID, CreatedAt: time.Now().UTC(), password: in.Password}
	if in.Email != "" {
		e := in.Email
		nu.Email = &e
	}
	s.users = append(s.users, nu)
	writeJSON(w, 201, nu)
}

func (s *store) patchUser(w http.ResponseWriter, r *http.Request, _ string) {
	var in struct {
		RoleID int64 `json:"roleId"`
	}
	if !readJSON(w, r, &in) {
		return
	}
	id, _ := strconv.ParseInt(r.PathValue("id"), 10, 64)
	s.mu.Lock()
	defer s.mu.Unlock()
	if id == 1 {
		apiError(w, 409, "error.user.self")
		return
	}
	if s.roleByID(in.RoleID) == nil {
		apiError(w, 422, "error.role.not_found")
		return
	}
	for _, u := range s.users {
		if u.ID == id {
			u.RoleID = in.RoleID
			writeJSON(w, 200, u)
			return
		}
	}
	apiError(w, 404, "error.not_found")
}

func (s *store) deleteUser(w http.ResponseWriter, r *http.Request, _ string) {
	id, _ := strconv.ParseInt(r.PathValue("id"), 10, 64)
	s.mu.Lock()
	defer s.mu.Unlock()
	if id == 1 {
		apiError(w, 409, "error.user.self")
		return
	}
	n := len(s.users)
	s.users = slices.DeleteFunc(s.users, func(u *mockUser) bool { return u.ID == id })
	if len(s.users) == n {
		apiError(w, 404, "error.not_found")
		return
	}
	w.WriteHeader(204)
}

// --- module commands ---

func (s *store) listModuleCommands(w http.ResponseWriter, r *http.Request, b *bot) {
	module := r.PathValue("key")
	s.mu.Lock()
	defer s.mu.Unlock()
	items := []map[string]any{}
	for name, on := range s.cmdStates {
		if strings.HasPrefix(name, strconv.FormatInt(b.ID, 10)+"/"+module+"/") {
			items = append(items, map[string]any{"name": name[strings.LastIndex(name, "/")+1:], "enabled": on})
		}
	}
	// Commands without a stored state are on by default.
	for _, c := range s.commandCatalog[module] {
		if _, ok := s.cmdStates[strconv.FormatInt(b.ID, 10)+"/"+module+"/"+c]; !ok {
			items = append(items, map[string]any{"name": c, "enabled": true})
		}
	}
	writeJSON(w, 200, map[string]any{"items": items})
}

func (s *store) setModuleCommand(w http.ResponseWriter, r *http.Request, b *bot) {
	var in struct {
		Enabled bool `json:"enabled"`
	}
	if !readJSON(w, r, &in) {
		return
	}
	module, name := r.PathValue("key"), r.PathValue("name")
	s.mu.Lock()
	defer s.mu.Unlock()
	if !slices.Contains(s.commandCatalog[module], name) {
		apiError(w, 404, "error.command.unknown")
		return
	}
	s.cmdStates[strconv.FormatInt(b.ID, 10)+"/"+module+"/"+name] = in.Enabled
	key := "log.change.module_disabled"
	if in.Enabled {
		key = "log.change.module_enabled"
	}
	s.addLog(b.ID, time.Now(), "change", "", key, map[string]any{"module": "/" + name}, nil)
	writeJSON(w, 200, map[string]any{"name": name, "enabled": in.Enabled})
}

func loadCommandCatalog() map[string][]string {
	out := map[string][]string{}
	raw, err := os.ReadFile(filepath.Join(envOr("SHARED_DIR", "/shared"), "commands.json"))
	if err != nil {
		return out
	}
	var cat struct {
		Commands []struct{ Name, Module string } `json:"commands"`
	}
	_ = json.Unmarshal(raw, &cat)
	for _, c := range cat.Commands {
		out[c.Module] = append(out[c.Module], c.Name)
	}
	return out
}
