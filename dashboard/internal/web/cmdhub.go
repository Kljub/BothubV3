package web

import (
	"net/http"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/Kljub/BothubV3/dashboard/internal/api"
)

// Custom commands page ("command hub"): start card, search and status
// filter, commands in groups (folders), a row expands to a preview and the
// version history. Dialogs: groups, recently deleted. Custom events use the
// same page and handlers under /bot/{id}/custom-events; groups are shared.

// hub tells custom commands and custom events apart.
type hub struct {
	Kind api.Kind
	Base string // dashboard path: custom-commands or custom-events
}

var (
	commandHub = hub{Kind: api.KindCommand, Base: "custom-commands"}
	eventHub   = hub{Kind: api.KindEvent, Base: "custom-events"}
)

func hubOf(r *http.Request) hub {
	if strings.Contains(r.URL.Path, "/custom-events") || strings.HasPrefix(r.URL.Path, "/bots/events/") {
		return eventHub
	}
	return commandHub
}

func (h hub) Event() bool { return h.Kind == api.KindEvent }

// eventTexts are the cmdhub.* keys with an events.* wording.
var eventTexts = map[string]bool{
	"active": true, "search": true, "new": true, "delete_confirm": true, "empty.title": true, "empty.hint": true,
	"deleted.title": true, "deleted.hint": true, "no_match": true, "group_empty": true, "open_hint": true, "expand": true, "group_of": true,
}

// Text returns the translation key for a page text of this hub.
func (h hub) Text(key string) string {
	if h.Event() && eventTexts[key] {
		return "events." + key
	}
	return "cmdhub." + key
}

// BuilderURL opens the node editor for one command or event.
func (h hub) BuilderURL(id int64) string {
	if h.Event() {
		return "/bots/events/builder/" + strconv.FormatInt(id, 10)
	}
	return "/bots/builder/" + strconv.FormatInt(id, 10)
}

type commandGroupView struct {
	ID          int64 // 0 = ungrouped
	Name        string
	Description string
	Commands    []api.CustomCommand
}

type customCommandsView struct {
	Hub       hub
	BotID     int64
	Total     int
	Query     string
	Status    string
	Type      string // custom events: category filter ("" = all)
	Types     []eventTypeFilter
	Groups    []commandGroupView
	AllGroups []api.CommandGroup
	Filtered  bool
}

// eventTypeFilter is one option of the event category filter.
type eventTypeFilter struct {
	Key   string
	Count int
}

var commandStatuses = []string{"all", "enabled", "disabled"}

// customCommands loads commands and groups; q and status come from the
// query string or the toolbar values htmx sends along.
func (s *Server) customCommands(r *http.Request, h hub, botID int64) (customCommandsView, error) {
	all, err := s.api.CustomCommands(r.Context(), session(r), h.Kind, botID)
	if err != nil {
		return customCommandsView{}, err
	}
	// Module and plugin copies (and their system folders) are managed on the
	// module and plugin pages, never listed here. Other hidden commands stay
	// hidden; a group holding only such commands is hidden with them.
	cmds := make([]api.CustomCommand, 0, len(all))
	onlyHidden := map[int64]bool{}
	for _, c := range all {
		if c.Hidden || c.Copy {
			if c.GroupID != nil {
				if _, seen := onlyHidden[*c.GroupID]; !seen {
					onlyHidden[*c.GroupID] = true
				}
			}
			continue
		}
		if c.GroupID != nil {
			onlyHidden[*c.GroupID] = false
		}
		cmds = append(cmds, c)
	}
	groups, err := s.api.CommandGroups(r.Context(), session(r), botID)
	if err != nil {
		return customCommandsView{}, err
	}
	q := strings.ToLower(strings.TrimSpace(r.FormValue("q")))
	status := r.FormValue("status")
	if !slices.Contains(commandStatuses, status) {
		status = "all"
	}
	v := customCommandsView{Hub: h, BotID: botID, Total: len(cmds), Query: q, Status: status, AllGroups: api.UserGroups(groups)}
	if h.Event() {
		counts := map[string]int{}
		for _, c := range cmds {
			counts[s.eventCategoryOf(c.EventType)]++
		}
		for _, c := range s.events {
			v.Types = append(v.Types, eventTypeFilter{Key: c.Key, Count: counts[c.Key]})
			if c.Key == r.FormValue("type") {
				v.Type = c.Key
			}
		}
	}
	v.Filtered = q != "" || status != "all" || v.Type != ""
	match := func(c api.CustomCommand) bool {
		if status == "enabled" && !c.Enabled || status == "disabled" && c.Enabled {
			return false
		}
		if v.Type != "" && s.eventCategoryOf(c.EventType) != v.Type {
			return false
		}
		return q == "" || strings.Contains(strings.ToLower(c.Name+" "+c.Description+" "+c.EventType), q)
	}
	byGroup := map[int64][]api.CustomCommand{}
	known := map[int64]bool{}
	for _, g := range groups {
		// A user command in a system folder (should not happen) shows ungrouped.
		known[g.ID] = !g.System
	}
	for _, c := range cmds {
		if !match(c) {
			continue
		}
		gid := int64(0)
		if c.GroupID != nil && known[*c.GroupID] {
			gid = *c.GroupID
		}
		byGroup[gid] = append(byGroup[gid], c)
	}
	sortByName := func(list []api.CustomCommand) {
		slices.SortFunc(list, func(a, b api.CustomCommand) int { return strings.Compare(a.Name, b.Name) })
	}
	for _, g := range groups {
		if onlyHidden[g.ID] || g.System {
			continue
		}
		if list := byGroup[g.ID]; len(list) > 0 || !v.Filtered {
			sortByName(list)
			v.Groups = append(v.Groups, commandGroupView{ID: g.ID, Name: g.Name, Description: g.Description, Commands: list})
		}
	}
	if list := byGroup[0]; len(list) > 0 {
		sortByName(list)
		v.Groups = append(v.Groups, commandGroupView{Commands: list})
	}
	return v, nil
}

