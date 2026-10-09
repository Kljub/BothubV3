package main

import (
	"encoding/json"
	"fmt"
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
	ID          int64      `json:"id"`
	Key         string     `json:"key"`
	Name        string     `json:"name"`
	Builtin     bool       `json:"builtin"`
	Permissions []string   `json:"permissions"`
	UserCount   int        `json:"userCount"`
	Limits      roleLimits `json:"limits"`
	Color       string     `json:"color"` // roleColors key; empty = default of the role
	Icon        string     `json:"icon"`  // roleIcons key; empty = default of the role
}

// Looks of roles (Users & Roles): fixed lists, so the page needs no inline styles.
var (
	roleColors = []string{"purple", "blue", "green", "yellow", "orange", "red", "pink", "teal", "gray", "white"}
	roleIcons  = []string{"crown", "shield", "headset", "code", "user", "users", "star", "ban", "eye", "wrench", "heart", "gamepad"}
)

// styleOr: v when it is in the list, else "".
func styleOr(v string, list []string) string {
	if slices.Contains(list, v) {
		return v
	}
	return ""
}

type mockUser struct {
	ID               int64      `json:"id"`
	Username         string     `json:"username"`
	Email            *string    `json:"email"`
	RoleID           int64      `json:"roleId"`
	TwoFactorEnabled bool       `json:"twoFactorEnabled"`
	Self             bool       `json:"self"`
	Online           bool       `json:"online"` // a session was used in the last 5 minutes
	CreatedAt        time.Time  `json:"createdAt"`
	LastLoginAt      *time.Time `json:"lastLoginAt"`
	passwordHash     string     // Argon2id (PHC string)
	uiPrefs          uiPrefs    // dashboard preferences (closed module groups per bot)
	locale, theme    string
	totpSecret       string   // active secret; empty = 2FA off
	pendingSecret    string   // set by setup, active after enable
	recovery         []string // hashes of the unused recovery codes
}

func (u *mockUser) localeOr(fallback string) string {
	if u == nil || u.locale == "" {
		return fallback
	}
	return u.locale
}

func (u *mockUser) themeOr() string {
	if u == nil || u.theme == "" {
		return "system"
	}
	return u.theme
}

// roleKey: "admin", "user", "banned", … ("" for an unknown role); caller holds s.mu.
func (s *store) roleKey(id int64) string {
	if r := s.roleByID(id); r != nil {
		return r.Key
	}
	return ""
}

var allPermissions = []string{"admin.access", "users.manage", "bots.create", "bots.manage", "bots.view", "modules.manage", "plugins.manage", "logs.view"}

func (s *store) seedUsers() {
	s.roles = []*role{
		{ID: 1, Key: "admin", Name: "Admin", Builtin: true, Permissions: allPermissions, Color: "purple", Icon: "crown"},
		{ID: 2, Key: "user", Name: "User", Builtin: true, Permissions: []string{"bots.view", "bots.manage", "modules.manage", "logs.view"}, Color: "gray", Icon: "user"},
		{ID: 3, Key: "banned", Name: "Banned", Builtin: true, Permissions: []string{}, Color: "red", Icon: "ban"},
		{ID: 4, Key: "guest", Name: "Guest", Builtin: true, Permissions: []string{"bots.view"}, Color: "white", Icon: "eye"},
	}
	s.roleSeq = 4
	// No users yet: the setup wizard (or ENV) creates the first admin; further
	// users come from Users & Roles. Stored ones are loaded by loadAccounts.
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
		Name        string     `json:"name"`
		Permissions []string   `json:"permissions"`
		Limits      roleLimits `json:"limits"`
		Color       string     `json:"color"`
		Icon        string     `json:"icon"`
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
	nr := &role{ID: s.roleSeq, Key: fmt.Sprintf("custom%d", s.roleSeq), Name: in.Name, Permissions: validPermissions(in.Permissions), Limits: in.Limits.clean(),
		Color: styleOr(in.Color, roleColors), Icon: styleOr(in.Icon, roleIcons)}
	s.roles = append(s.roles, nr)
	s.persistRole(nr)
	writeJSON(w, 201, nr)
}

