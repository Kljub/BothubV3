package web

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"

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
	} else if info, _, found := s.findModule(r.URL.Query().Get("module")); found {
		// Opened from a module page (preset copy of a built-in command).
		backURL = "/bots/modules/" + info.Key
	}
	base := fmt.Sprintf("/api/v1/bots/%d/%s/%d", bot.ID, h.Kind, cmd.ID)
	s.render(w, http.StatusOK, "builder", "builder_layout", withData(p, map[string]any{
		"Command": cmd,
		"BotID":   bot.ID,
		"BackURL": backURL,
		"IsEvent": h.Event(),
		"Events":  jsonIsland(events),
		// JSON islands read by builder.js.
		"Nodes": jsonIsland(s.nodeDefs),
		// Re-marshalled: escapes <, > and & in user content (e.g. reply texts).
		"Graph":     jsonIsland(graph),
		"Texts":     jsonIsland(s.editorTexts(p.Locale)),
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
			"templatesUrl":   fmt.Sprintf("/api/v1/bots/%d/message-templates", bot.ID),
			"timedEventsUrl": fmt.Sprintf("/api/v1/bots/%d/timed-events", bot.ID),
			"webhooksUrl":    fmt.Sprintf("/api/v1/bots/%d/webhooks", bot.ID),
			"dataVarsUrl":    fmt.Sprintf("/api/v1/bots/%d/data/variables", bot.ID),
			"versionsUrl":    base + "/versions",
			"updatedAt":      cmd.UpdatedAt,
			"docsUrl":        "/bots/docs",
			"backUrl":        backURL,
		}),
	}))
}
