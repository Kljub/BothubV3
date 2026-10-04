package i18n

import (
	"strings"
	"testing"
	"testing/fstest"
)

func testBundle(t *testing.T) *Bundle {
	t.Helper()
	b, err := Load(fstest.MapFS{
		"lang/en.json": {Data: []byte(`{"nav.bots":"Bots"}`)},
		"lang/de.json": {Data: []byte(`{"nav.bots":"Bots DE"}`)},
	}, "lang")
	if err != nil {
		t.Fatal(err)
	}
	return b
}

// Plugin texts fill only their own prefix and fall back to English.
func TestPluginTexts(t *testing.T) {
	b := testBundle(t)
	b.SetPlugin("greeter", map[string]map[string]string{
		"en": {
			"plugin.greeter.name":  "Greeter",
			"plugin.greeter.hello": "Hi {user}",
			"plugin.other.name":    "stolen",
			"nav.bots":             "hijacked",
			"plugin.greeter.long":  strings.Repeat("x", 501),
		},
		"de": {"plugin.greeter.name": "Begrüßer"},
		"xx": {"plugin.greeter.name": "unknown locale"},
	})
	cases := map[[2]string]string{
		{"de", "plugin.greeter.name"}:  "Begrüßer",
		{"de", "plugin.greeter.hello"}: "Hi Ann",
		{"en", "plugin.other.name"}:    "plugin.other.name",
		{"en", "nav.bots"}:             "Bots",
		{"en", "plugin.greeter.long"}:  "plugin.greeter.long",
	}
	for in, want := range cases {
		if got := b.T(in[0], in[1], "user", "Ann"); got != want {
			t.Errorf("T(%s, %s) = %q, want %q", in[0], in[1], got, want)
		}
	}
	b.SetPlugin("greeter", nil)
	if got := b.T("en", "plugin.greeter.name"); got != "plugin.greeter.name" {
		t.Errorf("texts not replaced: %q", got)
	}
}