// renderCommandList re-renders the list (#cmd-list), keeping the filter.
func (s *Server) renderCommandList(w http.ResponseWriter, r *http.Request, p Page, botID int64) {
	v, err := s.customCommands(r, hubOf(r), botID)
	if err != nil {
		s.fail(w, r, p, err)
		return
	}
	s.render(w, http.StatusOK, "module_item", "custom_commands_list_fragment", withData(p, v))
}

func (s *Server) handleCommandList(w http.ResponseWriter, r *http.Request, p Page) {
	id, ok := s.botID(w, r, p)
	if !ok {
		return
	}
	s.renderCommandList(w, r, p, id)
}

func commandID(r *http.Request) int64 {
	id, _ := strconv.ParseInt(r.PathValue("cid"), 10, 64)
	return id
}

func (s *Server) handleCommandEnabled(w http.ResponseWriter, r *http.Request, p Page) {
	id, ok := s.botID(w, r, p)
	if !ok {
		return
	}
	if _, err := s.api.SetCustomCommandEnabled(r.Context(), session(r), hubOf(r).Kind, id, commandID(r), r.PostFormValue("enabled") == "true"); err != nil {
		s.fail(w, r, p, err)
		return
	}
	s.renderCommandList(w, r, p, id)
}

func (s *Server) handleCommandGroupMove(w http.ResponseWriter, r *http.Request, p Page) {
	id, ok := s.botID(w, r, p)
	if !ok {
		return
	}
	var group *int64
	if g, err := strconv.ParseInt(r.PostFormValue("group"), 10, 64); err == nil && g > 0 {
		group = &g
	}
	if err := s.api.SetCustomCommandGroup(r.Context(), session(r), hubOf(r).Kind, id, commandID(r), group); err != nil {
		s.fail(w, r, p, err)
		return
	}
	s.renderCommandList(w, r, p, id)
}

func (s *Server) handleDeleteCommand(w http.ResponseWriter, r *http.Request, p Page) {
	id, ok := s.botID(w, r, p)
	if !ok {
		return
	}
	if err := s.api.DeleteCustomCommand(r.Context(), session(r), hubOf(r).Kind, id, commandID(r)); err != nil {
		s.fail(w, r, p, err)
		return
	}
	s.renderCommandList(w, r, p, id)
}

// --- expanded row: preview and version history ---

type commandDetailsView struct {
	Hub      hub
	BotID    int64
	Command  api.CustomCommand
	Versions []commandVersionView
}

type commandVersionView struct {
	ID      int64
	SavedAt string
	Nodes   int
	Current bool
}

func (s *Server) commandDetails(w http.ResponseWriter, r *http.Request, p Page, botID int64) {
	cid, h := commandID(r), hubOf(r)
	cmd, err := s.api.CustomCommand(r.Context(), session(r), h.Kind, botID, cid)
	if err != nil {
		s.fail(w, r, p, err)
		return
	}
	versions, err := s.api.CommandVersions(r.Context(), session(r), h.Kind, botID, cid)
	if err != nil {
		s.fail(w, r, p, err)
		return
	}
	v := commandDetailsView{Hub: h, BotID: botID, Command: cmd}
	for i, ver := range versions {
		v.Versions = append(v.Versions, commandVersionView{ID: ver.ID, SavedAt: formatDateTime(ver.SavedAt, p.Locale), Nodes: ver.Nodes, Current: i == 0})
	}
	s.render(w, http.StatusOK, "module_item", "custom_command_details_fragment", withData(p, v))
}

func (s *Server) handleCommandDetails(w http.ResponseWriter, r *http.Request, p Page) {
	id, ok := s.botID(w, r, p)
	if !ok {
		return
	}
	s.commandDetails(w, r, p, id)
}

