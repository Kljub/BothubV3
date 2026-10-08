package web

import (
	"testing"

	"github.com/Kljub/BothubV3/dashboard/internal/api"
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
