package web

import (
	"context"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/Kljub/BothubV3/dashboard/internal/api"
	"github.com/Kljub/BothubV3/dashboard/ui"
)

func TestInvitePage(t *testing.T) {
	tpl, err := parseTemplates(ui.FS)
	if err != nil {
		t.Fatal(err)
	}
	set := tpl.sets["invite"]
	if set == nil {
		t.Fatal("no template set for invite.html")
	}
	app := "123456789012345678"
	for _, c := range []struct {
		v    invitePageView
		want []string
		not  string
	}{
		{invitePageView{Bot: api.InviteBot{Name: "Njetflix <X>"}, Allowed: true, Link: inviteURL(&app), Lang: "de"}, []string{"Njetflix &lt;X&gt;", "Zu Discord hinzufügen", "client_id=" + app}, "privat"},
		{invitePageView{Bot: api.InviteBot{Name: "Njetflix"}, Lang: "de"}, []string{"Dieser Bot ist privat", `href="/login"`}, "client_id"},
		{invitePageView{Bot: api.InviteBot{Name: "Njetflix"}, Allowed: true, Link: inviteURL(&app), Lang: "en"}, []string{"Add to Discord"}, "private"},
	} {
		var out strings.Builder
		if err := set.ExecuteTemplate(&out, "invite_layout", Page{Data: c.v}); err != nil {
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
	r := httptest.NewRequest("GET", "http://bothub.example/bots/invite", nil)
	if got := customInviteURL(r, &app); got != "http://bothub.example/invite/"+app {
		t.Fatalf("custom invite URL: %s", got)
	}
	bad := "x"
	if customInviteURL(r, &bad) != "" || customInviteURL(r, nil) != "" {
		t.Fatal("no URL without a valid application ID")
	}
}

func TestBotInviteURL(t *testing.T) {
	app := "123456789012345678"
	on := false
	customInviteOn.Lock()
	old := customInviteOn.fetch
	customInviteOn.fetch = func(_ context.Context, _ string) bool { return on }
	customInviteOn.Unlock()
	defer func() {
		customInviteOn.Lock()
		customInviteOn.fetch = old
		customInviteOn.Unlock()
		clearInviteCache()
	}()
	clearInviteCache()
	if got := botInviteURL(&app); !strings.HasPrefix(got, "https://discord.com/oauth2/authorize") {
		t.Fatalf("off: Discord's link, got %s", got)
	}
	on = true
	if got := botInviteURL(&app); !strings.HasPrefix(got, "https://discord.com/") {
		t.Fatal("cached for 30 s")
	}
	clearInviteCache() // saving the settings clears the cache
	if got := botInviteURL(&app); got != "/invite/"+app {
		t.Fatalf("on: custom page, got %s", got)
	}
}
