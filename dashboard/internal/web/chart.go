package web

import (
	"encoding/json"
	"fmt"
	"math"
	"strings"
	"time"

	"github.com/Kljub/BothubV3/dashboard/internal/api"
)

// lineChart is the view model for a server-rendered single-series SVG line
// chart. Coordinates are in viewBox units; the SVG scales to the container width.
type lineChart struct {
	W, H                  float64
	Left, Right, Top, Bot float64
	Line, Area            string
	AvgY                  float64
	YTicks, XTicks        []chartTick
	Points                string // JSON [[x, y, time, value], ...] for the hover layer
	Rows                  []chartRow
	Empty                 bool
}

type chartTick struct {
	Pos   float64
	Label string
}

type chartRow struct {
	Time, Value string
}

// chartPoint is one sample of a series.
type chartPoint struct {
	T time.Time
	V int64
}

const (
	chartW      = 800.0
	chartH      = 260.0
	chartLeft   = 64.0
	chartRight  = 12.0
	chartTop    = 12.0
	chartBottom = 28.0
	maxTableRow = 24
)

func buildMemoryChart(m api.MemoryStats, locale string) lineChart {
	pts := make([]chartPoint, len(m.Series))
	for i, s := range m.Series {
		pts[i] = chartPoint{T: s.T, V: s.Bytes}
	}
	return buildLineChart(pts, m.AverageBytes, m.Range, locale, func(v int64) string { return formatBytes(v, locale) })
}

// buildLineChart lays out a series. format renders values for ticks, tooltip
// and table; average draws the reference line.
func buildLineChart(series []chartPoint, average int64, rng, locale string, format func(int64) string) lineChart {
	c := lineChart{
		W: chartW, H: chartH,
		Left: chartLeft, Right: chartW - chartRight,
		Top: chartTop, Bot: chartH - chartBottom,
	}
	if len(series) < 2 {
		c.Empty = true
		return c
	}

	t0, t1 := series[0].T, series[len(series)-1].T
	span := t1.Sub(t0).Seconds()
	if span <= 0 {
		span = 1
	}
	var peak int64
	for _, s := range series {
		peak = max(peak, s.V)
	}
	yMax, step := niceScale(float64(peak) * 1.1)

	x := func(t time.Time) float64 { return c.Left + (c.Right-c.Left)*t.Sub(t0).Seconds()/span }
	y := func(v float64) float64 { return c.Bot - (c.Bot-c.Top)*v/yMax }

	var line strings.Builder
	points := make([][4]any, 0, len(series))
	for i, s := range series {
		px, py := round1(x(s.T)), round1(y(float64(s.V)))
		if i == 0 {
			fmt.Fprintf(&line, "M%.1f %.1f", px, py)
		} else {
			fmt.Fprintf(&line, " L%.1f %.1f", px, py)
		}
		points = append(points, [4]any{px, py, formatTime(s.T, rng, locale), format(s.V)})
	}
	c.Line = line.String()
	c.Area = fmt.Sprintf("%s L%.1f %.1f L%.1f %.1f Z", c.Line, c.Right, c.Bot, c.Left, c.Bot)
	c.AvgY = round1(y(float64(average)))

	for v := 0.0; v <= yMax+step/2; v += step {
		c.YTicks = append(c.YTicks, chartTick{Pos: round1(y(v)), Label: format(int64(v))})
	}
	const xTickCount = 5
	for i := 0; i < xTickCount; i++ {
		t := t0.Add(time.Duration(float64(i) / float64(xTickCount-1) * span * float64(time.Second)))
		c.XTicks = append(c.XTicks, chartTick{Pos: round1(x(t)), Label: formatTime(t, rng, locale)})
	}

	if b, err := json.Marshal(points); err == nil {
		c.Points = string(b)
	}

	// Table view: at most maxTableRow evenly spaced samples, newest first.
	stride := max(1, int(math.Ceil(float64(len(series))/maxTableRow)))
	for i := len(series) - 1; i >= 0; i -= stride {
		c.Rows = append(c.Rows, chartRow{Time: formatTime(series[i].T, rng, locale), Value: format(series[i].V)})
	}
	return c
}

// niceScale returns an axis maximum and a step giving about four clean ticks.
func niceScale(maxVal float64) (top, step float64) {
	if maxVal <= 0 {
		return 1, 0.25
	}
	raw := maxVal / 4
	mag := math.Pow(10, math.Floor(math.Log10(raw)))
	for _, m := range []float64{1, 2, 2.5, 5, 10} {
		if step = m * mag; step >= raw {
			break
		}
	}
	return math.Ceil(maxVal/step) * step, step
}

func round1(v float64) float64 { return math.Round(v*10) / 10 }

// formatBytes renders a byte count with binary units and the locale's decimal separator.
func formatBytes(b int64, locale string) string {
	const unit = 1024.0
	v := float64(b)
	units := []string{"B", "KB", "MB", "GB", "TB"}
	i := 0
	for v >= unit && i < len(units)-1 {
		v /= unit
		i++
	}
	var s string
	switch {
	case i == 0 || v >= 100:
		s = fmt.Sprintf("%.0f", v)
	case v >= 10:
		s = fmt.Sprintf("%.1f", v)
	default:
		s = fmt.Sprintf("%.2f", v)
	}
	if strings.Contains(s, ".") {
		s = strings.TrimRight(strings.TrimRight(s, "0"), ".")
	}
	if locale == "de" {
		s = strings.Replace(s, ".", ",", 1)
	}
	return s + " " + units[i]
}

// formatTime renders a sample time in the server's local zone (TZ).
func formatTime(t time.Time, rng, locale string) string {
	t = t.Local()
	if rng == "1h" || rng == "24h" {
		return t.Format("15:04")
	}
	if locale == "de" {
		return t.Format("02.01. 15:04")
	}
	return t.Format("Jan 2 15:04")
}

// formatInt renders an integer with the locale's thousands separator.
func formatInt(v int64, locale string) string {
	sep := ","
	if locale == "de" {
		sep = "."
	}
	neg := v < 0
	if neg {
		v = -v
	}
	digits := fmt.Sprint(v)
	var b strings.Builder
	for i, d := range digits {
		if i > 0 && (len(digits)-i)%3 == 0 {
			b.WriteString(sep)
		}
		b.WriteRune(d)
	}
	if neg {
		return "-" + b.String()
	}
	return b.String()
}
