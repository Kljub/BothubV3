package web

import (
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
