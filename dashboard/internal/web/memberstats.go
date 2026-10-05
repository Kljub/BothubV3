package web

import (
	"net/http"
	"strconv"
	"strings"
	"time"
)

// Stats module: how the member modules (Welcomer, Leaver, Boost) went over
// 7, 30 or 90 days, one chart per module and the count of every path.

// memberStatGroups: the groups, their chart and their paths, in order.
var memberStatGroups = []struct {
	Key, Icon, Color string
	Paths            []string
}{
	{"welcome", "👋", "#22c55e", []string{"normal", "returning", "milestone", "invite", "bot", "raid", "suspicious", "spam"}},
	{"leave", "🚪", "#f87171", []string{"left", "kicked", "banned", "pruned", "bot"}},
	{"boost", "🚀", "#f472b6", []string{"first", "again", "stop"}},
}

type memberStatsGroup struct {
	Key   string
	Total string
	Rows  []memberStatsRow
}

type memberStatsRow struct {
	Key   string // i18n key of the path
	Count string
	Pct   float64 // bar length relative to the biggest path of the group
}

type memberStatsView struct {
	BotID  int64
	Days   int
	Ranges []int
	Charts []miniChart
	Groups []memberStatsGroup
}

func (s *Server) memberStatsView(r *http.Request, p Page, botID int64) (memberStatsView, error) {
	days, _ := strconv.Atoi(r.URL.Query().Get("days"))
	if days != 7 && days != 90 {
		days = 30
	}
	st, err := s.api.MemberStats(r.Context(), session(r), botID, days)
	if err != nil {
		return memberStatsView{}, err
	}
	v := memberStatsView{BotID: botID, Days: days, Ranges: []int{7, 30, 90}}
	format := func(n int64) string { return formatInt(n, p.Locale) }
	for _, g := range memberStatGroups {
		var pts []chartPoint
		for _, pt := range st.Series[g.Key] {
			if t, err := time.Parse(time.RFC3339, pt.T); err == nil {
				pts = append(pts, chartPoint{T: t, V: pt.V})
			}
		}
		key := "member" + strings.ToUpper(g.Key[:1]) + g.Key[1:]
		v.Charts = append(v.Charts, buildMiniChart(key, g.Icon, []miniSeries{{Key: "stats.metric." + key, Color: g.Color, Points: pts}}, "days", p.Locale, format))
		counts := st.Counts[g.Key]
		var total, peak int64
		for _, path := range g.Paths {
			total += counts[path]
			peak = max(peak, counts[path])
		}
		grp := memberStatsGroup{Key: g.Key, Total: format(total)}
		for _, path := range g.Paths {
			row := memberStatsRow{Key: "memberstats.path." + g.Key + "." + path, Count: format(counts[path])}
			if peak > 0 {
				row.Pct = round1(float64(counts[path]) * 100 / float64(peak))
			}
			grp.Rows = append(grp.Rows, row)
		}
		v.Groups = append(v.Groups, grp)
	}
	return v, nil
}
