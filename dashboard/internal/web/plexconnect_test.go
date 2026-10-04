package web

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/Kljub/BothubV3/dashboard/ui"
)

func TestPlexCalls(t *testing.T) {
	polls := 0
	fake := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("X-Plex-Client-Identifier") != "client-1" || r.Header.Get("X-Plex-Product") != "BotHub" {
			http.Error(w, "headers", http.StatusBadRequest)
			return
		}
		switch {
		case r.Method == http.MethodPost && r.URL.Path == "/api/v2/pins":
			_ = json.NewEncoder(w).Encode(map[string]any{"id": 42, "code": "abcd"})
		case r.URL.Path == "/api/v2/pins/42":
			polls++
			token := ""
			if polls > 1 { // the first poll comes before Plex finished
				token = "tok-1"
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"id": 42, "authToken": token})
		case r.URL.Path == "/api/v2/resources":
			if r.Header.Get("X-Plex-Token") != "tok-1" {
				http.Error(w, "token", http.StatusUnauthorized)
				return
			}
			_ = json.NewEncoder(w).Encode([]map[string]any{
				{"name": "Player", "provides": "client", "owned": true, "connections": []map[string]any{{"uri": "http://player:1", "local": true}}},
				{"name": "Friend", "provides": "server", "owned": false, "connections": []map[string]any{{"uri": "http://friend:32400", "local": true}}},
				{"name": "Home", "provides": "server", "owned": true, "connections": []map[string]any{
					{"uri": "https://relay.plex.direct:8443", "relay": true},
					{"uri": "https://1-2-3-4.abc.plex.direct:32400", "local": false},
					{"uri": "https://192-168-1-5.abc.plex.direct:32400", "local": true},
				}},
			})
		default:
			http.NotFound(w, r)
		}
	}))
	defer fake.Close()
	plexTVURL, plexClientsURL = fake.URL, fake.URL

	ctx := context.Background()
	pin, err := plexCreatePin(ctx, "client-1")
	if err != nil || pin.ID != 42 || pin.Code != "abcd" {
		t.Fatalf("pin: %+v %v", pin, err)
	}
	token, err := plexPinToken(ctx, "client-1", 42)
	if err != nil || token != "tok-1" || polls != 2 {
		t.Fatalf("token %q after %d polls: %v", token, polls, err)
	}
	name, address, err := plexServer(ctx, "client-1", token)
	if err != nil || name != "Home" || address != "https://192-168-1-5.abc.plex.direct:32400" {
		t.Fatalf("server: %q %q %v", name, address, err)
	}
	if _, _, err := plexServer(ctx, "client-1", "wrong"); err == nil {
		t.Error("wrong token must fail")
	}
}

func TestStoreConnectBox(t *testing.T) {
	tpl, err := parseTemplates(ui.FS)
	if err != nil {
		t.Fatal(err)
	}
	rows := []connectRow{{Key: "PLEX_TOKEN", Provider: "plex", Connected: true, Name: "Home"}, {Key: "PLEX_TOKEN_2", Provider: "plex"}, {Key: "PLEX_TOKEN_3", Provider: "plex"}}
	d := storeDetail{Item: storeItem{ID: "plugin_plex", Name: "Plex", Icon: "🎬", Category: "social", Installed: "1.0.0",
		Info: &installedInfo{Enabled: true, BlockedBy: []string{"secrets.use"}, Connect: rows}}, Connect: connectGroups(rows)}
	var out strings.Builder
	if err := tpl.sets["store"].ExecuteTemplate(&out, "store_detail_fragment", Page{Data: d}); err != nil {
		t.Fatal(err)
	}
	html := out.String()
	box, alert := strings.Index(html, `hx-post="/store/plugin_plex/connect/PLEX_TOKEN_2"`), strings.Index(html, "store.blocked_installed")
	if box < 0 || !strings.Contains(html, "store.connect.another") {
		t.Fatal("next free slot button missing")
	}
	for _, want := range []string{"Home", `hx-delete="/store/plugin_plex/connect/PLEX_TOKEN"`, `hx-post="/store/plugin_plex/connect/PLEX_TOKEN"`} {
		if !strings.Contains(html, want) {
			t.Errorf("connected server row: missing %q", want)
		}
	}
	if strings.Contains(html, "connect/PLEX_TOKEN_3") {
		t.Error("only the next free slot gets a button")
	}
	if addressKeyFor("PLEX_TOKEN") != "PLEX_URL" || addressKeyFor("PLEX_TOKEN_2") != "PLEX_URL_2" || addressKeyFor("OVERSEERR_KEY") != "OVERSEERR_KEY_URL" {
		t.Error("address secret names")
	}
	if alert < 0 || box > alert {
		t.Error("the sign-in box sits above the SDK alert")
	}
}
