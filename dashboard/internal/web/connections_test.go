package web

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/Kljub/BothubV3/dashboard/internal/api"
	"github.com/Kljub/BothubV3/dashboard/ui"
)

func TestConnectPage(t *testing.T) {
	tpl, err := parseTemplates(ui.FS)
	if err != nil {
		t.Fatal(err)
	}
	set := tpl.sets["connect"]
	if set == nil {
		t.Fatal("no template set for connect.html")
	}
	bot := api.ConnectPage{BotName: "Njetflix <X>", ApplicationID: "123456789012345678", Scopes: []string{"identify", "connections"}}
	for _, c := range []struct {
		v    connectPageView
		want []string
		not  string
	}{
		{connectPageView{Bot: bot, Lang: "de"}, []string{"Njetflix &lt;X&gt;", "Mit Discord anmelden", `href="/connect/123456789012345678/start"`}, "Verknüpft als"},
		{connectPageView{Bot: bot, Lang: "en", Result: &api.ConnectResult{UserName: "Kljub", Connections: []api.MemberConnection{{Type: "steam", Name: "Entity", Verified: true}}}}, []string{"Linked as <strong>Kljub</strong>", "steam</span> Entity ✔"}, "Sign in with Discord"},
		{connectPageView{Bot: bot, Lang: "en", Result: &api.ConnectResult{UserName: "Kljub"}}, []string{"no connections"}, "<ul"},
		{connectPageView{Lang: "en", Error: "expired"}, []string{"The sign-in expired"}, "/start"},
		{connectPageView{Bot: bot, Lang: "de", Error: "denied"}, []string{"abgebrochen", "Noch mal versuchen"}, "Verknüpft als"},
	} {
		var out strings.Builder
		if err := set.ExecuteTemplate(&out, "connect_layout", Page{Data: c.v}); err != nil {
			t.Fatal(err)
		}
		for _, w := range c.want {
			if !strings.Contains(out.String(), w) {
				t.Errorf("missing %q", w)
			}
		}
		if strings.Contains(out.String(), c.not) {
			t.Errorf("must not contain %q", c.not)
		}
	}
	if !clientSecretPattern.MatchString("AbCdEfGh_ijklmnop-123") || clientSecretPattern.MatchString("short") || clientSecretPattern.MatchString("has spaces in it 1234") {
		t.Fatal("client secret pattern")
	}
}

func TestBaseURLBehindProxy(t *testing.T) {
	req := func(h map[string]string) *http.Request {
		r := httptest.NewRequest("GET", "http://gitkljub.com/account/mobile/pair", nil)
		for k, v := range h {
			r.Header.Set(k, v)
		}
		return r
	}
	for _, c := range []struct {
		h    map[string]string
		want string
	}{
		{nil, "http://gitkljub.com"},
		{map[string]string{"X-Forwarded-Proto": "https"}, "https://gitkljub.com"},
		{map[string]string{"Forwarded": "for=1.2.3.4;proto=https"}, "https://gitkljub.com"},
		{map[string]string{"X-Forwarded-Ssl": "on"}, "https://gitkljub.com"},
		{map[string]string{"Origin": "https://gitkljub.com"}, "https://gitkljub.com"},
		{map[string]string{"Referer": "https://gitkljub.com/bots"}, "https://gitkljub.com"},
		{map[string]string{"Referer": "https://evil.example/x"}, "http://gitkljub.com"},
		{map[string]string{"X-Forwarded-Proto": "http", "Referer": "https://gitkljub.com/"}, "https://gitkljub.com"},
	} {
		if got := baseURL(req(c.h)); got != c.want {
			t.Errorf("%v: %s, want %s", c.h, got, c.want)
		}
	}
	t.Setenv("BOTHUB_PUBLIC_URL", "https://bothub.example/")
	if got := baseURL(req(nil)); got != "https://bothub.example" {
		t.Errorf("public url: %s", got)
	}
}

func TestMobileCatalog(t *testing.T) {
	s := &Server{modules: []ModuleCategory{{Key: "security", Icon: "🛡️", Modules: []ModuleInfo{{Key: "anticontrol", Icon: "🛡️"}}}}}
	w := httptest.NewRecorder()
	s.handleMobileCatalog(w, httptest.NewRequest("GET", "/mobile/catalog", nil))
	if !strings.Contains(w.Body.String(), `"color":"#f87171"`) || !strings.Contains(w.Body.String(), `"key":"anticontrol"`) {
		t.Fatalf("catalog: %s", w.Body)
	}
}
