package web

import (
	"log/slog"
	"net/http"
	"slices"

	"github.com/Kljub/BothubV3/dashboard/internal/api"
)

// Closed invites on the server page: one main switch ("only allowed
// servers") and "+ Allow" on every server card. While closed, the bot leaves
// every server that is not allowed (on join, at start, right after a change).
// An allowed server is removed only by leaving it through the dashboard.

type accessView struct {
	Closed  bool
	Allowed map[string]bool // guild ID -> allowed
	Error   string          // translated, after a refused save
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
	}
	return v
}

// handleGuildAccess changes the main switch (form field closed) or allows
// one server the bot is on (guild + allowed=true), then renders the server
// list again. To add the bot to a new server: switch off, invite, "Allow",
// switch on.
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
		// Only servers the bot is on; taking it back means leaving the server (handleLeaveGuild).
		if last("allowed") == "true" && slices.Contains(current, gid) && !slices.Contains(allowed, gid) {
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

// forgetAllowed removes a server the bot left through the dashboard from the
// allowed list. With closed invites and no server left the switch goes off
// (the API refuses an empty list while closed).
func (s *Server) forgetAllowed(r *http.Request, botID int64, guildID string) {
	cur, err := s.api.GuildAccess(r.Context(), session(r), botID)
	if err != nil {
		return
	}
	allowed := []string{}
	for _, g := range cur.Guilds {
		if g.Allowed && g.ID != guildID {
			allowed = append(allowed, g.ID)
		}
	}
	closed := cur.Closed && len(allowed) > 0
	if _, err := s.api.SaveGuildAccess(r.Context(), session(r), botID, closed, allowed); err != nil {
		slog.Warn("allowed server not removed", "bot", botID, "guild", guildID, "err", err)
	}
}
