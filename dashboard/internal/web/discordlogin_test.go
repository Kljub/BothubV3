package web

import (
	"html"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// Back from Discord: the page moves on to the same-site address of the mode
// in the cookie; finishing needs the cookie's state.
func TestDiscordCallbackAndState(t *testing.T) {
	s := docsServer(t, `{"articles":[],"categories":[]}`)
	page := func(cookie string) string {
		r := httptest.NewRequest(http.MethodGet, "/login/discord/callback?code=abc&state=st1", nil)
		if cookie != "" {
			r.AddCookie(&http.Cookie{Name: discordStateCookie, Value: cookie})
		}
		w := httptest.NewRecorder()
		s.handleDiscordCallback(w, r)
		return html.UnescapeString(w.Body.String())
	}
	if body := page("login.st1"); !strings.Contains(body, `href="/login/discord/complete?code=abc&state=st1"`) || !strings.Contains(body, "data-auto-continue") {
		t.Fatalf("login callback:\n%s", body)
	}
	if body := page("link.st1"); !strings.Contains(body, `href="/account/discord/complete?code=abc&state=st1"`) {
		t.Fatalf("link callback:\n%s", body)
	}

	check := func(cookie, mode, query string) bool {
		r := httptest.NewRequest(http.MethodGet, "/x?"+query, nil)
		r.AddCookie(&http.Cookie{Name: discordStateCookie, Value: cookie})
		_, ok := discordState(httptest.NewRecorder(), r, mode)
		return ok
	}
	if !check("login.st1", "login", "state=st1") || check("login.st1", "login", "state=other") || check("link.st1", "login", "state=st1") || check("login.", "login", "state=") {
		t.Fatal("state check")
	}
}
