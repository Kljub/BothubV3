package web

import (
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/Kljub/BothubV3/dashboard/internal/api"
	"github.com/Kljub/BothubV3/dashboard/ui"
)

func TestOverviewMiniCharts(t *testing.T) {
	t0 := time.Date(2026, 10, 4, 0, 0, 0, 0, time.UTC)
	pts := func(vals ...int64) []chartPoint {
		out := make([]chartPoint, len(vals))
		for i, v := range vals {
			out[i] = chartPoint{T: t0.Add(time.Duration(i) * time.Hour), V: v}
		}
		return out
	}
	c := buildMiniChart("newMembers", "👥", []miniSeries{{Key: "stats.line.joins", Color: "#22c55e", Points: pts(0, 2, 1)}, {Key: "stats.line.leaves", Color: "#ef4444", Points: pts(0, 0, 4)}}, "24h", "en", func(v int64) string { return fmt.Sprint(v) })
	if c.Empty || len(c.Lines) != 2 || !c.Legend || len(c.Lines[1].Dots) != 3 || len(c.XTicks) != 4 {
		t.Fatalf("chart: %+v", c)
	}
	if empty := buildMiniChart("messages", "💬", []miniSeries{{Points: pts(1)}}, "24h", "en", nil); !empty.Empty {
		t.Fatal("one point is no chart")
	}
	tpl, err := parseTemplates(ui.FS)
	if err != nil {
		t.Fatal(err)
	}
	var out strings.Builder
	v := botStatsView{BotID: 1, Range: "24h", Ranges: botStatRanges, Charts: []miniChart{c}, Guilds: []api.Guild{{ID: "100000000000000001", Name: "Njetflix"}}, Guild: "100000000000000001"}
	if err := tpl.sets["bot"].ExecuteTemplate(&out, "bot_stats_fragment", Page{Data: v}); err != nil {
		t.Fatal(err)
	}
	html := out.String()
	if strings.Contains(html, "style=") {
		t.Error("no inline styles: the CSP blocks them (the lines turned black)")
	}
	for _, want := range []string{`value="100000000000000001" selected`, "stats.line.leaves", `class="mini-line"`, "overview.all_servers", `stroke="#ef4444"`, `<title>stats.line.leaves: 4 · `} {
		if !strings.Contains(html, want) {
			t.Errorf("missing %q", want)
		}
	}
}
