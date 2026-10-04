package web

import (
	"net/http"
	"slices"
	"strings"

	"github.com/Kljub/BothubV3/dashboard/internal/api"
)

// Closed invites on the server page: one main switch ("only allowed
// servers") and one switch per server. While closed, the bot leaves every
// server that is not allowed (on join, at start, right after a change).

type accessView struct {
	Closed  bool
	Allowed map[string]bool   // guild ID -> allowed
	Planned []api.AccessGuild // allowed servers the bot is not on yet
	Error   string            // translated, after a refused save
	Loaded  bool
}

func (s *Server) accessView(r *http.Request, botID int64) accessView {
	a, err := s.api.GuildAccess(r.Context(), session(r), botID)
	if err != nil {
		return accessView{}
	}
	v := accessView{Closed: a.Closed, Allowed: map[string]bool{}, Loaded: true}
	for _, g := range a.Guilds {
		if g.Allowed {
			v.Allowed[g.ID] = true
		}
		if g.Allowed && !g.Current {
			v.Planned = append(v.Planned, g)
		}
	}
	return v
}

// handleGuildAccess changes the main switch (form field closed), one
// server's switch (guild + allowed) or adds a server ID ahead of an invite
// (add), then renders the server list again.
func (s *Server) handleGuildAccess(w http.ResponseWriter, r *http.Request, p Page) {
	id, ok := s.botID(w, r, p)
	if !ok {
		return
	}
	sess := session(r)
	cur, err := s.api.GuildAccess(r.Context(), sess, id)
	if err != nil {
		s.fail(w, r, p, err)
		return
	}
	allowed := []string{}
	current := []string{}
	for _, g := range cur.Guilds {
		if g.Allowed {
			allowed = append(allowed, g.ID)
		}
		if g.Current {
			current = append(current, g.ID)
		}
	}
	closed := cur.Closed
	_ = r.ParseForm()
	// Switches send a hidden "false" first and "true" when checked: the last value counts.
	last := func(name string) string {
		if v := r.Form[name]; len(v) > 0 {
			return v[len(v)-1]
		}
		return ""
	}
	switch {
	case r.Form.Has("closed"):
		closed = last("closed") == "true"
		// Switching on: every server the bot is on now stays allowed.
		if closed && len(allowed) == 0 {
			allowed = append(allowed, current...)
		}
	case r.Form.Has("guild"):
		gid := r.FormValue("guild")
		if !applicationIDPattern.MatchString(gid) {
			s.fail(w, r, p, &api.Error{Status: http.StatusUnprocessableEntity, Key: "error.validation.failed"})
			return
		}
		allowed = slices.DeleteFunc(allowed, func(x string) bool { return x == gid })
		if last("allowed") == "true" {
			allowed = append(allowed, gid)
		}
	case r.Form.Has("add"):
		gid := strings.TrimSpace(r.FormValue("add"))
		if applicationIDPattern.MatchString(gid) && !slices.Contains(allowed, gid) {
			allowed = append(allowed, gid)
		}
	}
	errText := ""
	if _, err := s.api.SaveGuildAccess(r.Context(), sess, id, closed, allowed); err != nil {
		errText = s.apiErrorText(p, err)
	}
	bot, err := s.api.GetBot(r.Context(), sess, id)
	if err != nil {
		s.fail(w, r, p, err)
		return
	}
	guilds, _ := s.api.ListGuilds(r.Context(), sess, id)
	v := s.accessView(r, id)
	v.Error = errText
	s.render(w, http.StatusOK, "bot", "server_list_fragment", withData(p, map[string]any{"Bot": bot, "Guilds": guilds, "Access": v}))
}
