package web

import (
	"net/http"
	"slices"
	"strconv"
	"strings"

	"github.com/Kljub/BothubV3/dashboard/internal/api"
)

// Users & Roles tab of the admin settings. Every change re-renders the whole
// tab (#users-roles), so role counts and selects stay in sync.

type roleView struct {
	api.Role
	Has map[string]bool // permission -> granted
}

type userRow struct {
	api.User
	RoleName string
}

type usersRolesView struct {
	Roles       []roleView
	Users       []userRow
	Permissions []string
}

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
	v := usersRolesView{Permissions: api.Permissions}
	names := map[int64]string{}
	for _, role := range roles {
		rv := roleView{Role: role, Has: map[string]bool{}}
		for _, perm := range role.Permissions {
			rv.Has[perm] = true
		}
		v.Roles = append(v.Roles, rv)
		names[role.ID] = role.Name
	}
	for _, u := range users {
		v.Users = append(v.Users, userRow{User: u, RoleName: names[u.RoleID]})
	}
	return v, nil
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

// permissionsFrom keeps only known permissions from the checkboxes.
func permissionsFrom(r *http.Request) []string {
	_ = r.ParseForm()
	var out []string
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
	in := api.RoleWrite{Name: strings.TrimSpace(r.PostFormValue("name")), Permissions: permissionsFrom(r)}
	if _, err := s.api.CreateRole(r.Context(), session(r), in); err != nil {
		s.failTo(w, r, p, err, "#admin-flash")
		return
	}
	s.renderUsersRoles(w, r, p, "roles.created")
}

func (s *Server) handleUpdateRole(w http.ResponseWriter, r *http.Request, p Page) {
	in := api.RoleWrite{Name: strings.TrimSpace(r.PostFormValue("name")), Permissions: permissionsFrom(r)}
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
