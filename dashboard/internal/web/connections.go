package web

import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"net/http"
	"net/url"
	"regexp"
	"strings"

	"github.com/Kljub/BothubV3/dashboard/internal/api"
)

// Auto Assign Roles ("connection-roles"): Discord never tells a bot which
// accounts (Steam, GitHub, Twitch …) a member connected. Members sign in
// once with the bot's own Discord application (scopes identify +
// connections) on the public page /connect/<application ID>; the API trades
// the code for tokens and stores the connections, the bot gives the roles.
// The owner stores the application's client secret on the module page
// (write-only) and adds <dashboard>/connect/callback as redirect in the
// Developer Portal.

const connectStateCookie = "bh_connect_state"

var clientSecretPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{16,100}$`)

type connectionsView struct {
	BotID       int64
	App         api.ConnectionsApp
	Members     []api.LinkedMember
	RedirectURL string
	Notice      string // "saved", "removed", "failed", "secret"
	CSRF        string
}

func (s *Server) connectionsView(r *http.Request, botID int64) connectionsView {
	app, _ := s.api.ConnectionsApp(r.Context(), session(r), botID) // optional: "not set up" on error
	v := connectionsView{BotID: botID, App: app, RedirectURL: baseURL(r) + "/connect/callback"}
	if app.Configured {
		v.Members, _ = s.api.LinkedMembers(r.Context(), session(r), botID)
	}
	switch n := r.URL.Query().Get("connections"); n {
	case "saved", "removed", "failed", "secret", "unlinked":
		v.Notice = n
	}
	return v
}

// handleConnectionsSave stores the client secret (empty: keep it) and this dashboard's address.
func (s *Server) handleConnectionsSave(w http.ResponseWriter, r *http.Request, p Page) {
	bot, ok := s.selectedBotOrHome(w, r, p)
	if !ok {
		return
	}
	back := "/bots/modules/connection-roles?connections="
	secret := strings.TrimSpace(r.FormValue("client_secret"))
	if secret != "" && !clientSecretPattern.MatchString(secret) {
		redirect(w, r, back+"secret")
		return
	}
	if _, err := s.api.SaveConnectionsApp(r.Context(), session(r), bot.ID, secret, baseURL(r)); err != nil {
		redirect(w, r, back+"failed")
		return
	}
	redirect(w, r, back+"saved")
}

// handleConnectionsRemove forgets the client secret and every linked member.
func (s *Server) handleConnectionsRemove(w http.ResponseWriter, r *http.Request, p Page) {
	bot, ok := s.selectedBotOrHome(w, r, p)
	if !ok {
		return
	}
	if err := s.api.RemoveConnectionsApp(r.Context(), session(r), bot.ID); err != nil {
		s.fail(w, r, p, err)
		return
	}
	redirect(w, r, "/bots/modules/connection-roles?connections=removed")
}

// handleConnectionsUnlink removes one linked member (the bot takes the roles away).
func (s *Server) handleConnectionsUnlink(w http.ResponseWriter, r *http.Request, p Page) {
	bot, ok := s.selectedBotOrHome(w, r, p)
	if !ok {
		return
	}
	if err := s.api.UnlinkMember(r.Context(), session(r), bot.ID, r.PathValue("uid")); err != nil {
		s.fail(w, r, p, err)
		return
	}
	redirect(w, r, "/bots/modules/connection-roles?connections=unlinked")
}

// --- public member pages ---

type connectPageView struct {
	Lang   string
	Bot    api.ConnectPage
	Result *api.ConnectResult
	Error  string // "expired", "denied", "failed"
}

func (s *Server) connectLang(r *http.Request) (Page, string) {
	p := s.pageFor(r, nil)
	if strings.HasPrefix(p.Locale, "de") {
		return p, "de"
	}
	return p, "en"
}

func (s *Server) renderConnect(w http.ResponseWriter, r *http.Request, status int, v connectPageView) {
	p, lang := s.connectLang(r)
	v.Lang = lang
	w.Header().Set("Cache-Control", "no-store")
	s.render(w, status, "connect", "connect_layout", withData(p, v))
}

// handleMemberConnectPage: what the bot reads, and the button to Discord.
func (s *Server) handleMemberConnectPage(w http.ResponseWriter, r *http.Request) {
	appID := r.PathValue("app")
	if !applicationIDPattern.MatchString(appID) {
		http.NotFound(w, r)
		return
	}
	page, err := s.api.ConnectPageData(r.Context(), appID)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	s.renderConnect(w, r, http.StatusOK, connectPageView{Bot: page})
}

// handleMemberConnectStart sends the member to Discord's sign-in with a random state (cookie).
func (s *Server) handleMemberConnectStart(w http.ResponseWriter, r *http.Request) {
	appID := r.PathValue("app")
	if !applicationIDPattern.MatchString(appID) {
		http.NotFound(w, r)
		return
	}
	page, err := s.api.ConnectPageData(r.Context(), appID)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	buf := make([]byte, 24)
	_, _ = rand.Read(buf)
	state := hex.EncodeToString(buf)
	http.SetCookie(w, &http.Cookie{
		Name: connectStateCookie, Value: state + "." + appID, Path: "/connect", MaxAge: 600,
		HttpOnly: true, SameSite: http.SameSiteLaxMode, Secure: strings.HasPrefix(baseURL(r), "https://"),
	})
	q := url.Values{
		"client_id":     {appID},
		"redirect_uri":  {baseURL(r) + "/connect/callback"},
		"response_type": {"code"},
		"scope":         {strings.Join(page.Scopes, " ")},
		"state":         {state},
		"prompt":        {"consent"},
	}
	http.Redirect(w, r, "https://discord.com/oauth2/authorize?"+q.Encode(), http.StatusSeeOther)
}

// handleMemberConnectCallback takes Discord's answer: the state must match this
// browser's cookie; then the API stores the member's connections.
func (s *Server) handleMemberConnectCallback(w http.ResponseWriter, r *http.Request) {
	c, err := r.Cookie(connectStateCookie)
	http.SetCookie(w, &http.Cookie{Name: connectStateCookie, Path: "/connect", MaxAge: -1})
	if err != nil {
		s.renderConnect(w, r, http.StatusBadRequest, connectPageView{Error: "expired"})
		return
	}
	state, appID, _ := strings.Cut(c.Value, ".")
	got := r.URL.Query().Get("state")
	if !applicationIDPattern.MatchString(appID) || state == "" || subtle.ConstantTimeCompare([]byte(got), []byte(state)) != 1 {
		s.renderConnect(w, r, http.StatusBadRequest, connectPageView{Error: "expired"})
		return
	}
	page, err := s.api.ConnectPageData(r.Context(), appID)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	if r.URL.Query().Get("error") != "" {
		s.renderConnect(w, r, http.StatusOK, connectPageView{Bot: page, Error: "denied"})
		return
	}
	res, err := s.api.ConnectLink(r.Context(), appID, r.URL.Query().Get("code"), baseURL(r)+"/connect/callback")
	if err != nil {
		s.renderConnect(w, r, http.StatusBadGateway, connectPageView{Bot: page, Error: "failed"})
		return
	}
	s.renderConnect(w, r, http.StatusOK, connectPageView{Bot: page, Result: &res})
}
