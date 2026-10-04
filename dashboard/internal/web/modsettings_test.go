package web

import (
	"net/url"
	"path/filepath"
	"strings"
	"testing"

	"github.com/Kljub/BothubV3/dashboard/internal/api"
	"github.com/Kljub/BothubV3/dashboard/internal/i18n"
	"github.com/Kljub/BothubV3/dashboard/ui"
)

func loadSchemas(t *testing.T) []settingsSchema {
	t.Helper()
	all := loadSchemaDir(filepath.Join(sharedDir(), "module-settings"))
	if len(all) == 0 {
		t.Fatal("no module settings found")
	}
	out := make([]settingsSchema, 0, len(all))
	for _, sc := range all {
		out = append(out, sc)
	}
	return out
}

// Every field, list field and select option has an English label.
func TestModuleSettingsLabels(t *testing.T) {
	b, err := i18n.Load(ui.FS, "lang")
	if err != nil {
		t.Fatal(err)
	}
	has := map[string]bool{}
	for _, k := range b.Keys(i18n.Fallback) {
		has[k] = true
	}
	for _, sc := range loadSchemas(t) {
		var walk func(prefix string, fs []settingsField)
		walk = func(prefix string, fs []settingsField) {
			for _, f := range fs {
				key := prefix + f.Key
				if !has[key] {
					t.Errorf("missing label %s", key)
				}
				if f.Hint && !has[key+"_hint"] {
					t.Errorf("missing hint %s_hint", key)
				}
				for _, o := range f.Options {
					if !has[key+"."+o] {
						t.Errorf("missing option label %s.%s", key, o)
					}
				}
				if f.Type == "list" {
					walk(key+".", f.Item)
				}
			}
		}
		walk("modset."+sc.Module+".", sc.Fields)
		if !has["module."+sc.Module+".name"] {
			t.Errorf("missing module name for %s", sc.Module)
		}
	}
}

// Every settings form renders, with a server, a list entry and selected refs.
func TestModuleSettingsRender(t *testing.T) {
	tpl, err := parseTemplates(ui.FS)
	if err != nil {
		t.Fatal(err)
	}
	for _, sc := range loadSchemas(t) {
		labels := "modset." + sc.Module + "."
		v := settingsView{BotID: 1, Module: sc.Module, Base: "/bot/1/modules/" + sc.Module + "/settings", Guilds: []settingsGuild{{
			ID: "900000000000000001", Name: "Test",
			Channels: []api.GuildChannel{{ID: "900000000000000002", Name: "general", Type: "text"}},
			Roles:    []api.GuildRole{{ID: "900000000000000003", Name: "Member"}},
		}}}
		cfg := map[string]any{}
		ref := map[string]any{"guild": "900000000000000001", "id": "900000000000000002"}
		for _, f := range sc.Fields {
			if f.Type == "list" {
				item := itemDefaults(f.Item)
				for _, it := range f.Item {
					if it.Type == "channel" {
						item[it.Key] = ref
					}
				}
				cfg[f.Key] = []any{item}
			}
		}
		v.Values = cfg
		s := &Server{}
		v.Top = s.buildFields(&v, labels, "", sc.Fields, cfg)
		for _, f := range sc.Fields {
			if f.Type != "list" {
				continue
			}
			items := cfg[f.Key].([]any)
			lv := settingsListView{Field: fieldView{settingsField: f, Label: "modset." + sc.Module + "." + f.Key}}
			lv.Items = []settingsItemView{{Index: 0, Title: s.itemTitle(v, f, items[0].(map[string]any), 0), Fields: s.buildFields(&v, labels, f.Key+".", f.Item, items[0].(map[string]any))}}
			lv.New = s.buildFields(&v, labels, f.Key+".", f.Item, itemDefaults(f.Item))
			v.Lists = append(v.Lists, lv)
		}
		var out strings.Builder
		if err := tpl.sets["module_item"].ExecuteTemplate(&out, "module_settings_fragment", Page{Data: v}); err != nil {
			t.Fatalf("%s: %v", sc.Module, err)
		}
		if !strings.Contains(out.String(), "/bot/1/modules/"+sc.Module+"/settings") {
			t.Errorf("%s: no form target", sc.Module)
		}
	}
}

// Form values become the config shapes the API expects.
func TestFormValues(t *testing.T) {
	fields := []settingsField{
		{Key: "on", Type: "bool"}, {Key: "off", Type: "bool"}, {Key: "n", Type: "number"},
		{Key: "ch", Type: "channel"}, {Key: "chs", Type: "channels"}, {Key: "w", Type: "words"},
		{Key: "e", Type: "emojis"}, {Key: "m", Type: "message"}, {Key: "s", Type: "select"},
	}
	form := url.Values{
		"on": {"true"}, "n": {" 12 "}, "ch": {"1:2"}, "chs": {"1:2", "bad", "3:4"},
		"w": {"a\n\n b \r\nc"}, "e": {"👍, 🎉  <:x:123456789012345678>"}, "m.mode": {"embed"}, "m.title": {" Hi "}, "s": {"x"},
	}
	got := formValues(fields, form)
	if got["on"] != true || got["off"] != false || got["n"] != 12 || got["s"] != "x" {
		t.Errorf("scalars: %v", got)
	}
	if ch, _ := got["ch"].(map[string]string); ch["guild"] != "1" || ch["id"] != "2" {
		t.Errorf("channel: %v", got["ch"])
	}
	if len(got["chs"].([]any)) != 2 {
		t.Errorf("channels: %v", got["chs"])
	}
	if w := got["w"].([]string); strings.Join(w, "|") != "a|b|c" {
		t.Errorf("words: %v", w)
	}
	if e := got["e"].([]string); len(e) != 3 {
		t.Errorf("emojis: %v", e)
	}
	if m := got["m"].(map[string]string); m["mode"] != "embed" || m["title"] != "Hi" {
		t.Errorf("message: %v", m)
	}
}
