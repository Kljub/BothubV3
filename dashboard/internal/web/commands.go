package web

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"strings"

	"github.com/Kljub/BothubV3/dashboard/internal/api"
)

// Built-in commands per module (shared/commands.json) and the module content
// page: header with the module toggle, then one row per command.

// CommandInfo is one built-in command of the catalog.
type CommandInfo struct {
	Name   string
	Usage  string
	Module string
	// PresetGroup and PresetName locate its editable copy
	// (shared/command-presets.json); empty when there is no copy.
	PresetGroup string
	PresetName  string
}

// LoadCommands reads the command catalog, grouped by module in file order,
// and links each command to its preset copy in presetsPath.
func LoadCommands(path, presetsPath string) (map[string][]CommandInfo, error) {
	presets, err := loadPresets(presetsPath)
	if err != nil {
		return nil, err
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read command catalog: %w", err)
	}
	var catalog struct {
		Commands []struct {
			Name   string `json:"name"`
			Usage  string `json:"usage"`
			Module string `json:"module"`
		} `json:"commands"`
	}
	if err := json.Unmarshal(raw, &catalog); err != nil {
		return nil, fmt.Errorf("parse command catalog: %w", err)
	}
	out := map[string][]CommandInfo{}
	for _, c := range catalog.Commands {
		info := CommandInfo{Name: c.Name, Usage: c.Usage, Module: c.Module}
		if p, ok := presets.find(c.Module, c.Name, c.Usage); ok {
			info.PresetGroup, info.PresetName = p.Group, p.Name
		}
		out[c.Module] = append(out[c.Module], info)
	}
	return out, nil
}

type preset struct {
	Module string `json:"module"`
	Group  string `json:"group"`
	Name   string `json:"name"`
}

// presetIndex finds the preset copy of a catalog command. The two files
// name things differently (module "giveaway" vs "giveaways", command
// "music-play" vs "play", "invites-reset" vs "invite-reset", one "/birthday"
// entry vs the subcommands "birthday add", …), so both sides are normalized.
type presetIndex struct {
	byName map[string]preset // normModule + "/" + normName
	byTop  map[string]preset // normModule + "/" + first word, first in file order
}

func loadPresets(path string) (presetIndex, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return presetIndex{}, fmt.Errorf("read command presets: %w", err)
	}
	var doc struct {
		Commands []preset `json:"commands"`
	}
	if err := json.Unmarshal(raw, &doc); err != nil {
		return presetIndex{}, fmt.Errorf("parse command presets: %w", err)
	}
	idx := presetIndex{byName: map[string]preset{}, byTop: map[string]preset{}}
	for _, p := range doc.Commands {
		m := normModule(p.Module)
		idx.byName[m+"/"+normName(p.Name)] = p
		top, _, _ := strings.Cut(p.Name, " ")
		if _, ok := idx.byTop[m+"/"+normName(top)]; !ok {
			idx.byTop[m+"/"+normName(top)] = p
		}
	}
	return idx, nil
}

// find tries the catalog name, then the slash name from usage ("/play
// [song]" -> "play"), then the top-level command of a subcommand group.
func (idx presetIndex) find(module, name, usage string) (preset, bool) {
	m := normModule(module)
	slash := strings.TrimPrefix(strings.Fields(usage + " ")[0], "/")
	for _, n := range []string{name, slash} {
		if n == "" {
			continue
		}
		if p, ok := idx.byName[m+"/"+normName(n)]; ok {
			return p, true
		}
	}
	for _, n := range []string{slash, name} {
		top, _, _ := strings.Cut(n, " ")
		if p, ok := idx.byTop[m+"/"+normName(top)]; ok && top != "" {
			return p, true
		}
	}
	return preset{}, false
}

// normModule: "ticket-system" = "ticket", "giveaways" = "giveaway",
// "server-management" = "servermanagement".
func normModule(k string) string {
	k = strings.TrimSuffix(strings.ToLower(k), "-system")
	return strings.TrimSuffix(strings.ReplaceAll(k, "-", ""), "s")
}

// normName drops a plural "s" from each word part: "invites-reset" = "invite-reset".
func normName(n string) string {
	parts := strings.FieldsFunc(strings.ToLower(n), func(r rune) bool { return r == '-' || r == ' ' || r == '_' })
	for i, p := range parts {
		if len(p) > 3 {
			parts[i] = strings.TrimSuffix(p, "s")
		}
	}
	return strings.Join(parts, "-")
}

// presetCommandID finds the custom command copy of a built-in command: same
// name, in the preset group. Returns 0 when the user deleted or moved it.
func (s *Server) presetCommandID(r *http.Request, botID int64, c CommandInfo) (int64, error) {
	if c.PresetGroup == "" {
		return 0, nil
	}
	groups, err := s.api.CommandGroups(r.Context(), session(r), botID)
	if err != nil {
		return 0, err
	}
	var groupID int64
	for _, g := range groups {
		if g.Name == c.PresetGroup {
			groupID = g.ID
		}
	}
	if groupID == 0 {
		return 0, nil
	}
	cmds, err := s.api.CustomCommands(r.Context(), session(r), api.KindCommand, botID)
	if err != nil {
		return 0, err
	}
	for _, cmd := range cmds {
		if cmd.Name == c.PresetName && cmd.GroupID != nil && *cmd.GroupID == groupID {
			return cmd.ID, nil
		}
	}
	return 0, nil
}

// commandView is the data for the "command_row" template.
type commandView struct {
	BotID int64
	CommandInfo
	Enabled bool
}

