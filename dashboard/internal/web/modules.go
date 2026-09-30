package web

import (
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"strconv"

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
	cats := make([]categoryView, 0, len(s.modules))
	for _, c := range s.modules {
		cv := categoryView{Key: c.Key, Icon: c.Icon, Total: len(c.Modules)}
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

func (s *Server) pluginViews(r *http.Request, botID int64) ([]pluginView, error) {
	plugins, err := s.api.ListBotPlugins(r.Context(), session(r), botID)
	if err != nil {
		return nil, err
	}
	out := make([]pluginView, len(plugins))
	for i, pl := range plugins {
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
			if info.Key == "webhooks" {
				hooks, err := s.webhooksData(r, p, bot.ID)
				if err != nil {
					s.fail(w, r, p, err)
					return
				}
				data["Webhooks"] = hooks
			}
			if info.Key == "message-builder" {
				mb, err := s.msgBuilderView(r, p, bot)
				if err != nil {
					s.fail(w, r, p, err)
					return
				}
				data["MsgBuilder"] = mb
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
