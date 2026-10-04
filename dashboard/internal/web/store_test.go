package web

import (
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"testing"

	"github.com/Kljub/BothubV3/dashboard/internal/api"
	"github.com/Kljub/BothubV3/dashboard/ui"
)

func storeTestItems() []storeItem {
	return []storeItem{
		{ID: "plugin_weather", Name: "<b>Weather</b>", Icon: "🌤️", Category: "utility", Published: "1.1.0", Installed: "1.0.0", Update: true},
		{ID: "plugin_casino", Name: "Casino", Description: "Blackjack and slots", Icon: "🎰", Category: "fun", Published: "1.0.0"},
		{ID: "plugin_draft", Name: "Draft", Icon: "🧩", Category: "utility"},
	}
}

func TestStoreFilter(t *testing.T) {
	ids := func(v storeView) string {
		var out []string
		for _, it := range v.Items {
			out = append(out, it.ID)
		}
		return strings.Join(out, ",")
	}
	cases := []struct{ query, want string }{
		{"", "plugin_weather,plugin_casino,plugin_draft"},
		{"cat=fun", "plugin_casino"},
		{"filter=installed", "plugin_weather"},
		{"filter=updates", "plugin_weather"},
		{"q=SLOTS", "plugin_casino"},
		{"cat=bogus&filter=bogus", "plugin_weather,plugin_casino,plugin_draft"},
	}
	for _, c := range cases {
		v := storeFilter(httptest.NewRequest("GET", "/store?"+c.query, nil))
		v.apply(storeTestItems())
		if got := ids(v); got != c.want || v.Total != 3 {
			t.Errorf("%q: got %q (total %d), want %q", c.query, got, v.Total, c.want)
		}
	}
	if !newerVersion("1.10.0", "1.9.3") || newerVersion("1.0.0", "1.0.0") {
		t.Error("newerVersion compares numerically")
	}
}

