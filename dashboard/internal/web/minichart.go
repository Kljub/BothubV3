package web

import (
	"fmt"
	"strings"
	"time"
)

// Small charts of the bot overview grid: one metric each, one or two lines
// (joins and leaves, moderation by command and by AutoMod) with dots.

type miniSeries struct {
	Key, Color string // i18n key of the legend, CSS color
	Points     []chartPoint
}

type miniLine struct {
	Key, Color, Path, Area string
	Dots                   []miniDot
}

// miniDot is one point; hovering it shows its value and time.
type miniDot struct {
	X, Y        float64
	Value, Time string
}

type miniChart struct {
	Key, Icon             string
	W, H                  float64
	Left, Right, Top, Bot float64
	Lines                 []miniLine
	YTicks, XTicks        []chartTick
	Legend                bool
	Empty                 bool
}

type chartSpec struct {
	Key, Icon string
	Lines     []struct{ Metric, Label, Color string }
}

func spec(key, icon string, lines ...[3]string) chartSpec {
	c := chartSpec{Key: key, Icon: icon}
	for _, l := range lines {
		c.Lines = append(c.Lines, struct{ Metric, Label, Color string }{l[0], l[1], l[2]})
	}
	return c
}

// overviewCharts: the grid of the overview, in order.
var overviewCharts = []chartSpec{
	spec("newMembers", "👥", [3]string{"newMembers", "stats.line.joins", "#ef4444"}, [3]string{"leaves", "stats.line.leaves", "#f9a8d4"}),
	spec("activeUsers", "🟢", [3]string{"activeUsers", "stats.metric.activeUsers", "#06b6d4"}),
	spec("messages", "💬", [3]string{"messages", "stats.metric.messages", "#3b82f6"}),
	spec("voiceMinutes", "🔊", [3]string{"voiceMinutes", "stats.metric.voiceMinutes", "#eab308"}),
	spec("moderation", "🛡️", [3]string{"modCommands", "stats.line.mod_commands", "#22c55e"}, [3]string{"modAutomod", "stats.line.automod", "#86efac"}),
	spec("commands", "⚡", [3]string{"commands", "stats.metric.commands", "#3b82f6"}),
	spec("pluginUsages", "🧩", [3]string{"pluginUsages", "stats.metric.pluginUsages", "#ef4444"}),
}

const (
	miniW, miniH                             = 360.0, 190.0
	miniLeft, miniRight, miniTop, miniBottom = 30.0, 10.0, 12.0, 24.0
)

func buildMiniChart(key, icon string, lines []miniSeries, rng, locale string, format func(int64) string) miniChart {
	c := miniChart{Key: key, Icon: icon, W: miniW, H: miniH, Left: miniLeft, Right: miniW - miniRight, Top: miniTop, Bot: miniH - miniBottom, Legend: len(lines) > 1}
	if len(lines) == 0 || len(lines[0].Points) < 2 {
		c.Empty = true
		return c
	}
	t0, t1 := lines[0].Points[0].T, lines[0].Points[len(lines[0].Points)-1].T
	span := t1.Sub(t0).Seconds()
	if span <= 0 {
		span = 1
	}
	var peak int64
	for _, l := range lines {
		for _, p := range l.Points {
			peak = max(peak, p.V)
		}
	}
	yMax, step := niceScale(max(float64(peak), 1))
	x := func(t time.Time) float64 { return c.Left + (c.Right-c.Left)*t.Sub(t0).Seconds()/span }
	y := func(v float64) float64 { return c.Bot - (c.Bot-c.Top)*v/yMax }
	for _, l := range lines {
		var path strings.Builder
		ml := miniLine{Key: l.Key, Color: l.Color}
		for i, p := range l.Points {
			px, py := round1(x(p.T)), round1(y(float64(p.V)))
			if i == 0 {
				fmt.Fprintf(&path, "M%.1f %.1f", px, py)
			} else {
				fmt.Fprintf(&path, " L%.1f %.1f", px, py)
			}
			ml.Dots = append(ml.Dots, miniDot{X: px, Y: py, Value: format(p.V), Time: formatTime(p.T, rng, locale)})
		}
		ml.Path = path.String()
		ml.Area = fmt.Sprintf("%s L%.1f %.1f L%.1f %.1f Z", ml.Path, c.Right, c.Bot, c.Left, c.Bot)
		c.Lines = append(c.Lines, ml)
	}
	for v := 0.0; v <= yMax+step/2; v += step {
		c.YTicks = append(c.YTicks, chartTick{Pos: round1(y(v)), Label: format(int64(v))})
	}
	// Four date labels: more overlap on a small chart.
	const ticks = 4
	for i := 0; i < ticks; i++ {
		t := t0.Add(time.Duration(float64(i) / float64(ticks-1) * span * float64(time.Second)))
		c.XTicks = append(c.XTicks, chartTick{Pos: round1(x(t)), Label: formatTime(t, rng, locale)})
	}
	return c
}
