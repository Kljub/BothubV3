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

// Web Verify ("web-verify"): Discord never gives a bot the IP address of a
// member. The bot posts a one-time link /verify/<token>; the member signs in
// with the bot's Discord application (scope identify, the client secret of
// Auto Assign Roles) and the API checks the address the page was opened
// from (Tor, VPN/proxy, country, other accounts). The bot owner adds
// <dashboard>/verify/callback as redirect in the Developer Portal.

const verifyStateCookie = "bh_verify_state"

var verifyTokenPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{43}$`)

type verifyPageView struct {
	Lang   string
	Token  string
	Bot    api.VerifyPage
	Result *api.VerifyResult
	Error  string // "expired", "denied", "failed", "wrong_account", "tries"
}

func (s *Server) renderVerify(w http.ResponseWriter, r *http.Request, status int, v verifyPageView) {
	p, lang := s.connectLang(r)
	v.Lang = lang
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Referrer-Policy", "no-referrer")
	s.render(w, status, "verify", "verify_layout", withData(p, v))
}

// handleVerifyPage: what is checked, the privacy note and the button to Discord.
func (s *Server) handleVerifyPage(w http.ResponseWriter, r *http.Request) {
	token := r.PathValue("token")
	if !verifyTokenPattern.MatchString(token) {
		s.renderVerify(w, r, http.StatusNotFound, verifyPageView{Error: "expired"})
		return
	}
	page, err := s.api.VerifyPageData(r.Context(), token)
	if err != nil {
		s.renderVerify(w, r, http.StatusNotFound, verifyPageView{Error: "expired"})
		return
	}
	s.renderVerify(w, r, http.StatusOK, verifyPageView{Token: token, Bot: page})
}

// handleVerifyStart sends the member to Discord's sign-in with a random state (cookie).
func (s *Server) handleVerifyStart(w http.ResponseWriter, r *http.Request) {
	token := r.PathValue("token")
	if !verifyTokenPattern.MatchString(token) {
		s.renderVerify(w, r, http.StatusNotFound, verifyPageView{Error: "expired"})
		return
	}
	page, err := s.api.VerifyPageData(r.Context(), token)
	if err != nil {
		s.renderVerify(w, r, http.StatusNotFound, verifyPageView{Error: "expired"})
		return
	}
	buf := make([]byte, 24)
	_, _ = rand.Read(buf)
	state := hex.EncodeToString(buf)
	http.SetCookie(w, &http.Cookie{
		Name: verifyStateCookie, Value: state + "." + token, Path: "/verify", MaxAge: 600,
		HttpOnly: true, SameSite: http.SameSiteLaxMode, Secure: strings.HasPrefix(baseURL(r), "https://"),
	})
	q := url.Values{
		"client_id":     {page.ApplicationID},
		"redirect_uri":  {baseURL(r) + "/verify/callback"},
		"response_type": {"code"},
		"scope":         {"identify"},
		"state":         {state},
		"prompt":        {"none"},
	}
	http.Redirect(w, r, "https://discord.com/oauth2/authorize?"+q.Encode(), http.StatusSeeOther)
}

// handleVerifyCallback takes Discord's answer: the state must match this
// browser's cookie; then the API runs the checks on this request's address.
func (s *Server) handleVerifyCallback(w http.ResponseWriter, r *http.Request) {
	c, err := r.Cookie(verifyStateCookie)
	http.SetCookie(w, &http.Cookie{Name: verifyStateCookie, Path: "/verify", MaxAge: -1})
	if err != nil {
		s.renderVerify(w, r, http.StatusBadRequest, verifyPageView{Error: "expired"})
		return
	}
	state, token, _ := strings.Cut(c.Value, ".")
	got := r.URL.Query().Get("state")
	if !verifyTokenPattern.MatchString(token) || state == "" || subtle.ConstantTimeCompare([]byte(got), []byte(state)) != 1 {
		s.renderVerify(w, r, http.StatusBadRequest, verifyPageView{Error: "expired"})
		return
	}
	page, err := s.api.VerifyPageData(r.Context(), token)
	if err != nil {
		s.renderVerify(w, r, http.StatusNotFound, verifyPageView{Error: "expired"})
		return
	}
	v := verifyPageView{Token: token, Bot: page}
	if r.URL.Query().Get("error") != "" {
		v.Error = "denied"
		s.renderVerify(w, r, http.StatusOK, v)
		return
	}
	res, err := s.api.VerifyCheck(r.Context(), token, r.URL.Query().Get("code"), baseURL(r)+"/verify/callback")
	if err != nil {
		v.Error = "failed"
		switch {
		case api.IsStatus(err, http.StatusForbidden):
			v.Error = "wrong_account"
		case api.IsStatus(err, http.StatusTooManyRequests):
			v.Error = "tries"
		case api.IsStatus(err, http.StatusNotFound):
			v.Error = "expired"
		}
		s.renderVerify(w, r, http.StatusOK, v)
		return
	}
	v.Result = &res
	s.renderVerify(w, r, http.StatusOK, v)
}
