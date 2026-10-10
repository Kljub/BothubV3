package web

import (
	"encoding/json"
	"fmt"
	"maps"
	"net/http"
	"slices"
	"strconv"
	"strings"

	"github.com/Kljub/BothubV3/dashboard/internal/api"
)

// Command builder: creating a command opens the editor; the list page lives
// in cmdhub.go. The node editor opens at /bots/builder/{id}, for custom
// events at /bots/events/builder/{id}.

// handleCreateCommand creates a custom command with a free placeholder name
// and a starter graph, then opens the editor right away. Name and
// description are set in the editor (slash command properties).
func (s *Server) handleCreateCommand(w http.ResponseWriter, r *http.Request, p Page) {
	id, ok := s.botID(w, r, p)
	if !ok {
		return
	}
	h := hubOf(r)
	existing, err := s.api.CustomCommands(r.Context(), session(r), h.Kind, id)
	if err != nil {
		s.fail(w, r, p, err)
		return
	}
	var cmd api.CustomCommand
	if h.Event() {
		cmd, err = s.api.CreateCustomEvent(r.Context(), session(r), id, freeName(existing, s.i18n.T(p.Locale, "events.new_name"), " "))
	} else {
		cmd, err = s.api.CreateCustomCommand(r.Context(), session(r), id, freeName(existing, "new-command", "-"), "")
	}
	if err != nil {
		s.fail(w, r, p, err)
		return
	}
	// The editor is its own full-screen document: full page load, no boost swap.
	to := h.BuilderURL(cmd.ID) + "?setup=1"
	if isHTMX(r) {
		w.Header().Set("HX-Redirect", to)
		w.WriteHeader(http.StatusNoContent)
		return
	}
	http.Redirect(w, r, to, http.StatusSeeOther)
}

const builderCSP = "default-src 'self'; script-src 'self'; style-src 'self'; " +
	"img-src 'self' data: https:; connect-src 'self'; " +
	"frame-ancestors 'none'; base-uri 'self'; form-action 'self'"

// freeName returns base, base+sep+"2", ... whichever is unused.
func freeName(cmds []api.CustomCommand, base, sep string) string {
	used := map[string]bool{}
	for _, c := range cmds {
		used[c.Name] = true
	}
	name := base
	for i := 2; used[name]; i++ {
		name = base + sep + strconv.Itoa(i)
	}
	return name
}

