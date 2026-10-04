package web

import (
	"fmt"
	"html/template"
	"math"
	"net/http"
	"regexp"
	"slices"
	"time"

	"github.com/Kljub/BothubV3/dashboard/internal/api"
)

var botStatRanges = []string{"24h", "7d", "30d"}

// botStatsView is the data for the "bot_stats" template: metric tiles, the
// chart of the selected metric and the top lists.
type botStatsView struct {
	BotID        int64
	Range        string
	RangeQuery   template.URL // repeats the range in tile clicks and polling
	RangeLabel   string       // custom range written out
	Picker       rangeForm    // custom range popup
	Ranges       []string
	Metric       string
	Tiles        []metricTile
	Chart        lineChart
	AverageLabel string
	// Overview grid: one small chart per metric (two lines where it compares).
	Charts []miniChart
	// Server filter: "" = all servers.
	Guild       string
	Guilds      []api.Guild
	TopCommands []topRow
	TopPlugins  []topRow
	TopMod      []topRow
}

type metricTile struct {
	Key      string
	Value    string
	Delta    string // "+12 %", empty without a previous value
	DeltaDir string // up, down, flat, neutral
	Selected bool
}

type topRow struct {
	Name  string
	Count string
	Pct   float64 // bar length relative to the first entry, 0-100
}

// handleBotStats re-renders the stats block (tile click, range switch, polling).
func (s *Server) handleBotStats(w http.ResponseWriter, r *http.Request, p Page) {
	id, ok := s.botID(w, r, p)
	if !ok {
		return
	}
	v, err := s.botStats(r, p, id)
	if err != nil {
		// A bad custom range is shown inside the range popup.
		if r.URL.Query().Get("range") == "custom" {
			s.failTo(w, r, p, err, "#stats-range-error")
			return
		}
		s.fail(w, r, p, err)
		return
	}
	if v.Range == "custom" {
		w.Header().Set("HX-Trigger", "bothub:close-dialogs")
	}
	s.render(w, http.StatusOK, "bot", "bot_stats_fragment", withData(p, v))
}

func (s *Server) botStats(r *http.Request, p Page, botID int64) (botStatsView, error) {
	q := r.URL.Query()
	rng := q.Get("range")
	if rng != "custom" && !slices.Contains(botStatRanges, rng) {
		rng = "7d"
	}
	metric := q.Get("metric")
	if !slices.Contains(api.BotMetrics, metric) {
		metric = "messages"
	}
	guild := q.Get("guild")
	if !snowflake.MatchString(guild) {
		guild = ""
	}

	picker := newRangeForm("", "", "stats.retention")
	var stats api.BotStats
	var from, to time.Time
	if rng == "custom" {
		var errKey string
		from, to, errKey = customRange(r, 5*time.Minute, 7*24*time.Hour, "error.range.too_short_stats")
		if errKey != "" {
			return botStatsView{}, &api.Error{Status: http.StatusUnprocessableEntity, Key: errKey}
		}
		var err error
		if stats, err = s.api.BotStatsBetween(r.Context(), session(r), botID, from, to, guild); err != nil {
			return botStatsView{}, err
		}
		picker.From, picker.To = from.Format(inputTime), to.Format(inputTime)
	} else {
		var err error
		if stats, err = s.api.BotStats(r.Context(), session(r), botID, rng, guild); err != nil {
			return botStatsView{}, err
		}
	}

	format := func(v int64) string { return formatInt(v, p.Locale) }
	if metric == "voiceMinutes" {
		format = func(v int64) string { return formatInt(v, p.Locale) + " min" }
	}

	v := botStatsView{BotID: botID, Range: rng, Ranges: botStatRanges, Metric: metric, Picker: picker, RangeQuery: rangeQuery(rng, from, to), Guild: guild}
	if guild != "" {
		v.RangeQuery += template.URL("&guild=" + guild)
	}
	// Without a running bot there are no servers to pick; the filter then shows "all".
	v.Guilds, _ = s.api.ListGuilds(r.Context(), session(r), botID)
	if rng == "custom" {
		v.RangeLabel = rangeLabel(from, to, p.Locale)
	}
	for _, key := range api.BotMetrics {
		tile := metricTile{Key: key, Selected: key == metric, Value: formatInt(stats.Totals[key], p.Locale)}
		if key == "voiceMinutes" {
			tile.Value += " min"
		}
		tile.Delta, tile.DeltaDir = delta(stats.Totals[key], stats.Previous[key], key == "moderation")
		v.Tiles = append(v.Tiles, tile)
	}

	series := stats.Series[metric]
	pts := make([]chartPoint, len(series))
	var sum int64
	for i, pt := range series {
		pts[i] = chartPoint{T: pt.T, V: pt.V}
		sum += pt.V
	}
	var avg int64
	if len(pts) > 0 {
		avg = sum / int64(len(pts))
	}
	v.Chart = buildLineChart(pts, avg, rng, p.Locale, format)
	v.AverageLabel = format(avg)

	plain := func(v int64) string { return formatInt(v, p.Locale) }
	for _, c := range overviewCharts {
		var lines []miniSeries
		for _, l := range c.Lines {
			pts := make([]chartPoint, len(stats.Series[l.Metric]))
			for i, pt := range stats.Series[l.Metric] {
				pts[i] = chartPoint{T: pt.T, V: pt.V}
			}
			lines = append(lines, miniSeries{Key: l.Label, Color: l.Color, Points: pts})
		}
		v.Charts = append(v.Charts, buildMiniChart(c.Key, c.Icon, lines, rng, p.Locale, plain))
	}

	v.TopCommands = topRows(stats.Top.Commands, p.Locale, func(n string) string { return "/" + n })
	v.TopPlugins = topRows(stats.Top.Plugins, p.Locale, nil)
	v.TopMod = topRows(stats.Top.ModActions, p.Locale, func(n string) string { return s.i18n.T(p.Locale, "modaction."+n) })
	return v, nil
}

// delta formats the change against the previous period. neutral marks metrics
// where up is neither good nor bad (moderation), so they get no color.
func delta(cur, prev int64, neutral bool) (string, string) {
	if prev == 0 {
		return "", ""
	}
	pct := math.Round(float64(cur-prev) / float64(prev) * 100)
	dir := "flat"
	switch {
	case pct > 0:
		dir = "up"
	case pct < 0:
		dir = "down"
	}
	if neutral && dir != "flat" {
		dir = "neutral"
	}
	return fmt.Sprintf("%+.0f %%", pct), dir
}

func topRows(entries []api.TopEntry, locale string, label func(string) string) []topRow {
	rows := make([]topRow, 0, len(entries))
	var top int64
	for _, e := range entries {
		top = max(top, e.Count)
	}
	for _, e := range entries {
		name := e.Name
		if label != nil {
			name = label(e.Name)
		}
		row := topRow{Name: name, Count: formatInt(e.Count, locale)}
		if top > 0 {
			row.Pct = math.Round(float64(e.Count)/float64(top)*1000) / 10
		}
		rows = append(rows, row)
	}
	return rows
}

var snowflake = regexp.MustCompile(`^\d{17,20}$`)
