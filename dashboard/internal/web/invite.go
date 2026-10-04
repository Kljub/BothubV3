package web

import (
	"context"
	"html"
	"net/http"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/Kljub/BothubV3/dashboard/internal/api"
)

// Custom invite link (Admin → Invite Policies): the Discord Developer Portal
// points its install link to <domain>/invite/<application ID>. This public
// page shows the bot and, depending on the mode, the real Discord link:
// "private" only to signed-in dashboard users, "public" to everyone. Discord
// still accepts the invite from anyone who builds the OAuth link from the
// application ID; the server allowlist covers that.

var applicationIDPattern = regexp.MustCompile(`^\d{17,20}$`)

type invitePageView struct {
	Bot     api.InviteBot
	Allowed bool   // the Discord link is shown
	Link    string // Discord OAuth link
	Lang    string
}

// customInviteURL is the link to enter in the Developer Portal for a bot.
func customInviteURL(r *http.Request, appID *string) string {
	if appID == nil || !applicationIDPattern.MatchString(*appID) {
		return ""
	}
	return baseURL(r) + "/invite/" + *appID
}

func (s *Server) handleInvitePage(w http.ResponseWriter, r *http.Request) {
	appID := r.PathValue("app")
	if !applicationIDPattern.MatchString(appID) {
		http.NotFound(w, r)
		return
	}
	page, err := s.api.InvitePage(r.Context(), appID)
	if err != nil || !page.Enabled {
		http.NotFound(w, r)
		return
	}
	sess := session(r)
	// From Discord's "Add App" button the browser comes cross-site and leaves
	// out the SameSite=Strict session cookie: one same-site reload brings it.
	if page.Mode == "private" && sess.Cookie == "" && r.URL.Query().Get("r") != "1" {
		next := html.EscapeString("/invite/" + appID + "?r=1")
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("Content-Security-Policy", "default-src 'none'")
		_, _ = w.Write([]byte(`<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="0;url=` + next + `"><title>BotHub</title><p><a href="` + next + `">Continue</a></p>`))
		return
	}
	signedIn := false
	if sess.Cookie != "" {
		if _, err := s.api.Me(r.Context(), sess); err == nil {
			signedIn = true
		}
	}
	p := s.pageFor(r, nil)
	lang := "en"
	if strings.HasPrefix(p.Locale, "de") {
		lang = "de"
	}
	v := invitePageView{Bot: page.Bot, Lang: lang, Allowed: page.Mode == "public" || signedIn}
	if v.Allowed {
		v.Link = inviteURL(&appID)
	}
	w.Header().Set("Cache-Control", "no-store")
	s.render(w, http.StatusOK, "invite", "invite_layout", withData(p, v))
}

// handleInviteSettings saves the custom invite settings (Admin → Server settings).
func (s *Server) handleInviteSettings(w http.ResponseWriter, r *http.Request, p Page) {
	in := api.InviteSettings{Enabled: r.PostFormValue("enabled") == "true", Mode: r.PostFormValue("mode")}
	if in.Mode != "public" {
		in.Mode = "private"
	}
	if _, err := s.api.SaveInviteSettings(r.Context(), session(r), in); err != nil {
		s.failTo(w, r, p, err, "#invite-flash")
		return
	}
	clearInviteCache()
	s.flashTo(w, p, "invite_settings.saved", "#invite-flash")
}

// customInviteOn caches per application ID whether its custom invite page is
// on (public lookup, 30 s), so every page with the "Invite Bot" link does not
// ask the API. Saving the invite settings clears it.
var customInviteOn = struct {
	sync.Mutex
	fetch func(ctx context.Context, appID string) bool
	m     map[string]inviteCacheEntry
}{m: map[string]inviteCacheEntry{}}

type inviteCacheEntry struct {
	on bool
	at time.Time
}

func clearInviteCache() {
	customInviteOn.Lock()
	customInviteOn.m = map[string]inviteCacheEntry{}
	customInviteOn.Unlock()
}

// botInviteURL is the "Invite Bot" link: the custom invite page when it is
// on (Admin → Invite Policies), else Discord's own link.
func botInviteURL(appID *string) string {
	if appID == nil || !applicationIDPattern.MatchString(*appID) {
		return inviteURL(appID)
	}
	customInviteOn.Lock()
	e, ok := customInviteOn.m[*appID]
	fetch := customInviteOn.fetch
	customInviteOn.Unlock()
	if !ok || time.Since(e.at) > 30*time.Second {
		on := false
		if fetch != nil {
			ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
			on = fetch(ctx, *appID)
			cancel()
		}
		e = inviteCacheEntry{on: on, at: time.Now()}
		customInviteOn.Lock()
		customInviteOn.m[*appID] = e
		customInviteOn.Unlock()
	}
	if e.on {
		return "/invite/" + *appID
	}
	return inviteURL(appID)
}