// handleBuilderPage opens the full-screen node editor for one command.
func (s *Server) handleBuilderPage(w http.ResponseWriter, r *http.Request, p Page) {
	bot, ok := s.selectedBotOrHome(w, r, p)
	if !ok {
		return
	}
	// The message preview shows embed images from any https URL; scripts and
	// styles stay local.
	w.Header().Set("Content-Security-Policy", builderCSP)
	cid, h := commandID(r), hubOf(r)
	module := r.URL.Query().Get("module")
	// The address bar shows only /bots/builder/ (builder.js): a reload of
	// that address opens the command remembered here.
	cookie := "bothub_builder_" + string(h.Kind)
	if cid == 0 {
		c, err := r.Cookie(cookie)
		var last builderCookie
		if err == nil {
			last = parseBuilderCookie(c.Value)
		}
		if last.ID == 0 || last.Bot != bot.ID {
			back := "/bots/modules/command-builder"
			if h.Event() {
				back = "/bots/modules/custom-events"
			}
			http.Redirect(w, r, back, http.StatusSeeOther)
			return
		}
		cid, module = last.ID, last.Module
	}
	http.SetCookie(w, &http.Cookie{
		Name: cookie, Value: builderCookie{Bot: bot.ID, ID: cid, Module: module}.String(), Path: "/",
		HttpOnly: true, SameSite: http.SameSiteStrictMode, Secure: r.TLS != nil,
	})
	cmd, err := s.api.CustomCommand(r.Context(), session(r), h.Kind, bot.ID, cid)
	if err != nil {
		s.fail(w, r, p, err)
		return
	}
	graph := cmd.Graph
	if len(graph) == 0 {
		graph = json.RawMessage("null")
	}
	p.SelectedBot = &bot
	kind, backURL := "command", "/bots/modules/command-builder"
	var events any
	if h.Event() {
		kind, backURL, events = "event", "/bots/modules/custom-events", s.events
	} else if info, _, found := s.findModule(module); found {
		// Opened from a module page (preset copy of a built-in command).
		backURL = "/bots/modules/" + info.Key
	}
	base := fmt.Sprintf("/api/v1/bots/%d/%s/%d", bot.ID, h.Kind, cmd.ID)
	// Core nodes plus the blocks of the bot's plugins, with their texts.
	nodes := slices.Clone(s.nodeDefs)
	texts := s.editorTexts(p.Locale)
	pluginDefs, pluginTexts := s.pluginNodes(r, p, bot.ID)
	nodes = append(nodes, pluginDefs...)
	maps.Copy(texts, pluginTexts)
	s.render(w, http.StatusOK, "builder", "builder_layout", withData(p, map[string]any{
		"Command": cmd,
		"BotID":   bot.ID,
		"BackURL": backURL,
		"IsEvent": h.Event(),
		"Events":  jsonIsland(events),
		// JSON islands read by builder.js.
		"Nodes": jsonIsland(nodes),
		// Re-marshalled: escapes <, > and & in user content (e.g. reply texts).
		"Graph":     jsonIsland(graph),
		"Texts":     jsonIsland(texts),
		"Variables": jsonIsland(variableCatalog()),
		"Meta": jsonIsland(map[string]any{
			"kind":           kind,
			"botId":          bot.ID,
			"botName":        bot.Name,
			"botAvatar":      bot.AvatarURL,
			"commandId":      cmd.ID,
			"name":           cmd.Name,
			"description":    cmd.Description,
			"enabled":        cmd.Enabled,
			"saveUrl":        base,
			"simulateUrl":    base + "/simulate",
			"guildsUrl":      fmt.Sprintf("/api/v1/bots/%d/guilds", bot.ID),
			"appEmojisUrl":   fmt.Sprintf("/api/v1/bots/%d/app-emojis", bot.ID),
			"templatesUrl":   fmt.Sprintf("/api/v1/bots/%d/message-templates", bot.ID),
			"timedEventsUrl": fmt.Sprintf("/api/v1/bots/%d/timed-events", bot.ID),
			"webhooksUrl":    fmt.Sprintf("/api/v1/bots/%d/webhooks", bot.ID),
			"cardsUrl":       fmt.Sprintf("/api/v1/bots/%d/cards", bot.ID),
			"dataVarsUrl":    fmt.Sprintf("/api/v1/bots/%d/data/variables", bot.ID),
			"versionsUrl":    base + "/versions",
			// Playbacks: the runs of this command, one run, the reasons in this language.
			"runsUrl":   fmt.Sprintf("/api/v1/bots/%d/runs?command=%d&limit=50", bot.ID, cmd.ID),
			"runUrl":    fmt.Sprintf("/api/v1/bots/%d/runs", bot.ID),
			"runErrors": localRunTexts(p.Locale),
			"openRun":   openRunID(r),
			"intents":   bot.Intents,
			"updatedAt": cmd.UpdatedAt,
			"docsUrl":   "/bots/docs",
			"backUrl":   backURL,
		}),
	}))
}

// builderCookie: the command the builder had open (bot, command, module
// it was opened from), so /bots/builder/ without an ID opens it again.
type builderCookie struct {
	Bot, ID int64
	Module  string
}

func (c builderCookie) String() string {
	return fmt.Sprintf("%d.%d.%s", c.Bot, c.ID, c.Module)
}

func parseBuilderCookie(v string) builderCookie {
	parts := strings.SplitN(v, ".", 3)
	if len(parts) < 2 {
		return builderCookie{}
	}
	bot, err1 := strconv.ParseInt(parts[0], 10, 64)
	id, err2 := strconv.ParseInt(parts[1], 10, 64)
	if err1 != nil || err2 != nil || bot < 1 || id < 1 {
		return builderCookie{}
	}
	c := builderCookie{Bot: bot, ID: id}
	if len(parts) == 3 && len(parts[2]) <= 64 {
		c.Module = parts[2]
	}
	return c
}