func TestStoreRender(t *testing.T) {
	tpl, err := parseTemplates(ui.FS)
	if err != nil {
		t.Fatal(err)
	}
	v := storeView{Filter: "all", Categories: storeCategories, Filters: storeFilters}
	v.apply(storeTestItems())
	var out strings.Builder
	if err := tpl.sets["store"].ExecuteTemplate(&out, "store_grid_fragment", Page{Data: v}); err != nil {
		t.Fatal(err)
	}
	html := out.String()
	for _, want := range []string{`id="store-grid"`, `href="/store/plugin_weather"`, "&lt;b&gt;Weather", "module-group-fun", "store.badge.update", "store.badge.unpublished"} {
		if !strings.Contains(html, want) {
			t.Errorf("grid: missing %q", want)
		}
	}

	// Detail: install button only with a release; blocked permissions warned.
	d := storeDetail{Item: storeItem{
		ID: "plugin_casino", Name: "Casino", Icon: "🎰", Category: "fun", Published: "1.0.0",
		Layers:            &api.MarketLayers{Commands: 3, Nodes: 1},
		Permissions:       []storePermission{{Key: "storage", Risk: "low", Enabled: true}, {Key: "economy", Risk: "medium"}},
		MarketPermissions: []storePermission{{Key: "storage", Risk: "low", Enabled: true}, {Key: "economy", Risk: "medium"}},
		Secrets:           []string{"CASINO_KEY"},
	}, Blocked: 1, Grant: 2}
	out.Reset()
	if err := tpl.sets["store"].ExecuteTemplate(&out, "store_detail_fragment", Page{Data: d}); err != nil {
		t.Fatal(err)
	}
	html = out.String()
	for _, want := range []string{`hx-post="/store/plugin_casino/install"`, `name="version" value="1.0.0"`, `data-open-dialog="store-install-dialog"`, "store.consent.will_enable", "store.consent.default_on", "store.consent.auto", "sdk.perm.economy", "store.perm.off", "CASINO_KEY", "store.layer.commands"} {
		if !strings.Contains(html, want) {
			t.Errorf("detail: missing %q", want)
		}
	}
	if strings.Contains(html, "hx-delete") {
		t.Error("a plugin that is not installed has no uninstall")
	}

	d.Item.Published, d.Item.Installed = "", "1.0.0"
	out.Reset()
	if err := tpl.sets["store"].ExecuteTemplate(&out, "store_detail_fragment", Page{Data: d}); err != nil {
		t.Fatal(err)
	}
	html = out.String()
	if strings.Contains(html, "/install") || !strings.Contains(html, `hx-delete="/store/plugin_casino?deleteCommands=1"`) {
		t.Error("installed without release: no install button, uninstall with command choice")
	}

	// Installed but an SDK is off: alert with the grant button, instance switch.
	d.Item.Installed = "1.0.0"
	d.Item.Info = &installedInfo{Enabled: true, BlockedBy: []string{"economy"}}
	out.Reset()
	if err := tpl.sets["store"].ExecuteTemplate(&out, "store_detail_fragment", Page{Data: d}); err != nil {
		t.Fatal(err)
	}
	html = out.String()
	for _, want := range []string{`hx-post="/store/plugin_casino/grant"`, "store.blocked_installed", `hx-put="/store/plugin_casino/enabled"`, `name="enabled" value="true" checked`} {
		if !strings.Contains(html, want) {
			t.Errorf("blocked detail: missing %q", want)
		}
	}

	// Installed upload: endpoint share form, install facts, no market version.
	d = storeDetail{Item: storeItem{
		ID: "plugin_local", Name: "Local", Icon: "🧩", Category: "utility", Installed: "2.0.0", Uploaded: true,
		Layers: &api.MarketLayers{}, Secrets: []string{"LOCAL_KEY"},
		Info: &installedInfo{SHA: "abcdef123456", InstalledAt: "today", Tasks: []string{"tick · 5m"},
			Secrets: []secretShareRow{{Key: "LOCAL_KEY", Exists: true, Shared: true}}},
	}}
	out.Reset()
	if err := tpl.sets["store"].ExecuteTemplate(&out, "store_detail_fragment", Page{Data: d}); err != nil {
		t.Fatal(err)
	}
	html = out.String()
	for _, want := range []string{`hx-put="/store/plugin_local/secrets"`, `value="LOCAL_KEY" checked`, "abcdef123456", "tick · 5m", "store.uploaded_hint", `hx-delete="/store/plugin_local"`} {
		if !strings.Contains(html, want) {
			t.Errorf("uploaded detail: missing %q", want)
		}
	}
	if strings.Contains(html, "deleteCommands") || strings.Contains(html, "/install") {
		t.Error("no commands: single uninstall; uploaded: no market install")
	}

	// hx-trigger must not use [..] filters: they need eval, which the CSP blocks.
	out.Reset()
	if err := tpl.sets["store"].ExecuteTemplate(&out, "layout", Page{Data: storePage{List: &v}}); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out.String(), `hx-post="/store/upload"`) {
		t.Error("the store page has the zip upload")
	}
	if strings.Contains(out.String(), "[name=") {
		t.Error("hx-trigger with an attribute filter needs eval")
	}

	// Full page renders both variants through the layout.
	for _, data := range []storePage{{List: &v}, {Detail: &d}} {
		out.Reset()
		if err := tpl.sets["store"].ExecuteTemplate(&out, "layout", Page{Data: data}); err != nil {
			t.Fatal(err)
		}
	}
}

// A plugin blocked by an SDK that is off gets the red Disabled badge next to the plugin badge.
func TestPluginCardDisabledBadge(t *testing.T) {
	tpl, err := parseTemplates(ui.FS)
	if err != nil {
		t.Fatal(err)
	}
	card := pluginView{BotID: 1, InstalledPlugin: api.InstalledPlugin{ID: "plugin_x", Name: "X", BlockedBy: []string{"http.outbound"}}}
	var out strings.Builder
	if err := tpl.sets["bot"].ExecuteTemplate(&out, "plugin_card_fragment", Page{Data: card}); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out.String(), `class="badge-plugin"`) || !strings.Contains(out.String(), `class="badge-disabled"`) {
		t.Error("Disabled badge with the missing SDK")
	}
	card.BlockedBy = nil
	out.Reset()
	if err := tpl.sets["bot"].ExecuteTemplate(&out, "plugin_card_fragment", Page{Data: card}); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(out.String(), "badge-disabled") {
		t.Error("no badge without a blocked SDK")
	}
}

