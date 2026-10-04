package main

import (
	"fmt"
	"net/http"
	"regexp"
	"slices"
	"strconv"
	"strings"
)

// Co-Work access: who may do what with a bot. The owner and instance admins
// (role permission admin.access) may do everything; other users only what
// their membership (bot_members) gives. withBot checks every bot route here,
// so a member without the right gets 403 and a stranger 404.

type botMember struct {
	UserID      int64    `json:"userId"`
	Role        string   `json:"role"` // viewer, operator, builder, admin, custom
	Permissions []string `json:"permissions"`
}

// botPermissions are the rights a member can have (bot.view is implied).
var botPermissions = []string{
	"logs.view", "data.view", "bot.control", "servers.manage",
	"commands.manage", "events.manage", "modules.manage", "plugins.manage", "data.manage",
	"profile.edit", "settings.edit", "members.manage",
}

// rolePresets: the fixed roles, each building on the one before.
var rolePresets = map[string][]string{
	"viewer":   {"logs.view"},
	"operator": {"logs.view", "data.view", "bot.control", "servers.manage"},
	"builder":  {"logs.view", "data.view", "bot.control", "servers.manage", "commands.manage", "events.manage", "modules.manage", "plugins.manage"},
	"admin":    botPermissions,
}

// botAccess: the rights of a user on a bot; ok false = no access at all.
// Caller holds s.mu.
func (s *store) botAccess(u *mockUser, b *bot) (role string, perms []string, ok bool) {
	if u == nil || b == nil {
		return "", nil, false
	}
	if slices.Contains(s.permissionsOf(u), "admin.access") || b.OwnerID == 0 || b.OwnerID == u.ID {
		return "owner", botPermissions, true
	}
	for _, m := range b.Members {
		if m.UserID != u.ID {
			continue
		}
		if m.Role == "custom" {
			return m.Role, slices.DeleteFunc(slices.Clone(m.Permissions), func(p string) bool { return !slices.Contains(botPermissions, p) }), true
		}
		return m.Role, rolePresets[m.Role], true
	}
	return "", nil, false
}

// botRule: a route below /api/v1/bots/{id} and the right a change on it needs.
type botRule struct {
	re   *regexp.Regexp
	perm string
}

// The first matching rule wins; GET needs only access (except logs and data).
var botRules = []botRule{
	{regexp.MustCompile(`^/(start|stop|restart)$`), "bot.control"},
	{regexp.MustCompile(`^/members(/|$)`), "members.manage"},
	{regexp.MustCompile(`^/(profile|presence|status)(/|$)`), "profile.edit"},
	{regexp.MustCompile(`^/guilds(/|$)|^/guild-access(/|$)`), "servers.manage"},
	{regexp.MustCompile(`^/(commands|command-groups|templates|custom-commands)(/|$)`), "commands.manage"},
	{regexp.MustCompile(`^/(events|timed|webhooks|webhook-key)(/|$)`), "events.manage"},
	{regexp.MustCompile(`^/modules(/|$)`), "modules.manage"},
	{regexp.MustCompile(`^/plugins(/|$)`), "plugins.manage"},
	{regexp.MustCompile(`^/data(/|$)`), "data.manage"},
}

var botViewRules = []botRule{
	{regexp.MustCompile(`^/logs(/|$)`), "logs.view"},
	{regexp.MustCompile(`^/data(/|$)`), "data.view"},
}

var botPathRe = regexp.MustCompile(`^/api/v1/bots/\d+`)

// requiredBotPerm: the right a request on a bot needs ("" = access is enough).
func requiredBotPerm(r *http.Request) string {
	rest := botPathRe.ReplaceAllString(r.URL.Path, "")
	if r.Method == http.MethodGet || r.Method == http.MethodHead {
		for _, rule := range botViewRules {
			if rule.re.MatchString(rest) {
				return rule.perm
			}
		}
		return ""
	}
	if rest == "" || rest == "/" {
		if r.Method == http.MethodDelete {
			return "bot.delete" // only the owner (and instance admins)
		}
		return "settings.edit"
	}
	for _, rule := range botRules {
		if rule.re.MatchString(rest) {
			return rule.perm
		}
	}
	return "settings.edit"
}

// allowed: may the user do this request on the bot? Caller holds s.mu.
func (s *store) allowed(u *mockUser, b *bot, r *http.Request) (found, ok bool) {
	role, perms, has := s.botAccess(u, b)
	if !has {
		return false, false
	}
	need := requiredBotPerm(r)
	switch {
	case need == "":
		return true, true
	case need == "bot.delete":
		return true, role == "owner"
	case strings.HasPrefix(r.URL.Path, "/api/v1/bots/") && slices.Contains(perms, need):
		return true, true
	}
	return true, false
}

