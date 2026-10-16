package web

import (
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
