package web

import (
	"testing"
	"time"

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
	last.LastCheck = &struct {
		At     time.Time `json:"at"`
		Behind int       `json:"behind"`
	}{Behind: 2}
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