// The plugin page lists the plugin's commands with a toggle and the builder link.
func TestPluginCommandRow(t *testing.T) {
	tpl, err := parseTemplates(ui.FS)
	if err != nil {
		t.Fatal(err)
	}
	plugin := "plugin_anisearch"
	row := pluginCommandView{BotID: 3, Plugin: plugin, CustomCommand: api.CustomCommand{ID: 77, Name: "launchtoday", Enabled: true, Private: true, PluginID: &plugin}}
	var out strings.Builder
	if err := tpl.sets["module_item"].ExecuteTemplate(&out, "plugin_command_row_fragment", Page{Data: row}); err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"/launchtoday", `href="/bots/builder/77"`, `hx-put="/bot/3/plugins/plugin_anisearch/commands/77"`, `value="true" checked`, `name="private"`, `<option value="true" selected>`} {
		if !strings.Contains(out.String(), want) {
			t.Errorf("missing %q", want)
		}
	}
}

// Plugin blocks reach the builder with ports, labels and their texts.
func TestCollectPluginTexts(t *testing.T) {
	def := map[string]any{
		"labelKey": "plugin.plugin_x.node.a.label",
		"results":  []any{map[string]any{"suffix": "", "labelKey": "plugin.plugin_x.result.main"}},
		"config":   map[string]any{"properties": map[string]any{"title": map[string]any{"x-labelKey": "plugin.plugin_x.cfg.title"}}},
		"other":    map[string]any{"labelKey": "builder.port.in"},
	}
	var got []string
	collectPluginTexts(def, "plugin.plugin_x.", func(k string) { got = append(got, k) })
	slices.Sort(got)
	if strings.Join(got, ",") != "plugin.plugin_x.cfg.title,plugin.plugin_x.node.a.label,plugin.plugin_x.result.main" {
		t.Errorf("keys: %v", got)
	}
}

func TestInstalledDetailsMissing(t *testing.T) {
	pl := api.AdminPlugin{SecretShares: map[string]api.SecretShare{
		"OVERSEERR_URL": {Exists: true, Set: true, Shared: true},
		"OVERSEERR_KEY": {Exists: true, Set: false, Shared: true},
		"OTHER_KEY":     {Exists: true, Set: true, Shared: false},
	}}
	m := manifestSummary{
		Secrets: []string{"PLEX_TOKEN", "PLEX_URL", "PLEX_TOKEN_2", "PLEX_URL_2", "OVERSEERR_URL", "OVERSEERR_KEY", "OTHER_KEY", "GONE_KEY"},
		Connect: map[string]string{"PLEX_TOKEN": "plex", "PLEX_TOKEN_2": "plex"},
	}
	got := installedDetails(pl, m, "en").Missing
	// OTHER_KEY and GONE_KEY are switched off (not shared): the admin does not need them.
	want := []missingSecret{{Provider: "plex"}, {Key: "OVERSEERR_KEY"}}
	if !slices.Equal(got, want) {
		t.Fatalf("missing = %v, want %v", got, want)
	}
	pl.SecretShares["PLEX_TOKEN_2"] = api.SecretShare{Exists: true, Set: true, Shared: true}
	if got := installedDetails(pl, m, "en").Missing; got[0] != (missingSecret{Key: "OVERSEERR_KEY"}) {
		t.Fatalf("one connected Plex server is enough, got %v", got)
	}
}

func TestConnectBounce(t *testing.T) {
	s := &Server{}
	state := strings.Repeat("ab", 16)
	req := httptest.NewRequest(http.MethodGet, "/store/plugin_plex/connect/PLEX_TOKEN/done?state="+state, nil)
	req.SetPathValue("plugin", "plugin_plex")
	req.SetPathValue("secret", "PLEX_TOKEN")
	rec := httptest.NewRecorder()
	s.handleConnectBounce(rec, req)
	body := rec.Body.String()
	if rec.Code != http.StatusOK || !strings.Contains(body, `content="0;url=/store/plugin_plex/connect/PLEX_TOKEN/finish?state=`+state+`"`) {
		t.Fatalf("bounce page: %d %s", rec.Code, body)
	}
	if rec.Header().Get("Content-Security-Policy") != "default-src 'none'" {
		t.Fatal("bounce page needs a strict CSP")
	}
	bad := httptest.NewRequest(http.MethodGet, "/store/plugin_plex/connect/PLEX_TOKEN/done?state=%22%3E%3Cscript%3E", nil)
	bad.SetPathValue("plugin", "plugin_plex")
	bad.SetPathValue("secret", "PLEX_TOKEN")
	rec = httptest.NewRecorder()
	s.handleConnectBounce(rec, bad)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("bad state must be refused, got %d", rec.Code)
	}
}
