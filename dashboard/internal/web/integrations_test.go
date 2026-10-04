package web

import (
	"strings"
	"testing"

	"github.com/Kljub/BothubV3/dashboard/internal/api"
	"github.com/Kljub/BothubV3/dashboard/ui"
)

func TestIntegrationsRender(t *testing.T) {
	tpl, err := parseTemplates(ui.FS)
	if err != nil {
		t.Fatal(err)
	}
	set := &secretRow{GlobalSecret: api.GlobalSecret{Key: "SPOTIFY_CLIENT_SECRET"}, Updated: "today"}
	v := secretsView{secretScope: userSecrets, Integrations: []integrationRow{
		{integration: integrations[0], ID: &secretRow{GlobalSecret: api.GlobalSecret{Key: "SPOTIFY_CLIENT_ID"}}, Secret: set},
		{integration: integrations[1]},
		{integration: integrations[2], RedirectURI: "https://bothub.example/auth/oauth/google/callback"},
		{integration: integrations[3], RedirectURI: "https://bothub.example/auth/oauth/github/callback"},
	}}
	var out strings.Builder
	if err := tpl.sets["admin"].ExecuteTemplate(&out, "api_secrets_fragment", Page{Data: v}); err != nil {
		t.Fatal(err)
	}
	html := out.String()
	for _, want := range []string{`hx-post="/account/integrations/spotify"`, `hx-post="/account/integrations/twitch"`, "TWITCH_CLIENT_SECRET", "admin.integrations.connected", `hx-delete="/account/integrations/spotify"`, "admin.integrations.not_set", `hx-post="/account/integrations/google"`, `value="https://bothub.example/auth/oauth/google/callback" readonly`, "GOOGLE_OAUTH_CLIENT_SECRET", `hx-post="/account/integrations/github"`, "/auth/oauth/github/callback"} {
		if !strings.Contains(html, want) {
			t.Errorf("missing %q", want)
		}
	}
	if strings.Contains(html, `hx-delete="/account/integrations/twitch"`) {
		t.Error("nothing to delete while Twitch is not set up")
	}
}

func TestAdminSecretsShowMarketTokenOnly(t *testing.T) {
	tpl, err := parseTemplates(ui.FS)
	if err != nil {
		t.Fatal(err)
	}
	var out strings.Builder
	v := secretsView{secretScope: adminSecrets}
	if err := tpl.sets["admin"].ExecuteTemplate(&out, "api_secrets_fragment", Page{Data: v}); err != nil {
		t.Fatal(err)
	}
	html := out.String()
	if !strings.Contains(html, "admin.market.title") || strings.Contains(html, "admin.integrations.title") || strings.Contains(html, "/account/") {
		t.Errorf("admin tab: market token only, got %s", html)
	}
}
