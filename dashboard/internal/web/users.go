package web

import (
	"net/http"
	"slices"
	"strconv"
	"strings"

	"github.com/Kljub/BothubV3/dashboard/internal/api"
)

// Users & Roles tab of the admin settings: numbers on top, users and roles
// side by side, below the roles an editor with tabs (general, permissions,
// members, more settings). Every change re-renders the whole tab
// (#users-roles) with the editor on the same role and tab; search, filters
// and pages of the tables run in the browser (js/users-roles.js).

type roleView struct {
	api.Role
	Has     map[string]bool // permission -> granted
	Members []api.User
	AllPerm bool // has every permission
}

type userRow struct {
	api.User
	RoleName string
	Role     *roleView
}

type usersStats struct {
	Total, Admins, Normal, Banned int
}

// roleEditor: the role open in the editor and its tab.
type roleEditor struct {
	Role *roleView
	Tab  string
}

type usersRolesView struct {
	Roles       []roleView
	Users       []userRow
	Permissions []string
	NoLimits    api.RoleLimits // the empty limit fields of the "new role" form
	Stats       usersStats
	Editor      roleEditor
	Colors      []string
	Icons       []string
	Tabs        []string // tabs of the role editor
}

var editorTabs = []string{"general", "permissions", "members", "limits"}

func (s *Server) usersRoles(r *http.Request) (usersRolesView, error) {
	sess := session(r)
	roles, err := s.api.Roles(r.Context(), sess)
	if err != nil {
		return usersRolesView{}, err
	}
	users, err := s.api.Users(r.Context(), sess)
	if err != nil {
		return usersRolesView{}, err
	}
	v := usersRolesView{Permissions: api.Permissions, Colors: api.RoleColors, Icons: api.RoleIcons, Tabs: editorTabs}
	for _, role := range roles {
		rv := roleView{Role: role, Has: map[string]bool{}}
		for _, perm := range role.Permissions {
			rv.Has[perm] = true
		}
		rv.AllPerm = len(rv.Has) >= len(api.Permissions)
		for _, u := range users {
			if u.RoleID == role.ID {
				rv.Members = append(rv.Members, u)
			}
		}
		v.Roles = append(v.Roles, rv)
	}
	byID := func(id int64) *roleView {
		for i := range v.Roles {
			if v.Roles[i].ID == id {
				return &v.Roles[i]
			}
		}
		return nil
	}
	for _, u := range users {
		row := userRow{User: u, Role: byID(u.RoleID)}
		if row.Role != nil {
			row.RoleName = row.Role.Name
		}
		v.Users = append(v.Users, row)
		v.Stats.Total++
		switch {
		case row.Role != nil && row.Role.Key == "banned":
			v.Stats.Banned++
		case row.Role != nil && row.Role.Has["admin.access"]:
			v.Stats.Admins++
		default:
			v.Stats.Normal++
		}
	}
	// The editor: the asked role and tab (query or form), else the first role.
	id, _ := strconv.ParseInt(firstOf(r.FormValue("edit_role"), r.URL.Query().Get("role")), 10, 64)
	v.Editor.Role = byID(id)
	if v.Editor.Role == nil && len(v.Roles) > 0 {
		v.Editor.Role = &v.Roles[0]
	}
	v.Editor.Tab = firstOf(r.FormValue("tab"), r.URL.Query().Get("tab"))
	if !slices.Contains(editorTabs, v.Editor.Tab) {
		v.Editor.Tab = "general"
	}
	return v, nil
}

func firstOf(a, b string) string {
	if a != "" {
		return a
	}
	return b
}

// renderUsersRoles answers a change: the fresh tab plus an optional message.
func (s *Server) renderUsersRoles(w http.ResponseWriter, r *http.Request, p Page, flashKey string) {
	v, err := s.usersRoles(r)
	if err != nil {
		s.failTo(w, r, p, err, "#admin-flash")
		return
	}
	s.render(w, http.StatusOK, "admin", "users_roles_fragment", withData(p, map[string]any{"View": v, "Flash": flashKey}))
}

// handleRoleEditor shows another role or tab in the editor (the whole tab, so the tables stay in sync).
func (s *Server) handleRoleEditor(w http.ResponseWriter, r *http.Request, p Page) {
	s.renderUsersRoles(w, r, p, "")
}

// limitsFrom reads the limit fields of the role form; empty = no limit.
func limitsFrom(r *http.Request) *api.RoleLimits {
	num := func(name string) *int {
		v, err := strconv.Atoi(strings.TrimSpace(r.PostFormValue(name)))
		if err != nil || v < 0 || v > 10000 {
			return nil
		}
		return &v
	}
	return &api.RoleLimits{MaxBots: num("max_bots"), MaxRunning: num("max_running"), IdleStopHours: num("idle_stop_hours")}
}