func (s *Server) handleRestoreVersion(w http.ResponseWriter, r *http.Request, p Page) {
	id, ok := s.botID(w, r, p)
	if !ok {
		return
	}
	vid, _ := strconv.ParseInt(r.PathValue("vid"), 10, 64)
	if err := s.api.RestoreCommandVersion(r.Context(), session(r), hubOf(r).Kind, id, commandID(r), vid); err != nil {
		s.fail(w, r, p, err)
		return
	}
	s.commandDetails(w, r, p, id)
}

// --- groups dialog ---

type commandGroupsView struct {
	BotID  int64
	Groups []api.CommandGroup
}

func (s *Server) renderGroups(w http.ResponseWriter, r *http.Request, p Page, botID int64, changed bool) {
	groups, err := s.api.CommandGroups(r.Context(), session(r), botID)
	if err != nil {
		s.failTo(w, r, p, err, "#groups-error")
		return
	}
	if changed {
		// The command list listens for this and reloads itself.
		w.Header().Set("HX-Trigger", "bothub:commands-changed")
	}
	s.render(w, http.StatusOK, "module_item", "command_groups_fragment", withData(p, commandGroupsView{BotID: botID, Groups: api.UserGroups(groups)}))
}

func (s *Server) handleCommandGroups(w http.ResponseWriter, r *http.Request, p Page) {
	id, ok := s.botID(w, r, p)
	if !ok {
		return
	}
	s.renderGroups(w, r, p, id, false)
}

func groupFromForm(r *http.Request) api.CommandGroup {
	pos, _ := strconv.Atoi(r.PostFormValue("position"))
	return api.CommandGroup{Name: strings.TrimSpace(r.PostFormValue("name")), Description: strings.TrimSpace(r.PostFormValue("description")), Position: pos}
}

func (s *Server) handleCreateGroup(w http.ResponseWriter, r *http.Request, p Page) {
	id, ok := s.botID(w, r, p)
	if !ok {
		return
	}
	if err := s.api.CreateCommandGroup(r.Context(), session(r), id, groupFromForm(r)); err != nil {
		s.failTo(w, r, p, err, "#groups-error")
		return
	}
	s.renderGroups(w, r, p, id, true)
}

func (s *Server) handleUpdateGroup(w http.ResponseWriter, r *http.Request, p Page) {
	id, ok := s.botID(w, r, p)
	if !ok {
		return
	}
	g := groupFromForm(r)
	g.ID, _ = strconv.ParseInt(r.PathValue("gid"), 10, 64)
	if err := s.api.UpdateCommandGroup(r.Context(), session(r), id, g); err != nil {
		s.failTo(w, r, p, err, "#groups-error")
		return
	}
	s.renderGroups(w, r, p, id, true)
}

func (s *Server) handleDeleteGroup(w http.ResponseWriter, r *http.Request, p Page) {
	id, ok := s.botID(w, r, p)
	if !ok {
		return
	}
	gid, _ := strconv.ParseInt(r.PathValue("gid"), 10, 64)
	if err := s.api.DeleteCommandGroup(r.Context(), session(r), id, gid); err != nil {
		s.failTo(w, r, p, err, "#groups-error")
		return
	}
	s.renderGroups(w, r, p, id, true)
}

// --- recently deleted dialog ---

type deletedCommandsView struct {
	Hub      hub
	BotID    int64
	Commands []deletedCommandView
}

type deletedCommandView struct {
	api.DeletedCommand
	When string
}

func (s *Server) renderDeleted(w http.ResponseWriter, r *http.Request, p Page, botID int64, changed bool) {
	h := hubOf(r)
	list, err := s.api.DeletedCommands(r.Context(), session(r), h.Kind, botID)
	if err != nil {
		s.failTo(w, r, p, err, "#deleted-error")
		return
	}
	v := deletedCommandsView{Hub: h, BotID: botID}
	for _, d := range list {
		v.Commands = append(v.Commands, deletedCommandView{DeletedCommand: d, When: formatDateTime(d.DeletedAt, p.Locale)})
	}
	if changed {
		w.Header().Set("HX-Trigger", "bothub:commands-changed")
	}
	s.render(w, http.StatusOK, "module_item", "deleted_commands_fragment", withData(p, v))
}

func (s *Server) handleDeletedCommands(w http.ResponseWriter, r *http.Request, p Page) {
	id, ok := s.botID(w, r, p)
	if !ok {
		return
	}
	s.renderDeleted(w, r, p, id, false)
}

func (s *Server) handleRestoreDeleted(w http.ResponseWriter, r *http.Request, p Page) {
	id, ok := s.botID(w, r, p)
	if !ok {
		return
	}
	if err := s.api.RestoreDeletedCommand(r.Context(), session(r), hubOf(r).Kind, id, commandID(r)); err != nil {
		s.failTo(w, r, p, err, "#deleted-error")
		return
	}
	s.renderDeleted(w, r, p, id, true)
}

// formatDateTime writes a date and time the way the locale expects.
func formatDateTime(t time.Time, locale string) string {
	if strings.HasPrefix(locale, "de") {
		return t.Local().Format("02.01.2006, 15:04")
	}
	return t.Local().Format("Jan 2, 2006, 15:04")
}
