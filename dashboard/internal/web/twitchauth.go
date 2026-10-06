package web

import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"net/http"
	"net/url"
	"strconv"
	"strings"

	"github.com/Kljub/BothubV3/dashboard/internal/api"
)

// Twitch Alerts: the channel owner signs in with Twitch once. The dashboard
// sends them to Twitch with a random state (cookie), Twitch sends them back
// to /auth/twitch/callback with a code, and the API trades the code for the
// tokens (the client secret never reaches the browser or this server).

const twitchStateCookie = "bh_twitch_state"

type twitchAuthView struct {
	BotID       int64
	Status      api.TwitchAuth
	RedirectURL string
	Notice      string // "connected", "denied", "failed", "expired"
	CSRF        string // for the disconnect form
}

func (s *Server) twitchAuthView(r *http.Request, botID int64) twitchAuthView {
	st, _ := s.api.TwitchAuthStatus(r.Context(), session(r), botID) // optional: "not connected" on error
	notice := r.URL.Query().Get("twitch")
	switch notice {
	case "connected", "denied", "failed", "expired":
	default:
		notice = ""
	}
	return twitchAuthView{BotID: botID, Status: st, RedirectURL: baseURL(r) + "/auth/twitch/callback", Notice: notice}
}

// handleTwitchConnect sends the browser to Twitch's sign-in for the selected bot.
func (s *Server) handleTwitchConnect(w http.ResponseWriter, r *http.Request, p Page) {
	bot, ok := s.selectedBotOrHome(w, r, p)
	if !ok {
		return
	}
	st, err := s.api.TwitchAuthStatus(r.Context(), session(r), bot.ID)
	if err != nil || !st.Configured || st.ClientID == "" {
		redirect(w, r, "/bots/modules/twitch-alerts?twitch=failed")
		return
	}
	buf := make([]byte, 24)
	_, _ = rand.Read(buf)
	state := hex.EncodeToString(buf)
	http.SetCookie(w, &http.Cookie{
		Name: twitchStateCookie, Value: state + "." + strconv.FormatInt(bot.ID, 10), Path: "/auth/twitch", MaxAge: 600,
		HttpOnly: true, SameSite: http.SameSiteLaxMode, Secure: strings.HasPrefix(baseURL(r), "https://"),
	})
	q := url.Values{
		"client_id":     {st.ClientID},
		"redirect_uri":  {baseURL(r) + "/auth/twitch/callback"},
		"response_type": {"code"},
		"scope":         {strings.Join(st.Scopes, " ")},
		"state":         {state},
		"force_verify":  {"true"},
	}
	http.Redirect(w, r, "https://id.twitch.tv/oauth2/authorize?"+q.Encode(), http.StatusSeeOther)
}

// handleTwitchCallback takes Twitch's answer: the state must match the
// cookie of this browser, then the API stores the channel.
func (s *Server) handleTwitchCallback(w http.ResponseWriter, r *http.Request, p Page) {
	back := "/bots/modules/twitch-alerts?twitch="
	c, err := r.Cookie(twitchStateCookie)
	http.SetCookie(w, &http.Cookie{Name: twitchStateCookie, Path: "/auth/twitch", MaxAge: -1})
	if err != nil {
		redirect(w, r, back+"expired")
		return
	}
	state, rawID, _ := strings.Cut(c.Value, ".")
	botID, _ := strconv.ParseInt(rawID, 10, 64)
	got := r.URL.Query().Get("state")
	if botID < 1 || state == "" || subtle.ConstantTimeCompare([]byte(got), []byte(state)) != 1 {
		redirect(w, r, back+"expired")
		return
	}
	if r.URL.Query().Get("error") != "" {
		redirect(w, r, back+"denied")
		return
	}
	sess := session(r)
	sess.CSRF = p.CSRF // a redirect from Twitch carries no token; the state above stands for it
	if _, err := s.api.TwitchConnect(r.Context(), sess, botID, r.URL.Query().Get("code"), baseURL(r)+"/auth/twitch/callback"); err != nil {
		redirect(w, r, back+"failed")
		return
	}
	redirect(w, r, back+"connected")
}

// handleTwitchDisconnect forgets the channel of the selected bot.
func (s *Server) handleTwitchDisconnect(w http.ResponseWriter, r *http.Request, p Page) {
	bot, ok := s.selectedBotOrHome(w, r, p)
	if !ok {
		return
	}
	if err := s.api.TwitchDisconnect(r.Context(), session(r), bot.ID); err != nil {
		s.fail(w, r, p, err)
		return
	}
	redirect(w, r, "/bots/modules/twitch-alerts")
}