// --- members (Co-Work) ---

type memberView struct {
	UserID      int64    `json:"userId"`
	Username    string   `json:"username"`
	Role        string   `json:"role"`
	Permissions []string `json:"permissions"`
	Owner       bool     `json:"owner"`
}

// listMembers: the owner first, then the members with their names and rights.
func (s *store) listMembers(w http.ResponseWriter, r *http.Request, b *bot) {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := []memberView{}
	if o := s.userByID(b.OwnerID); o != nil {
		out = append(out, memberView{UserID: o.ID, Username: o.Username, Role: "owner", Permissions: botPermissions, Owner: true})
	}
	for _, m := range b.Members {
		u := s.userByID(m.UserID)
		if u == nil {
			continue
		}
		_, perms, _ := s.botAccess(u, b)
		out = append(out, memberView{UserID: u.ID, Username: u.Username, Role: m.Role, Permissions: perms})
	}
	writeJSON(w, 200, map[string]any{"items": out, "permissions": botPermissions})
}

// setMember: {role, permissions} for a user (by ID or {username}). Nobody
// hands out more than they have; only the owner gives the admin role.
func (s *store) setMember(w http.ResponseWriter, r *http.Request, b *bot) {
	var in struct {
		Role        string   `json:"role"`
		Permissions []string `json:"permissions"`
	}
	if !readJSON(w, r, &in) {
		return
	}
	target := r.PathValue("user")
	s.mu.Lock()
	me := s.sessUserFromRequest(r)
	myRole, myPerms, _ := s.botAccess(me, b)
	var u *mockUser
	if id, err := strconv.ParseInt(target, 10, 64); err == nil {
		u = s.userByID(id)
	} else {
		u = s.userByName(target)
	}
	perms := in.Permissions
	if in.Role != "custom" {
		perms = rolePresets[in.Role]
	}
	switch {
	case u == nil:
		s.mu.Unlock()
		apiError(w, 404, "error.user.not_found")
		return
	case in.Role != "custom" && rolePresets[in.Role] == nil:
		s.mu.Unlock()
		apiError(w, 422, "error.validation.failed")
		return
	case u.ID == b.OwnerID || (me != nil && u.ID == me.ID):
		s.mu.Unlock()
		apiError(w, 409, "error.member.self")
		return
	case in.Role == "admin" && myRole != "owner":
		s.mu.Unlock()
		apiError(w, 403, "error.access.denied")
		return
	}
	for _, p := range perms {
		if myRole != "owner" && !slices.Contains(myPerms, p) {
			s.mu.Unlock()
			apiError(w, 403, "error.access.denied")
			return
		}
	}
	m := botMember{UserID: u.ID, Role: in.Role, Permissions: []string{}}
	if in.Role == "custom" {
		m.Permissions = slices.DeleteFunc(slices.Clone(perms), func(p string) bool { return !slices.Contains(botPermissions, p) })
	}
	i := slices.IndexFunc(b.Members, func(x botMember) bool { return x.UserID == u.ID })
	if i >= 0 {
		b.Members[i] = m
	} else {
		b.Members = append(b.Members, m)
	}
	s.mu.Unlock()
	if s.php != nil {
		if err := s.php.do(r.Context(), http.MethodPut, fmt.Sprintf("/internal/bots/%d/members/%d", b.ID, u.ID), m, nil); err != nil {
			pe := asPHPError(err)
			apiError(w, pe.Status, pe.Key)
			return
		}
	}
	s.listMembers(w, r, b)
}

func (s *store) removeMember(w http.ResponseWriter, r *http.Request, b *bot) {
	id, _ := strconv.ParseInt(r.PathValue("user"), 10, 64)
	s.mu.Lock()
	me := s.sessUserFromRequest(r)
	i := slices.IndexFunc(b.Members, func(x botMember) bool { return x.UserID == id })
	if i < 0 {
		s.mu.Unlock()
		apiError(w, 404, "error.not_found")
		return
	}
	myRole, _, _ := s.botAccess(me, b)
	if b.Members[i].Role == "admin" && myRole != "owner" {
		s.mu.Unlock()
		apiError(w, 403, "error.access.denied")
		return
	}
	b.Members = slices.Delete(b.Members, i, i+1)
	s.mu.Unlock()
	if s.php != nil {
		if err := s.php.do(r.Context(), http.MethodDelete, fmt.Sprintf("/internal/bots/%d/members/%d", b.ID, id), nil, nil); err != nil {
			pe := asPHPError(err)
			apiError(w, pe.Status, pe.Key)
			return
		}
	}
	w.WriteHeader(204)
}