// pluginPortWords turns a port name of a plugin block into its fallback
// label ("not_found" -> "Not found").
var pluginPortWords = strings.NewReplacer("_", " ")

// pluginNodes turns the blocks of the bot's plugins (manifest.blocks) into
// builder node definitions: type plugin.<id>.<block>, group "plugin", ports
// with labels, the plugin icon. Blocks of plugins that are off for the bot
// are still defined (existing graphs keep their ports) but not offered in
// the palette. It also returns the texts the definitions point to.
func (s *Server) pluginNodes(r *http.Request, p Page, botID int64) ([]json.RawMessage, map[string]string) {
	plugins, err := s.pluginViews(r, botID)
	if err != nil {
		return nil, nil
	}
	var defs []json.RawMessage
	texts := map[string]string{}
	for _, pl := range plugins {
		var m struct {
			Blocks []struct {
				Name       string         `json:"name"`
				Definition map[string]any `json:"definition"`
			} `json:"blocks"`
		}
		if json.Unmarshal(pl.Manifest, &m) != nil {
			continue
		}
		prefix := "plugin." + pl.ID + "."
		for i, b := range m.Blocks {
			def := map[string]any{}
			for k, v := range b.Definition {
				def[k] = v
			}
			def["type"] = "plugin." + pl.ID + "." + b.Name
			def["version"] = 1
			def["group"] = "plugin"
			def["order"] = 9000 + i
			def["icon"] = pl.Icon
			if pl.Icon == "" {
				def["icon"] = "🧩"
			}
			if _, ok := def["category"]; !ok {
				def["category"] = "action"
			}
			if _, ok := def["color"]; !ok {
				def["color"] = "purple"
			}
			if !pl.Enabled || len(pl.BlockedBy) > 0 {
				def["palette"] = false
			}
			for _, side := range []string{"inputs", "outputs"} {
				ports, _ := def[side].([]any)
				if len(ports) == 0 && side == "inputs" {
					ports = []any{map[string]any{"name": "in", "type": "flow", "multiple": true}}
				}
				for _, raw := range ports {
					port, ok := raw.(map[string]any)
					if !ok {
						continue
					}
					name, _ := port["name"].(string)
					if _, has := port["type"]; !has {
						port["type"] = "flow"
					}
					if key, _ := port["labelKey"].(string); key != "" {
						continue
					}
					// The plugin's own text first (lang/<locale>.json "plugin.<id>.port.<name>"),
					// then BotHub's port text, then the name itself.
					k := prefix + "port." + name
					if v := s.i18n.T(p.Locale, k); v != k {
						port["labelKey"], texts[k] = k, v
						continue
					}
					if bk := "builder.port." + name; s.i18n.T(p.Locale, bk) != bk {
						port["labelKey"] = bk
						continue
					}
					port["labelKey"] = k
					words := pluginPortWords.Replace(name)
					texts[k] = strings.ToUpper(words[:1]) + words[1:]
				}
				def[side] = ports
			}
			collectPluginTexts(def, prefix, func(key string) { texts[key] = s.i18n.T(p.Locale, key) })
			if raw, err := json.Marshal(def); err == nil {
				defs = append(defs, raw)
			}
		}
	}
	return defs, texts
}

// collectPluginTexts calls add for every "...Key" string value under prefix.
func collectPluginTexts(v any, prefix string, add func(string)) {
	switch x := v.(type) {
	case map[string]any:
		for k, val := range x {
			if s, ok := val.(string); ok && strings.HasSuffix(k, "Key") && strings.HasPrefix(s, prefix) {
				add(s)
				continue
			}
			collectPluginTexts(val, prefix, add)
		}
	case []any:
		for _, val := range x {
			collectPluginTexts(val, prefix, add)
		}
	}
}
