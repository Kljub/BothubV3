package web

import (
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"slices"
	"strconv"
	"strings"

	"github.com/Kljub/BothubV3/dashboard/internal/api"
)

// ModuleCategory is one group of the module catalog (shared/modules.json).
type ModuleCategory struct {
	Key     string
	Icon    string
	Modules []ModuleInfo
}

// ModuleInfo describes one module of the catalog.
type ModuleInfo struct {
	Key  string
	Icon string
	Beta bool
}

// LoadModules reads the module catalog grouped by category, in file order.
func LoadModules(path string) ([]ModuleCategory, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read module catalog: %w", err)
	}
	var catalog struct {
		Categories []struct {
			Key  string `json:"key"`
			Icon string `json:"icon"`
		} `json:"categories"`
		Modules []struct {
			Key      string `json:"key"`
			Category string `json:"category"`
			Icon     string `json:"icon"`
			Beta     bool   `json:"beta"`
		} `json:"modules"`
	}
	if err := json.Unmarshal(raw, &catalog); err != nil {
		return nil, fmt.Errorf("parse module catalog: %w", err)
	}
	cats := make([]ModuleCategory, len(catalog.Categories))
	index := map[string]int{}
	for i, c := range catalog.Categories {
		cats[i] = ModuleCategory{Key: c.Key, Icon: c.Icon}
		index[c.Key] = i
	}
	for _, m := range catalog.Modules {
		i, ok := index[m.Category]
		if !ok {
			return nil, fmt.Errorf("module %q: unknown category %q", m.Key, m.Category)
		}
		cats[i].Modules = append(cats[i].Modules, ModuleInfo{Key: m.Key, Icon: m.Icon, Beta: m.Beta})
	}
	return cats, nil
}

// moduleView is the data for the "module_card" template.
type moduleView struct {
	BotID    int64
	Category string
	ModuleInfo
	Enabled bool
}

// categoryView is one collapsible group on the modules tab.
type categoryView struct {
	Key, Icon     string
	Active, Total int
	Modules       []moduleView
	Closed        bool // closed by this user for this bot (remembered per account and bot)
}

// moduleCategories merges the catalog with the bot's module states.
func (s *Server) moduleCategories(r *http.Request, botID int64) ([]categoryView, error) {
	states, err := s.api.ListBotModules(r.Context(), session(r), botID)
	if err != nil {
		return nil, err
	}
	enabled := make(map[string]bool, len(states))
	for _, st := range states {
		enabled[st.Key] = st.Enabled
	}
	closed, _ := s.api.ModuleGroupsClosed(r.Context(), session(r), botID) // optional: all open on error
	cats := make([]categoryView, 0, len(s.modules))
	for _, c := range s.modules {
		cv := categoryView{Key: c.Key, Icon: c.Icon, Total: len(c.Modules), Closed: slices.Contains(closed, c.Key)}
		for _, m := range c.Modules {
			if enabled[m.Key] {
				cv.Active++
			}
			cv.Modules = append(cv.Modules, moduleView{BotID: botID, Category: c.Key, ModuleInfo: m, Enabled: enabled[m.Key]})
		}
		cats = append(cats, cv)
	}
	return cats, nil
}

