package web

import (
	"strings"
	"testing"

	"github.com/Kljub/BothubV3/dashboard/internal/api"
	"github.com/Kljub/BothubV3/dashboard/ui"
)

func TestNewestFirst(t *testing.T) {
	if got := newestFirst("a\r\nb\nc\n"); got != "c\nb\na" {
		t.Errorf("newestFirst = %q", got)
	}
	if got := newestFirst(""); got != "" {
		t.Errorf("empty log = %q", got)
	}
}

func TestUpdateAvailable(t *testing.T) {
	behind := func(n int) *api.UpdateCheck { return &api.UpdateCheck{Behind: n} }
	last := api.UpdateInfo{}
	last.LastCheck = &api.UpdateLastCheck{Behind: 2, Remote: "b2c3d4e"}
	if v := (updateView{Info: last}); v.NewVersion() != "b2c3d4e" {
		t.Errorf("new version = %q", v.NewVersion())
	}
	if clockDuration(514) != "08:34" || clockDuration(3723) != "1:02:03" || clockDuration(-1) != "" {
		t.Error("clockDuration")
	}
	for name, c := range map[string]struct {
		v    updateView
		want bool
	}{
		"never checked":    {updateView{}, false},
		"up to date":       {updateView{Check: behind(0)}, false},
		"new commits":      {updateView{Check: behind(3)}, true},
		"check failed":     {updateView{Check: &api.UpdateCheck{Behind: 3, Error: "x"}}, false},
		"earlier check":    {updateView{Info: last}, true},
		"fresh check wins": {updateView{Info: last, Check: behind(0)}, false},
	} {
		if got := c.v.UpdateAvailable(); got != c.want {
			t.Errorf("%s: %v, want %v", name, got, c.want)
		}
	}
}

// The update box tells whether the waiting version is already prepared in
// the background (then installing only restarts).
func TestUpdateBoxPrefetch(t *testing.T) {
	tpl, err := parseTemplates(ui.FS)
	if err != nil {
		t.Fatal(err)
	}
	for status, want := range map[string]string{"ready": "update.prefetch.ready", "running": "update.prefetch.running", "failed": "update.prefetch.failed"} {
		info := api.UpdateInfo{Configured: true}
		info.LastCheck = &api.UpdateLastCheck{Behind: 1, Remote: "b2c3d4e"}
		info.Prefetch = &api.UpdatePrefetch{Remote: "b2c3d4e", Status: status}
		var out strings.Builder
		if err := tpl.sets["admin"].ExecuteTemplate(&out, "update_box_fragment", Page{Data: updateView{Info: info, Locale: "en"}}); err != nil {
			t.Fatal(err)
		}
		if !strings.Contains(out.String(), want) {
			t.Errorf("%s: no %s", status, want)
		}
		// An older preparation (another commit waits now) is not shown.
		info.Prefetch.Remote = "a1a1a1a"
		out.Reset()
		_ = tpl.sets["admin"].ExecuteTemplate(&out, "update_box_fragment", Page{Data: updateView{Info: info, Locale: "en"}})
		if strings.Contains(out.String(), "update.prefetch.") {
			t.Errorf("%s: stale preparation shown", status)
		}
	}
}
