package web

import (
	"strings"
	"testing"

	"github.com/Kljub/BothubV3/dashboard/internal/api"
	"github.com/Kljub/BothubV3/dashboard/ui"
)

func TestServerListAccess(t *testing.T) {
	tpl, err := parseTemplates(ui.FS)
	if err != nil {
		t.Fatal(err)
	}
	data := map[string]any{
		"Bot":    api.Bot{ID: 3},
		"Guilds": []api.Guild{{ID: "100000000000000001", Name: "Home"}, {ID: "100000000000000002", Name: "Other"}},
		"Access": accessView{Loaded: true, Closed: true, Allowed: map[string]bool{"100000000000000001": true}, Planned: []api.AccessGuild{{ID: "200000000000000009"}}},
	}
	var out strings.Builder
	if err := tpl.sets["bot"].ExecuteTemplate(&out, "server_list_fragment", Page{Data: data}); err != nil {
		t.Fatal(err)
	}
	html := out.String()
	for _, want := range []string{`hx-put="/bot/3/guild-access"`, `name="closed" value="true" checked`, `value="100000000000000001"`, "200000000000000009", "access.disallow_confirm"} {
		if !strings.Contains(html, want) {
			t.Errorf("missing %q", want)
		}
	}
	if strings.Count(html, `name="allowed" value="true" checked`) != 1 {
		t.Error("only the allowed server is switched on")
	}
}