// handleModuleGroups stores which module groups are closed (Modules page, per account and bot).
func (s *Server) handleModuleGroups(w http.ResponseWriter, r *http.Request, p Page) {
	id, ok := s.botID(w, r, p)
	if !ok {
		return
	}
	_ = r.ParseForm()
	if err := s.api.SetModuleGroupsClosed(r.Context(), session(r), id, r.PostForm["closed"]); err != nil {
		s.fail(w, r, p, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// findModule returns the catalog entry and its category.
func (s *Server) findModule(key string) (ModuleInfo, string, bool) {
	for _, c := range s.modules {
		for _, m := range c.Modules {
			if m.Key == key {
				return m, c.Key, true
			}
		}
	}
	return ModuleInfo{}, "", false
}

// handleSetModule toggles a module and returns the card plus the updated
// "x/y active" counter of its group (out-of-band swap).
func (s *Server) handleSetModule(w http.ResponseWriter, r *http.Request, p Page) {
	id, ok := s.botID(w, r, p)
	if !ok {
		return
	}
	key := r.PathValue("key")
	info, category, ok := s.findModule(key)
	if !ok {
		s.fail(w, r, p, &api.Error{Status: http.StatusNotFound, Key: "error.module.unknown"})
		return
	}
	if _, err := s.api.SetBotModule(r.Context(), session(r), id, key, r.PostFormValue("enabled") == "true"); err != nil {
		s.fail(w, r, p, err)
		return
	}
	cats, err := s.moduleCategories(r, id)
	if err != nil {
		s.fail(w, r, p, err)
		return
	}
	for _, c := range cats {
		if c.Key != category {
			continue
		}
		for _, m := range c.Modules {
			if m.Key == info.Key {
				s.render(w, http.StatusOK, "bot", "module_toggle_fragment", withData(p, map[string]any{"Module": m, "Category": c}))
				return
			}
		}
	}
}

// --- plugins ---

// pluginView is the data for the "plugin_card" template.
type pluginView struct {
	BotID int64
	api.InstalledPlugin
}

// Category of the plugin (bothub.json "category"; utility when none), for
// the breadcrumb and the store's group texts (module.category.<key>).
func (p pluginView) Category() string {
	var m struct {
		Category string `json:"category"`
	}
	_ = json.Unmarshal(p.Manifest, &m)
	if !slices.Contains(storeCategories, m.Category) {
		return "utility"
	}
	return m.Category
}

func (s *Server) pluginViews(r *http.Request, botID int64) ([]pluginView, error) {
	plugins, err := s.api.ListBotPlugins(r.Context(), session(r), botID)
	if err != nil {
		return nil, err
	}
	out := make([]pluginView, len(plugins))
	for i, pl := range plugins {
		if pl.Lang != nil {
			s.i18n.SetPlugin(pl.ID, pl.Lang)
		}
		out[i] = pluginView{BotID: botID, InstalledPlugin: pl}
	}
	return out, nil
}

// handleSetPlugin enables or disables a plugin for one bot and returns its card.
func (s *Server) handleSetPlugin(w http.ResponseWriter, r *http.Request, p Page) {
	id, ok := s.botID(w, r, p)
	if !ok {
		return
	}
	pl, err := s.api.SetBotPluginEnabled(r.Context(), session(r), id, r.PathValue("plugin"), r.PostFormValue("enabled") == "true")
	if err != nil {
		s.fail(w, r, p, err)
		return
	}
	s.render(w, http.StatusOK, "bot", "plugin_card_fragment", withData(p, pluginView{BotID: id, InstalledPlugin: pl}))
}

// handleModuleItem renders the content page of one module or plugin:
// /bots/modules/{key} and /bots/plugins/{key}.
func (s *Server) handleModuleItem(kind string) authHandler {
	return func(w http.ResponseWriter, r *http.Request, p Page) {
		bot, ok := s.selectedBotOrHome(w, r, p)
		if !ok {
			return
		}
		key := r.PathValue("key")
		p.SelectedBot = &bot
		p.Nav = "bot_" + kind
		data := map[string]any{"Bot": bot, "Section": kind, "Kind": kind}

		if kind == "modules" {
			info, category, found := s.findModule(key)
			if !found {
				s.fail(w, r, p, &api.Error{Status: http.StatusNotFound, Key: "error.module.unknown"})
				return
			}
			enabled, err := s.moduleEnabled(r, bot.ID, info.Key)
			if err != nil {
				s.fail(w, r, p, err)
				return
			}
			cmds, err := s.moduleCommands(r, bot.ID, info.Key)
			if err != nil {
				s.fail(w, r, p, err)
				return
			}
			data["Module"], data["Category"], data["Commands"] = info, category, cmds
			data["Header"] = moduleHeaderView{BotID: bot.ID, Category: category, ModuleInfo: info, Enabled: enabled}
			data["About"] = s.moduleAbout(p.Locale, info.Key)
			if info.Key == "webhooks" {
				hooks, err := s.webhooksData(r, p, bot.ID)
				if err != nil {
					s.fail(w, r, p, err)
					return
				}
				data["Webhooks"] = hooks
			}
			if info.Key == "emoji-manager" {
				data["Emojis"] = s.emojiData(r, p, bot.ID)
			}
			if info.Key == "message-builder" {
				mb, err := s.msgBuilderView(r, p, bot)
				if err != nil {
					s.fail(w, r, p, err)
					return
				}
				data["MsgBuilder"] = mb
			}
			if info.Key == "twitch-alerts" {
				tv := s.twitchAuthView(r, bot.ID)
				tv.CSRF = p.CSRF
				data["TwitchAuth"] = tv
			}
			if info.Key == "member-stats" {
				ms, err := s.memberStatsView(r, p, bot.ID)
				if err != nil {
					s.fail(w, r, p, err)
					return
				}
				data["MemberStats"] = ms
			}
			if info.Key == "card-designer" {
				cards, err := s.cardsView(r, bot.ID)
				if err != nil {
					s.fail(w, r, p, err)
					return
				}
				data["Cards"] = cards
			}
			if info.Key == "data-storage" {
				storage, err := s.dataStorageView(r, bot.ID)
				if err != nil {
					s.fail(w, r, p, err)
					return
				}
				data["Storage"] = storage
			}
			if info.Key == "moderation" {
				mod, err := s.moderationData(r, bot.ID)
				if err != nil {
					s.fail(w, r, p, err)
					return
				}
				data["Moderation"] = mod
			}
			if sc, ok := moduleSchema(info.Key); ok {
				settings, err := s.settingsData(r, bot.ID, sc)
				if err != nil {
					s.fail(w, r, p, err)
					return
				}
				data["Settings"] = settings
			}
			if info.Key == "timed-events" {
				timed, err := s.timedData(r, bot.ID)
				if err != nil {
					s.fail(w, r, p, err)
					return
				}
				data["Timed"] = timed
			}
			if h, ok := map[string]hub{"command-builder": commandHub, "custom-events": eventHub}[info.Key]; ok {
				custom, err := s.customCommands(r, h, bot.ID)
				if err != nil {
					s.fail(w, r, p, err)
					return
				}
				data["Custom"] = custom
			}
		} else {
			plugins, err := s.pluginViews(r, bot.ID)
			if err != nil {
				s.fail(w, r, p, err)
				return
			}
			var found *pluginView
			for i := range plugins {
				if plugins[i].ID == key {
					found = &plugins[i]
				}
			}
			if found == nil {
				s.fail(w, r, p, &api.Error{Status: http.StatusNotFound, Key: "error.not_found"})
				return
			}
			data["Plugin"] = *found
			// Full URLs of the plugin's webhooks: the dashboard proxies /api/* to the API.
			var hooks []map[string]string
			for _, h := range found.Webhooks {
				hooks = append(hooks, map[string]string{"Name": h.Name, "URL": baseURL(r) + h.Path})
			}
			data["Webhooks"] = hooks
			pcmds, err := s.pluginCommands(r, bot.ID, key)
			if err != nil {
				s.fail(w, r, p, err)
				return
			}
			data["PluginCommands"] = pcmds
			// Files the plugin made for the owner (e.g. server backups): download links.
			if files, err := s.api.PluginFiles(r.Context(), session(r), bot.ID, key); err == nil {
				var downloads []pluginDownload
				for _, f := range files {
					if downloadable(f.Mime) {
						name := f.Filename
						if name == "" {
							name = f.Name
						}
						downloads = append(downloads, pluginDownload{Name: name, Size: humanSize(f.Size), Date: formatDateTime(f.CreatedAt, p.Locale),
							URL: fmt.Sprintf("/bot/%d/plugins/%s/download/%s", bot.ID, key, f.Name)})
					}
				}
				data["Downloads"] = downloads
			}
			settings, err := s.pluginSettingsData(r, bot.ID, found.InstalledPlugin)
			if err != nil {
				s.fail(w, r, p, err)
				return
			}
			if settings != nil {
				data["Settings"] = *settings
			}
		}
		s.render(w, http.StatusOK, "module_item", "layout", withData(p, data))
	}
}

// selectedBotOrHome loads the bot from the session cookie, or sends the user
// to the dashboard when none is selected.
func (s *Server) selectedBotOrHome(w http.ResponseWriter, r *http.Request, p Page) (api.Bot, bool) {
	var id int64
	if c, err := r.Cookie(botCookie); err == nil {
		id, _ = strconv.ParseInt(c.Value, 10, 64)
	}
	if id < 1 {
		redirect(w, r, "/")
		return api.Bot{}, false
	}
	bot, err := s.api.GetBot(r.Context(), session(r), id)
	if api.IsStatus(err, http.StatusNotFound) {
		http.SetCookie(w, &http.Cookie{Name: botCookie, Path: "/", MaxAge: -1})
		redirect(w, r, "/")
		return api.Bot{}, false
	}
	if err != nil {
		s.fail(w, r, p, err)
		return api.Bot{}, false
	}
	return bot, true
}

// pluginCommandView is one slash command a plugin added to the bot (its copy
// in Custom Commands), for the plugin page: toggle and builder link.
type pluginCommandView struct {
	BotID  int64
	Plugin string
	api.CustomCommand
}

// pluginCommands lists the bot's copies of the plugin's commands by name.
func (s *Server) pluginCommands(r *http.Request, botID int64, plugin string) ([]pluginCommandView, error) {
	all, err := s.api.CustomCommands(r.Context(), session(r), api.KindCommand, botID)
	if err != nil {
		return nil, err
	}
	var out []pluginCommandView
	for _, c := range all {
		if c.PluginID != nil && *c.PluginID == plugin {
			out = append(out, pluginCommandView{BotID: botID, Plugin: plugin, CustomCommand: c})
		}
	}
	slices.SortFunc(out, func(a, b pluginCommandView) int { return strings.Compare(a.Name, b.Name) })
	return out, nil
}

// handlePluginCommand switches one of the plugin's commands on or off, or
// sets who sees its replies (field "private"), and answers its row.
func (s *Server) handlePluginCommand(w http.ResponseWriter, r *http.Request, p Page) {
	id, ok := s.botID(w, r, p)
	if !ok {
		return
	}
	cid, err := strconv.ParseInt(r.PathValue("cid"), 10, 64)
	if err != nil {
		s.fail(w, r, p, &api.Error{Status: http.StatusNotFound, Key: "error.not_found"})
		return
	}
	plugin := r.PathValue("plugin")
	cur, err := s.api.CustomCommand(r.Context(), session(r), api.KindCommand, id, cid)
	if err != nil {
		s.fail(w, r, p, err)
		return
	}
	if cur.PluginID == nil || *cur.PluginID != plugin {
		s.fail(w, r, p, &api.Error{Status: http.StatusNotFound, Key: "error.not_found"})
		return
	}
	var c api.CustomCommand
	_ = r.ParseForm()
	if v, set := r.PostForm["private"]; set && len(v) > 0 {
		c, err = s.api.SetCustomCommandPrivate(r.Context(), session(r), api.KindCommand, id, cid, v[0] == "true")
	} else {
		c, err = s.api.SetCustomCommandEnabled(r.Context(), session(r), api.KindCommand, id, cid, r.PostFormValue("enabled") == "true")
	}
	if err != nil {
		s.fail(w, r, p, err)
		return
	}
	s.render(w, http.StatusOK, "module_item", "plugin_command_row_fragment", withData(p, pluginCommandView{BotID: id, Plugin: plugin, CustomCommand: c}))
}

// aboutStep is one row of a module's "How it works" article.
type aboutStep struct{ Title, Text string }

// moduleAbout is the short "How it works" article of a module: the texts
// module.<key>.about.<n> and module.<key>.about.<n>_hint (n = 1, 2, …) as far
// as they exist. Modules without such texts get none.
func (s *Server) moduleAbout(locale, key string) []aboutStep {
	var out []aboutStep
	for n := 1; n <= 10; n++ {
		k := fmt.Sprintf("module.%s.about.%d", key, n)
		title, ok := s.i18n.Lookup(locale, k)
		if !ok {
			break
		}
		out = append(out, aboutStep{Title: title, Text: s.i18n.T(locale, k+"_hint")})
	}
	return out
}

// pluginDownload is a file of a plugin the owner can download (not images or sounds).
type pluginDownload struct{ Name, Size, Date, URL string }

// downloadable: documents a plugin made (backups, attachments), not the
// images and sounds of its settings.
func downloadable(mime string) bool {
	return !strings.HasPrefix(mime, "image/") && !strings.HasPrefix(mime, "audio/")
}

func humanSize(n int64) string {
	switch {
	case n >= 1<<20:
		return fmt.Sprintf("%.1f MB", float64(n)/(1<<20))
	case n >= 1<<10:
		return fmt.Sprintf("%.1f KB", float64(n)/(1<<10))
	default:
		return fmt.Sprintf("%d B", n)
	}
}