// moduleHeaderView is the data for the "module_header" template.
type moduleHeaderView struct {
	BotID    int64
	Category string
	ModuleInfo
	Enabled bool
}

func (s *Server) moduleCommands(r *http.Request, botID int64, module string) ([]commandView, error) {
	// The database is the source of truth: a module command runs as its
	// copy in Custom Commands (the presets), so the switch shows that copy,
	// which is exactly what the bot registers. No copy = off.
	copies, err := s.presetCopies(r, botID)
	if err != nil {
		return nil, err
	}
	var out []commandView
	for _, c := range s.commands[module] {
		on := false
		if cp, ok := copies[presetKey(c)]; ok {
			on = cp.Enabled
		}
		out = append(out, commandView{BotID: botID, CommandInfo: c, Enabled: on})
	}
	return out, nil
}

func presetKey(c CommandInfo) string { return c.PresetGroup + "/" + c.PresetName }

// presetCopies maps group+name of every command in a preset group to it.
func (s *Server) presetCopies(r *http.Request, botID int64) (map[string]api.CustomCommand, error) {
	groups, err := s.api.CommandGroups(r.Context(), session(r), botID)
	if err != nil {
		return nil, err
	}
	names := map[int64]string{}
	for _, g := range groups {
		names[g.ID] = g.Name
	}
	cmds, err := s.api.CustomCommands(r.Context(), session(r), api.KindCommand, botID)
	if err != nil {
		return nil, err
	}
	out := map[string]api.CustomCommand{}
	for _, cmd := range cmds {
		if cmd.GroupID != nil {
			if g, ok := names[*cmd.GroupID]; ok {
				out[g+"/"+cmd.Name] = cmd
			}
		}
	}
	return out, nil
}

func (s *Server) moduleEnabled(r *http.Request, botID int64, key string) (bool, error) {
	states, err := s.api.ListBotModules(r.Context(), session(r), botID)
	if err != nil {
		return false, err
	}
	for _, st := range states {
		if st.Key == key {
			return st.Enabled, nil
		}
	}
	return false, nil
}

// handleModuleState toggles a module from its content page header.
func (s *Server) handleModuleState(w http.ResponseWriter, r *http.Request, p Page) {
	id, ok := s.botID(w, r, p)
	if !ok {
		return
	}
	info, category, found := s.findModule(r.PathValue("key"))
	if !found {
		s.fail(w, r, p, &api.Error{Status: http.StatusNotFound, Key: "error.module.unknown"})
		return
	}
	state, err := s.api.SetBotModule(r.Context(), session(r), id, info.Key, r.PostFormValue("enabled") == "true")
	if err != nil {
		s.fail(w, r, p, err)
		return
	}
	s.render(w, http.StatusOK, "module_item", "module_header_fragment",
		withData(p, moduleHeaderView{BotID: id, Category: category, ModuleInfo: info, Enabled: state.Enabled}))
}

// handleCommandState enables or disables one command and returns its row.
func (s *Server) handleCommandState(w http.ResponseWriter, r *http.Request, p Page) {
	id, ok := s.botID(w, r, p)
	if !ok {
		return
	}
	module, name := r.PathValue("key"), r.PathValue("name")
	var info *CommandInfo
	for i := range s.commands[module] {
		if s.commands[module][i].Name == name {
			info = &s.commands[module][i]
		}
	}
	if info == nil {
		s.fail(w, r, p, &api.Error{Status: http.StatusNotFound, Key: "error.command.unknown"})
		return
	}
	on := r.PostFormValue("enabled") == "true"
	// Switch the runnable copy (see moduleCommands).
	if cid, err := s.presetCommandID(r, id, *info); err != nil {
		s.fail(w, r, p, err)
		return
	} else if cid > 0 {
		cmd, err := s.api.SetCustomCommandEnabled(r.Context(), session(r), api.KindCommand, id, cid, on)
		if err != nil {
			s.fail(w, r, p, err)
			return
		}
		s.render(w, http.StatusOK, "module_item", "command_row_fragment", withData(p, commandView{BotID: id, CommandInfo: *info, Enabled: cmd.Enabled}))
		return
	}
	// No copy in the database: nothing the bot could run.
	s.fail(w, r, p, &api.Error{Status: http.StatusNotFound, Key: "error.command.unknown"})
}

// handleCommandPage is the placeholder behind the gear of a command row; the
// command builder opens here in phase 4.
func (s *Server) handleCommandPage(w http.ResponseWriter, r *http.Request, p Page) {
	bot, ok := s.selectedBotOrHome(w, r, p)
	if !ok {
		return
	}
	name := r.PathValue("name")
	for module, list := range s.commands {
		for _, c := range list {
			if c.Name != name {
				continue
			}
			// The editable copy opens in the command builder.
			cid, err := s.presetCommandID(r, bot.ID, c)
			if err != nil {
				s.fail(w, r, p, err)
				return
			}
			if cid > 0 {
				// Full page load: the builder has its own layout and scripts.
				fullRedirect(w, r, fmt.Sprintf("/bots/builder/%d?module=%s", cid, url.QueryEscape(module)))
				return
			}
			info, category, _ := s.findModule(module)
			p.SelectedBot = &bot
			p.Nav = "bot_modules"
			s.render(w, http.StatusOK, "module_item", "layout", withData(p, map[string]any{
				"Kind": "command", "Bot": bot, "Command": c, "Module": info, "Category": category,
			}))
			return
		}
	}
	s.fail(w, r, p, &api.Error{Status: http.StatusNotFound, Key: "error.command.unknown"})
}