func (s *store) updateRole(w http.ResponseWriter, r *http.Request, sid string) {
	// Every field is optional: each tab of the role editor sends its own.
	var in struct {
		Name        *string     `json:"name"`
		Color       *string     `json:"color"`
		Icon        *string     `json:"icon"`
		Permissions *[]string   `json:"permissions"`
		Limits      *roleLimits `json:"limits"`
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
	if in.Name != nil && !ro.Builtin {
		name := strings.TrimSpace(*in.Name)
		if name == "" || len(name) > 32 {
			apiError(w, 422, "error.field.required")
			return
		}
		for _, o := range s.roles {
			if o.ID != ro.ID && strings.EqualFold(o.Name, name) {
				apiError(w, 409, "error.role.name_taken")
				return
			}
		}
		ro.Name = name
	}
	if in.Color != nil {
		ro.Color = styleOr(*in.Color, roleColors)
	}
	if in.Icon != nil {
		ro.Icon = styleOr(*in.Icon, roleIcons)
	}
	if ro.Key != "admin" { // admin keeps every permission and has no limits
		if in.Permissions != nil {
			next := validPermissions(*in.Permissions)
			if !slices.Equal(next, ro.Permissions) {
				// Other rights: the members of the role sign in again.
				for _, u := range s.users {
					if u.RoleID == ro.ID {
						s.endSessionsOf(u.ID, sid)
					}
				}
			}
			ro.Permissions = next
		}
		if in.Limits != nil {
			ro.Limits = in.Limits.clean()
		}
	}
	s.persistRole(ro)
	writeJSON(w, 200, ro)
}

func (s *store) deleteRole(w http.ResponseWriter, r *http.Request, sid string) {
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
			s.persistUser(u)
			s.endSessionsOf(u.ID, sid)
		}
	}
	s.roles = slices.DeleteFunc(s.roles, func(x *role) bool { return x.ID == id })
	s.phpDelete(fmt.Sprintf("/internal/accounts/roles/%d", id))
	w.WriteHeader(204)
}

func (s *store) listUsers(w http.ResponseWriter, r *http.Request, sid string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	me := s.sessUser(sid)
	online := map[int64]bool{}
	for _, sess := range s.sessions {
		if time.Since(sess.lastSeen) < 5*time.Minute {
			online[sess.userID] = true
		}
	}
	for _, u := range s.users {
		u.Self = me != nil && u.ID == me.ID
		u.TwoFactorEnabled = u.totpSecret != ""
		u.Online = online[u.ID]
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
	var email *string
	if in.Email != "" {
		e := in.Email
		email = &e
	}
	nu := s.newUser(in.Username, in.Password, in.RoleID, email)
	writeJSON(w, 201, nu)
}

func (s *store) patchUser(w http.ResponseWriter, r *http.Request, sid string) {
	// All optional: roleId (0 = keep), email ("" removes it), password (a new one, set by the admin).
	var in struct {
		RoleID   int64   `json:"roleId"`
		Email    *string `json:"email"`
		Password *string `json:"password"`
	}
	if !readJSON(w, r, &in) {
		return
	}
	id, _ := strconv.ParseInt(r.PathValue("id"), 10, 64)
	hash := ""
	if in.Password != nil && *in.Password != "" {
		if len([]rune(*in.Password)) < minPassword {
			apiErrorParams(w, 422, "error.password.too_short", map[string]any{"min": minPassword})
			return
		}
		hash = hashPassword(*in.Password) // outside the lock: Argon2id takes a moment
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if me := s.sessUser(sid); me != nil && me.ID == id && in.RoleID != 0 && in.RoleID != me.RoleID {
		apiError(w, 409, "error.user.self")
		return
	}
	if in.RoleID != 0 && s.roleByID(in.RoleID) == nil {
		apiError(w, 422, "error.role.not_found")
		return
	}
	if in.Email != nil {
		if e := strings.TrimSpace(*in.Email); len(e) > 254 || (e != "" && !strings.Contains(e, "@")) {
			apiError(w, 422, "error.registration.email")
			return
		}
	}
	for _, u := range s.users {
		if u.ID == id {
			if in.RoleID != 0 && in.RoleID != u.RoleID {
				u.RoleID = in.RoleID
				// New role (or banned): the next request has to sign in again.
				s.endSessionsOf(u.ID, sid)
			}
			if in.Email != nil {
				if e := strings.TrimSpace(*in.Email); e == "" {
					u.Email = nil
				} else {
					u.Email = &e
				}
			}
			if hash != "" {
				u.passwordHash = hash
				// A password set by the admin signs the account out everywhere else.
				s.endSessionsOf(u.ID, sid)
			}
			s.persistUser(u)
			writeJSON(w, 200, u)
			return
		}
	}
	apiError(w, 404, "error.not_found")
}

func (s *store) deleteUser(w http.ResponseWriter, r *http.Request, sid string) {
	id, _ := strconv.ParseInt(r.PathValue("id"), 10, 64)
	s.mu.Lock()
	defer s.mu.Unlock()
	if me := s.sessUser(sid); me != nil && me.ID == id {
		apiError(w, 409, "error.user.self")
		return
	}
	n := len(s.users)
	s.users = slices.DeleteFunc(s.users, func(u *mockUser) bool { return u.ID == id })
	if len(s.users) == n {
		apiError(w, 404, "error.not_found")
		return
	}
	// Their sessions end with them.
	s.endSessionsOf(id, "")
	s.phpDelete(fmt.Sprintf("/internal/accounts/users/%d", id))
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
