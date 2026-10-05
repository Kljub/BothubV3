package web

import (
	"bytes"
	"encoding/json"
	"fmt"
	"html/template"
	"io/fs"
	"log/slog"
	"net/http"
	"net/url"
	"path"
	"strings"
	"time"

	"github.com/Kljub/BothubV3/dashboard/internal/api"
)

// Page is the data every template receives.
type Page struct {
	Me            api.Me
	Locale        string
	Theme         string
	CSRF          string
	Nav           string
	Bots          []api.Bot // all bots, for the sidebar bot switch
	SelectedBot   *api.Bot  // bot picked by the user; nil until one is picked
	BotSections   []string
	Themes        []string
	Locales       []string
	AdminSections []string
	AssetVersion  string
	Data          any
}

// templates holds one parsed set per page: layout.html plus the page file.
type templates struct {
	sets map[string]*template.Template
}

// baseFuncs are placeholders so templates parse. Per request, render clones
// the set and replaces "t" with a function bound to the request's locale.
var baseFuncs = template.FuncMap{
	"t":     func(key string, args ...any) string { return key },
	"bytes": func(b int64) string { return formatBytes(b, "en") },
	"add":   func(a, b float64) float64 { return a + b },
	"upper": strings.ToUpper,
	"list":  func(v ...any) []any { return v },
	// newestFirst turns a log around: the last line first (update log).
	"newestFirst": newestFirst,
	// Choices of the update and restart settings (Admin → Server settings).
	"autoUpdateModes": func() []string { return api.AutoUpdateModes },
	"restartPolicies": func() []string { return api.RestartPolicies },
	"derefStr": func(p *string) string {
		if p == nil {
			return ""
		}
		return *p
	},
	"join": strings.Join,
	"deref": func(p *int64) int64 {
		if p == nil {
			return 0
		}
		return *p
	},
	"inviteURL": inviteURL,
	// "Invite Bot": the custom invite page when it is on, else Discord's link.
	"botInviteURL": botInviteURL,
	"pager":        pager,
	"clientI18n":   func() template.JS { return "{}" },
	"pickerTexts":  func() template.JS { return "{}" },
	"rangeForm":    newRangeForm,
	"twofaState":   func(enabled bool) map[string]any { return map[string]any{"TwoFactorEnabled": enabled} },
	"minutes":      func(sec int) int { return sec / 60 },
	"initial": func(name string) string {
		for _, r := range strings.TrimSpace(name) {
			return strings.ToUpper(string(r))
		}
		return "?"
	},
	"sub": func(a, b float64) float64 { return a - b },
	// uptime: "27m" while the bot runs, else "" (hover on the sidebar status dot).
	"uptime": func(b api.Bot) string {
		if b.Status != api.BotRunning || b.StartedAt == nil {
			return ""
		}
		return formatDuration(max(time.Since(*b.StartedAt), 0))
	},
	"cdnSize": cdnSize,
}

// cdnSize asks the Discord CDN for an image in the given size (a power of
// two, 16-4096), so wide or high-DPI displays get a sharp image. Other URLs
// (e.g. data: URLs) stay as they are.
func cdnSize(v any, size int) string {
	var raw string
	switch x := v.(type) {
	case string:
		raw = x
	case *string:
		if x == nil {
			return ""
		}
		raw = *x
	}
	u, err := url.Parse(raw)
	if err != nil || (u.Host != "cdn.discordapp.com" && u.Host != "media.discordapp.net") {
		return raw
	}
	q := u.Query()
	q.Set("size", fmt.Sprint(size))
	u.RawQuery = q.Encode()
	return u.String()
}

func parseTemplates(fsys fs.FS) (*templates, error) {
	pages, err := fs.Glob(fsys, "templates/*.html")
	if err != nil {
		return nil, err
	}
	t := &templates{sets: map[string]*template.Template{}}
	for _, p := range pages {
		name := strings.TrimSuffix(path.Base(p), ".html")
		if name == "layout" {
			continue
		}
		set, err := template.New(name).Funcs(baseFuncs).ParseFS(fsys, "templates/layout.html", "templates/partials/*.html", "templates/modules/*.html", p)
		if err != nil {
			return nil, fmt.Errorf("parse %s: %w", p, err)
		}
		t.sets[name] = set
	}
	return t, nil
}

// render executes template `name` of page set `page` into w.
func (s *Server) render(w http.ResponseWriter, status int, page, name string, data Page) {
	set, ok := s.tpl.sets[page]
	if !ok {
		slog.Error("unknown template set", "page", page)
		http.Error(w, "template missing", http.StatusInternalServerError)
		return
	}
	clone, err := set.Clone()
	if err != nil {
		slog.Error("clone template", "err", err)
		http.Error(w, "template error", http.StatusInternalServerError)
		return
	}
	locale := data.Locale
	clone.Funcs(template.FuncMap{
		"t":           func(key string, args ...any) string { return s.i18n.T(locale, key, args...) },
		"bytes":       func(b int64) string { return formatBytes(b, locale) },
		"clientI18n":  func() template.JS { return s.clientI18n(locale) },
		"pickerTexts": func() template.JS { return s.pickerTexts(locale) },
	})

	data.Locales = s.i18n.Locales()
	data.AdminSections = adminSections
	data.BotSections = botSections
	data.Themes = themes
	data.AssetVersion = s.assetVersion

	var buf bytes.Buffer
	if err := clone.ExecuteTemplate(&buf, name, data); err != nil {
		slog.Error("render", "page", page, "template", name, "err", err)
		http.Error(w, "render error", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.WriteHeader(status)
	_, _ = buf.WriteTo(w)
}

// inviteURL is the Discord OAuth2 link that adds the bot to a server with
// administrator permission (8). Empty without an application ID.
func inviteURL(appID *string) string {
	if appID == nil || *appID == "" {
		return ""
	}
	return "https://discord.com/oauth2/authorize?client_id=" + url.QueryEscape(*appID) +
		"&scope=applications.commands%20bot&permissions=8"
}

// clientKeys are the i18n keys the browser scripts need (passkey errors).
var clientKeys = []string{
	"error.passkey.failed", "error.passkey.expired", "error.passkey.cancelled",
	"error.passkey.name", "error.csrf.invalid", "error.auth.required",
}

// clientI18n renders clientKeys as JSON for <script type="application/json">.
// json.Marshal escapes <, > and &, so the output cannot end the script tag.
func (s *Server) clientI18n(locale string) template.JS {
	m := make(map[string]string, len(clientKeys))
	for _, k := range clientKeys {
		m[k] = s.i18n.T(locale, k)
	}
	b, err := json.Marshal(m)
	if err != nil {
		return "{}"
	}
	return template.JS(b)
}

// pickerTexts are the texts of the role/channel pickers and the permissions
// block (permissions.js) for pages outside the node editor.
func (s *Server) pickerTexts(locale string) template.JS {
	m := map[string]string{}
	for _, k := range s.i18n.Keys("en") {
		for _, p := range []string{"builder.perm.", "builder.pick.", "builder.permission.", "builder.permgroup.", "builder.chan.", "permblock."} {
			if strings.HasPrefix(k, p) {
				m[k] = s.i18n.T(locale, k)
				break
			}
		}
	}
	for _, k := range []string{"builder.close", "builder.cfg.permissions", "action.cancel"} {
		m[k] = s.i18n.T(locale, k)
	}
	return jsonIsland(m)
}