// permissionsFrom keeps only known permissions from the checkboxes.
func permissionsFrom(r *http.Request) []string {
	_ = r.ParseForm()
	out := []string{}
	for _, perm := range r.PostForm["permissions"] {
		if slices.Contains(api.Permissions, perm) {
			out = append(out, perm)
		}
	}
	return out
}

func pathID(r *http.Request) int64 {
	id, _ := strconv.ParseInt(r.PathValue("id"), 10, 64)
	return id
}

func (s *Server) handleCreateRole(w http.ResponseWriter, r *http.Request, p Page) {
	perms := permissionsFrom(r)
	in := api.RoleWrite{Name: strings.TrimSpace(r.PostFormValue("name")), Color: r.PostFormValue("color"), Icon: r.PostFormValue("icon"),
		Permissions: &perms, Limits: limitsFrom(r)}
	role, err := s.api.CreateRole(r.Context(), session(r), in)
	if err != nil {
		s.failTo(w, r, p, err, "#admin-flash")
		return
	}
	r.Form.Set("edit_role", strconv.FormatInt(role.ID, 10))
	r.Form.Set("tab", "general")
	s.renderUsersRoles(w, r, p, "roles.created")
}

// handleUpdateRole saves the fields of one editor tab ("tab" in the form).
func (s *Server) handleUpdateRole(w http.ResponseWriter, r *http.Request, p Page) {
	var in api.RoleWrite
	switch r.PostFormValue("tab") {
	case "permissions":
		perms := permissionsFrom(r)
		in.Permissions = &perms
	case "limits":
		in.Limits = limitsFrom(r)
	default:
		in.Name, in.Color, in.Icon = strings.TrimSpace(r.PostFormValue("name")), r.PostFormValue("color"), r.PostFormValue("icon")
	}
	if _, err := s.api.UpdateRole(r.Context(), session(r), pathID(r), in); err != nil {
		s.failTo(w, r, p, err, "#admin-flash")
		return
	}
	s.renderUsersRoles(w, r, p, "roles.saved")
}

func (s *Server) handleDeleteRole(w http.ResponseWriter, r *http.Request, p Page) {
	if err := s.api.DeleteRole(r.Context(), session(r), pathID(r)); err != nil {
		s.failTo(w, r, p, err, "#admin-flash")
		return
	}
	s.renderUsersRoles(w, r, p, "roles.deleted")
}

func (s *Server) handleCreateUser(w http.ResponseWriter, r *http.Request, p Page) {
	roleID, _ := strconv.ParseInt(r.PostFormValue("role_id"), 10, 64)
	in := api.UserCreate{
		Username: strings.TrimSpace(r.PostFormValue("username")),
		Email:    strings.TrimSpace(r.PostFormValue("email")),
		Password: r.PostFormValue("password"),
		RoleID:   roleID,
	}
	if len([]rune(in.Password)) < minPasswordLength {
		s.failTo(w, r, p, &api.Error{Status: http.StatusUnprocessableEntity, Key: "error.password.too_short", Params: map[string]any{"min": minPasswordLength}}, "#admin-flash")
		return
	}
	if _, err := s.api.CreateUser(r.Context(), session(r), in); err != nil {
		s.failTo(w, r, p, err, "#admin-flash")
		return
	}
	s.renderUsersRoles(w, r, p, "users.created")
}

// handleUpdateUser saves the edit row of a user: role, e-mail and optionally a new password.
func (s *Server) handleUpdateUser(w http.ResponseWriter, r *http.Request, p Page) {
	roleID, _ := strconv.ParseInt(r.PostFormValue("role_id"), 10, 64)
	email := strings.TrimSpace(r.PostFormValue("email"))
	in := api.UserPatch{RoleID: roleID, Email: &email, Password: r.PostFormValue("password")}
	if in.Password != "" && len([]rune(in.Password)) < minPasswordLength {
		s.failTo(w, r, p, &api.Error{Status: http.StatusUnprocessableEntity, Key: "error.password.too_short", Params: map[string]any{"min": minPasswordLength}}, "#admin-flash")
		return
	}
	if _, err := s.api.UpdateUser(r.Context(), session(r), pathID(r), in); err != nil {
		s.failTo(w, r, p, err, "#admin-flash")
		return
	}
	s.renderUsersRoles(w, r, p, "users.saved")
}

func (s *Server) handleSetUserRole(w http.ResponseWriter, r *http.Request, p Page) {
	roleID, _ := strconv.ParseInt(r.PostFormValue("role_id"), 10, 64)
	if _, err := s.api.SetUserRole(r.Context(), session(r), pathID(r), roleID); err != nil {
		s.failTo(w, r, p, err, "#admin-flash")
		return
	}
	s.renderUsersRoles(w, r, p, "users.role_changed")
}

func (s *Server) handleDeleteUser(w http.ResponseWriter, r *http.Request, p Page) {
	if err := s.api.DeleteUser(r.Context(), session(r), pathID(r)); err != nil {
		s.failTo(w, r, p, err, "#admin-flash")
		return
	}
	s.renderUsersRoles(w, r, p, "users.deleted")
}
