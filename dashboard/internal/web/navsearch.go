package web

import (
	"encoding/json"
	"net/http"
	"strconv"
)

// Sidebar search: besides the menu entries it finds the modules and the
// plugins of the selected bot. app.js loads this list once, on the first
// search, and shows the hits with their icon in the colour of their module
// group (plugins in the plugin colour).

type navHit struct {
	Name  string `json:"name"`
	Desc  string `json:"desc,omitempty"`
	Icon  string `json:"icon"`
	URL   string `json:"url"`
	Group string `json:"group"` // module category, or "plugin"
}

func (s *Server) handleNavIndex(w http.ResponseWriter, r *http.Request, p Page) {
	hits := []navHit{}
	for _, c := range s.modules {
		for _, m := range c.Modules {
			hits = append(hits, navHit{
				Name:  s.i18n.T(p.Locale, "module."+m.Key+".name"),
				Desc:  s.i18n.T(p.Locale, "module."+m.Key+".description"),
				Icon:  m.Icon,
				URL:   "/bots/modules/" + m.Key,
				Group: c.Key,
			})
		}
	}
	if c, err := r.Cookie(botCookie); err == nil {
		id, _ := strconv.ParseInt(c.Value, 10, 64)
		if plugins, err := s.pluginViews(r, id); id > 0 && err == nil {
			for _, pl := range plugins {
				icon := pl.Icon
				if icon == "" {
					icon = "🧩"
				}
				hits = append(hits, navHit{Name: pl.Name, Desc: pl.Description, Icon: icon, URL: "/bots/plugins/" + pl.ID, Group: "plugin"})
			}
		}
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "private, max-age=60")
	_ = json.NewEncoder(w).Encode(hits)
}
