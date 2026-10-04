package web

import (
	"bytes"
	"html/template"
	"strings"
	"testing"

	"github.com/Kljub/BothubV3/dashboard/internal/api"
	"github.com/Kljub/BothubV3/dashboard/internal/i18n"
	"github.com/Kljub/BothubV3/dashboard/ui"
)

func sdkTestServer(t *testing.T) *Server {
	t.Helper()
	b, err := i18n.Load(ui.FS, "lang")
	if err != nil {
		t.Fatal(err)
	}
	return &Server{i18n: b}
}

func TestSdkPoliciesTemplate(t *testing.T) {
	tpl, err := parseTemplates(ui.FS)
	if err != nil {
		t.Fatal(err)
	}
	set, err := tpl.sets["admin"].Clone()
	if err != nil {
		t.Fatal(err)
	}
	set.Funcs(template.FuncMap{"t": func(key string, _ ...any) string { return key }})
	s := sdkTestServer(t)
	view := s.sdkView([]api.SdkPolicy{
		{Permission: "storage", Group: "storage", Risk: "low", Calls: []string{"storage.get", "storage.set"}, Implemented: 2, Mode: "default", Enabled: true},
		{Permission: "http.outbound", Group: "network", Risk: "high", Calls: []string{"http.get"}, Mode: "deny", Enabled: false},
	}, "en", "storage", "")
	var buf bytes.Buffer
	if err := set.ExecuteTemplate(&buf, "sdk_policies_page", view); err != nil {
		t.Fatal(err)
	}
	out := buf.String()
	for _, want := range []string{`hx-put="/admin/sdk-policies/storage"`, `sdk.mode.allow`, `sdk.policies.by_risk`, `settings-card`, `sdk.risk_group.high`, `sdk.policies.planned`,
		`sdk-group" open`, `"group": "storage"`, `sdk.policies.group_count`, `id="sdk-search"`, `hx-get="/admin/sdk-policies"`, `hx-include="#sdk-search"`, "Internet requests"} {
		if !strings.Contains(out, want) {
			t.Errorf("missing %q", want)
		}
	}
	// One pressed segment per row: default for storage, deny for http.outbound.
	if n := strings.Count(out, `aria-pressed="true"`); n != 2 {
		t.Errorf("pressed segments = %d, want 2", n)
	}
}

// Groups are sorted by their translated name, permissions inside too; the
// group of the last change stays open.
func TestSdkGroupsSorted(t *testing.T) {
	s := sdkTestServer(t)
	items := []api.SdkPolicy{
		{Permission: "storage", Group: "storage", Enabled: true},
		{Permission: "discord.members.kick", Group: "members"},
		{Permission: "discord.members.ban", Group: "members", Enabled: true},
		{Permission: "http.outbound", Group: "network"},
		{Permission: "discord.voice.speak", Group: "voice"},
	}
	groups, _ := s.sdkGroups(items, "de", "members", "")
	var keys []string
	for _, g := range groups {
		keys = append(keys, g.Key)
	}
	// Mitglieder, Netzwerk und Secrets, Speicher, Voice
	if strings.Join(keys, ",") != "members,network,storage,voice" {
		t.Errorf("order: %v", keys)
	}
	if !groups[0].Open || groups[0].On != 1 || groups[0].Items[0].Permission != "discord.members.ban" {
		t.Errorf("members group: %+v", groups[0])
	}
}

// Modules: "all modules" first, then one sub-heading per module; the
// per-module permission takes the module's name.
func TestSdkModulesAndSearch(t *testing.T) {
	s := sdkTestServer(t)
	items := []api.SdkPolicy{
		{Permission: "modules.moderation.read", Group: "modules", Module: "moderation"},
		{Permission: "modules.economy.balance.write", Group: "modules", Module: "economy"},
		{Permission: "modules.read", Group: "modules", Module: "all"},
		{Permission: "modules.economy.read", Group: "modules", Module: "economy"},
		{Permission: "storage", Group: "storage", Calls: []string{"storage.get"}},
	}
	groups, hits := s.sdkGroups(items, "en", "", "")
	if hits != 5 || groups[0].Key != "modules" {
		t.Fatalf("groups: %+v", groups)
	}
	var rows []string
	for _, r := range groups[0].Items {
		rows = append(rows, r.Permission+"|"+r.ModuleLabel)
	}
	want := "modules.read|All modules,modules.economy.balance.write|Economy,modules.economy.read|,modules.moderation.read|Moderation"
	if strings.Join(rows, ",") != want {
		t.Errorf("rows:\n got %s\nwant %s", strings.Join(rows, ","), want)
	}
	if groups[0].Items[2].Label != "Read Economy" {
		t.Errorf("per-module label: %q", groups[0].Items[2].Label)
	}

	// Search: by module name, by function; matching groups open.
	groups, hits = s.sdkGroups(items, "en", "", "moderation")
	if hits != 1 || !groups[0].Open || groups[0].Items[0].Permission != "modules.moderation.read" {
		t.Errorf("search moderation: %d %+v", hits, groups)
	}
	if _, hits = s.sdkGroups(items, "en", "", "storage.get"); hits != 1 {
		t.Errorf("search by function: %d", hits)
	}
	if groups, hits = s.sdkGroups(items, "en", "", "nothing here"); hits != 0 || len(groups) != 0 {
		t.Errorf("no match: %d", hits)
	}
}
