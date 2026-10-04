package web

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/Kljub/BothubV3/dashboard/internal/api"
	"github.com/Kljub/BothubV3/dashboard/ui"
)

// A plugin's manifest settings render with the module renderer, with plugin
// labels and plugin form targets.
func TestPluginSettingsRender(t *testing.T) {
	tpl, err := parseTemplates(ui.FS)
	if err != nil {
		t.Fatal(err)
	}
	pl := api.InstalledPlugin{ID: "plugin_greeter", Manifest: json.RawMessage(`{"id":"plugin_greeter","settings":{"fields":[
		{"key":"enabled","type":"bool","default":true},
		{"key":"style","type":"select","options":["short","long"]},
		{"key":"greetings","type":"list","max":10,"titleField":"text","item":[{"key":"text","type":"text"}]}]}}`)}
	sc, ok := pluginSchema(pl)
	if !ok || len(sc.Fields) != 3 {
		t.Fatalf("schema not read: %v %+v", ok, sc)
	}
	if _, ok := pluginSchema(api.InstalledPlugin{ID: "x", Manifest: json.RawMessage(`{"id":"x"}`)}); ok {
		t.Fatal("plugin without settings must have no schema")
	}

	cfg := map[string]any{"enabled": true, "style": "long", "greetings": []any{map[string]any{"text": "<b>hi</b>"}}}
	s := &Server{}
	scope := s.pluginScope(7, pl, sc)
	scope.load = func(*http.Request) (map[string]any, error) { return cfg, nil }
	v, err := s.scopeData(httptest.NewRequest("GET", "/", nil), 7, scope)
	if err != nil {
		t.Fatal(err)
	}
	var out strings.Builder
	if err := tpl.sets["module_item"].ExecuteTemplate(&out, "module_settings_fragment", Page{Data: v}); err != nil {
		t.Fatal(err)
	}
	html := out.String()
	for _, want := range []string{
		`hx-put="/bot/7/plugins/plugin_greeter/settings"`,
		`hx-put="/bot/7/plugins/plugin_greeter/settings/greetings/0"`,
		`hx-post="/bot/7/plugins/plugin_greeter/settings/greetings"`,
		"plugin.plugin_greeter.setting.style.long",
		"&lt;b&gt;hi&lt;/b&gt;",
	} {
		if !strings.Contains(html, want) {
			t.Errorf("missing %q", want)
		}
	}
	if strings.Contains(html, "<b>hi</b>") || strings.Contains(html, "modset.plugin_greeter") {
		t.Error("unescaped value or module labels in plugin form")
	}
}
