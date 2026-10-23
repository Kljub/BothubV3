package web

import (
	"crypto/subtle"
	"net/http"
	"net/url"
	"strconv"
	"strings"

	"github.com/Kljub/BothubV3/dashboard/internal/api"
)

// Sign in with Discord (gateway: cmd/mockapi/discordlogin.go). The login
// page and the account settings start the flow; Discord comes back to
// /login/discord/callback. The session cookie is SameSite=Strict, so the
// browser leaves it out on this cross-site return: the callback page moves
// on by itself to a same-site address (/login/discord/complete or
// /account/discord/complete), where the cookies are there again.

const discordStateCookie = "bothub_discord"

func discordRedirectURI(r *http.Request) string {
	return baseURL(r) + "/login/discord/callback"
}

// setDiscordState: "login.<state>" or "link.<state>", for this browser only.
func setDiscordState(w http.ResponseWriter, r *http.Request, value string, maxAge int) {
	http.SetCookie(w, &http.Cookie{
		Name: discordStateCookie, Value: value, Path: "/", MaxAge: maxAge,
		HttpOnly: true, SameSite: http.SameSiteLaxMode, Secure: strings.HasPrefix(baseURL(r), "https://"),
	})
}

// discordState reads and clears the cookie; it must name the given mode and state.
func discordState(w http.ResponseWriter, r *http.Request, mode string) (string, bool) {
	c, err := r.Cookie(discordStateCookie)
	setDiscordState(w, r, "", -1)
	if err != nil {
		return "", false
	}
	m, state, _ := strings.Cut(c.Value, ".")
	got := r.URL.Query().Get("state")
	return state, m == mode && state != "" && subtle.ConstantTimeCompare([]byte(got), []byte(state)) == 1
}

// handleDiscordLogin: the Discord button of the login form (same form, so
// "stay signed in" and the device key come along).
func (s *Server) handleDiscordLogin(w http.ResponseWriter, r *http.Request) {
	p := s.pageFor(r, nil)
	opts := api.LoginOptions{Remember: r.PostFormValue("remember") == "1", DeviceKey: r.PostFormValue("device_key")}
	state, to, err := s.api.DiscordBegin(r.Context(), api.Session{}, false, discordRedirectURI(r), opts)
	if err != nil {
		s.renderLoginError(w, r, p, err)
		return
	}
	setDiscordState(w, r, "login."+state, 600)
	http.Redirect(w, r, to, http.StatusSeeOther)
}

// handleDiscordLink: account settings → "Link Discord".
func (s *Server) handleDiscordLink(w http.ResponseWriter, r *http.Request, p Page) {
	state, to, err := s.api.DiscordBegin(r.Context(), session(r), true, discordRedirectURI(r), api.LoginOptions{})
	if err != nil {
		s.failTo(w, r, p, err, "#discord-link-error")
		return
	}
	setDiscordState(w, r, "link."+state, 600)
	fullRedirect(w, r, to)
}

func (s *Server) handleDiscordUnlink(w http.ResponseWriter, r *http.Request, p Page) {
	if err := s.api.DiscordUnlink(r.Context(), session(r)); err != nil {
		s.failTo(w, r, p, err, "#discord-link-error")
		return
	}
	// The row shows the new state after a reload of the page.
	w.Header().Set("HX-Refresh", "true")
	w.WriteHeader(http.StatusNoContent)
}

// handleDiscordCallback: Discord's answer. Only moves on to the same-site
// address that finishes the sign-in or the link (see the top of the file).
func (s *Server) handleDiscordCallback(w http.ResponseWriter, r *http.Request) {
	p := s.pageFor(r, nil)
	q := r.URL.Query()
	next := "/login/discord/complete"
	if c, err := r.Cookie(discordStateCookie); err == nil && strings.HasPrefix(c.Value, "link.") {
		next = "/account/discord/complete"
	}
	v := url.Values{"state": {q.Get("state")}}
	if q.Get("error") != "" {
		v.Set("error", "denied")
	} else {
		v.Set("code", q.Get("code"))
	}
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Referrer-Policy", "no-referrer")
	s.render(w, http.StatusOK, "discord_continue", "auth_layout", withData(p, next+"?"+v.Encode()))
}

// handleDiscordComplete finishes a sign-in: like the password form, 2FA may follow.
func (s *Server) handleDiscordComplete(w http.ResponseWriter, r *http.Request) {
	p := s.pageFor(r, nil)
	state, ok := discordState(w, r, "login")
	if !ok || r.URL.Query().Get("error") != "" {
		key := "error.auth.discord_expired"
		if r.URL.Query().Get("error") != "" {
			key = "error.auth.discord_denied"
		}
		s.renderLoginError(w, r, p, &api.Error{Status: http.StatusBadRequest, Key: key})
		return
	}
	_, resp, err := s.api.DiscordFinish(r.Context(), state, r.URL.Query().Get("code"))
	if err != nil {
		if apiErr := api.AsError(err); apiErr.Key == "error.auth.totp_required" {
			s.render(w, http.StatusOK, "login_totp", "auth_layout", withData(p, totpFormOf(apiErr.Params)))
			return
		}
		s.renderLoginError(w, r, p, err)
		return
	}
	relayCookies(w, resp)
	http.Redirect(w, r, "/", http.StatusSeeOther)
}

// handleDiscordLinkComplete finishes linking for the signed-in user.
func (s *Server) handleDiscordLinkComplete(w http.ResponseWriter, r *http.Request, p Page) {
	state, ok := discordState(w, r, "link")
	if !ok || r.URL.Query().Get("error") != "" {
		http.Redirect(w, r, "/", http.StatusSeeOther)
		return
	}
	sess := session(r)
	sess.CSRF = p.Me.CSRFToken
	if err := s.api.DiscordLinkFinish(r.Context(), sess, state, r.URL.Query().Get("code")); err != nil {
		s.fail(w, r, p, err)
		return
	}
	http.Redirect(w, r, "/", http.StatusSeeOther)
}

// renderLoginError shows the login page with the error of a Discord sign-in.
func (s *Server) renderLoginError(w http.ResponseWriter, r *http.Request, p Page, err error) {
	form := authForm{Error: s.apiErrorText(p, err), Discord: s.api.DiscordLoginOn(r.Context())}
	s.render(w, api.AsError(err).Status, "login", "auth_layout", withData(p, form))
}

// --- admin ---

func (s *Server) handleDiscordLoginSettings(w http.ResponseWriter, r *http.Request, p Page) {
	in := api.DiscordLoginUpdate{
		Enabled:      r.PostFormValue("enabled") == "true",
		ClientID:     strings.TrimSpace(r.PostFormValue("client_id")),
		TrustKnownIP: r.PostFormValue("trust_known_ip") == "true",
	}
	in.TrustDays, _ = strconv.Atoi(strings.TrimSpace(r.PostFormValue("trust_days")))
	if v := strings.TrimSpace(r.PostFormValue("client_secret")); v != "" {
		in.Secret = &v
	}
	if _, err := s.api.UpdateDiscordLoginSettings(r.Context(), session(r), in); err != nil {
		s.failTo(w, r, p, err, "#discord-login-flash")
		return
	}
	w.Header().Set("HX-Trigger", "bothub:reset-forms")
	s.flashTo(w, p, "discord_login.saved", "#discord-login-flash")
}

// discordLoginView: the admin form with the address to enter at Discord.
type discordLoginView struct {
	api.DiscordLoginSettings
	RedirectURI string
}
