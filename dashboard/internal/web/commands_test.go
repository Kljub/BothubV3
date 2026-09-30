package web

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/Kljub/BothubV3/dashboard/internal/api"
	"github.com/Kljub/BothubV3/dashboard/ui"
)

func sharedDir() string {
	if d := os.Getenv("SHARED_DIR"); d != "" {
		return d
	}
	return filepath.Join("..", "..", "..", "shared")
}

// Every built-in command on a module page must open its preset copy in the
// command builder (gear button), although both files name things differently.
func TestEveryCatalogCommandHasPreset(t *testing.T) {
	cmds, err := LoadCommands(filepath.Join(sharedDir(), "commands.json"), filepath.Join(sharedDir(), "command-presets.json"))
	if err != nil {
		t.Fatal(err)
	}
	n := 0
	for module, list := range cmds {
		for _, c := range list {
			n++
			if c.PresetGroup == "" || c.PresetName == "" {
				t.Errorf("%s/%s (%s): no preset copy", module, c.Name, c.Usage)
			}
		}
	}
	if n == 0 {
		t.Fatal("empty catalog")
	}
}

func TestPresetLookupNormalizes(t *testing.T) {
	idx := presetIndex{byName: map[string]preset{}, byTop: map[string]preset{}}
	for _, p := range []preset{
		{"music", "Music", "play"}, {"invite-tracker", "Invite Tracker", "invite-reset"},
		{"giveaways", "Giveaways", "giveaway-end"}, {"birthday", "Birthday", "birthday add"}, {"birthday", "Birthday", "birthday list"},
	} {
		m := normModule(p.Module)
		idx.byName[m+"/"+normName(p.Name)] = p
		top, _, _ := strings.Cut(p.Name, " ")
		if _, ok := idx.byTop[m+"/"+normName(top)]; !ok {
			idx.byTop[m+"/"+normName(top)] = p
		}
	}
	cases := []struct{ module, name, usage, want string }{
		{"music", "music-play", "/play [song]", "play"},
		{"invite-tracker", "invite-tracker-reset", "/invites-reset @user", "invite-reset"},
		{"giveaway", "giveaway-end", "/giveaway-end [id]", "giveaway-end"},
		{"birthday", "birthday", "/birthday [datum]", "birthday add"},
	}
	for _, c := range cases {
		p, ok := idx.find(c.module, c.name, c.usage)
		if !ok || p.Name != c.want {
			t.Errorf("%s/%s: got %q, want %q", c.module, c.name, p.Name, c.want)
		}
	}
	if _, ok := idx.find("music", "lyrics", "/lyrics"); ok {
		t.Error("lyrics has no preset in this index")
	}
}

// The timed events page renders with a default server set (pointer field).
func TestTimedEventsTemplateRenders(t *testing.T) {
	tpl, err := parseTemplates(ui.FS)
	if err != nil {
		t.Fatal(err)
	}
	server := "123456789012345678"
	sec := 90
	v := timedView{
		BotID: 1, Settings: api.TimedSettings{Timezone: "Europe/Berlin", DefaultServerID: &server}, DefaultServer: server,
		Guilds: []api.Guild{{ID: server, Name: "Test"}}, Zones: timeZones, Weekdays: weekdayOrder,
		Events: []timedEventView{eventView(api.TimedEvent{ID: 1, Name: "Hourly", Kind: "interval", IntervalSeconds: &sec, Weekdays: []int{1}, Enabled: true})},
		New:    eventView(api.TimedEvent{Kind: "interval", IntervalSeconds: &sec, Enabled: true}),
	}
	var b strings.Builder
	if err := tpl.sets["module_item"].ExecuteTemplate(&b, "timed_events_fragment", Page{Data: v}); err != nil {
		t.Fatal(err)
	}
	out := b.String()
	for _, want := range []string{`value="123456789012345678" selected`, `value="Europe/Berlin" selected`, `name="minutes" min="0" max="59" value="1"`, `name="seconds" min="0" max="59" value="30"`, `value="1" checked`} {
		if !strings.Contains(out, want) {
			t.Errorf("missing %s", want)
		}
	}
}

// Every module command runs as its copy in the database, so each catalog
// entry must find one (the module page shows and switches that copy).
func TestEveryCatalogCommandHasPresetCopy(t *testing.T) {
	cmds, err := LoadCommands("../../../shared/commands.json", "../../../shared/command-presets.json")
	if err != nil {
		t.Fatal(err)
	}
	for module, list := range cmds {
		for _, c := range list {
			if c.PresetGroup == "" || c.PresetName == "" {
				t.Errorf("%s /%s has no preset copy", module, c.Name)
			}
		}
	}
}
