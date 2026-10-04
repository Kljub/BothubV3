package main

import (
	"encoding/json"
	"math/rand"
	"net/http"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"time"
)

// Custom commands of the mock API (command builder). New commands get a
// starter graph: slash trigger -> reply.

type customCommand struct {
	ID          int64           `json:"id"`
	Name        string          `json:"name"`
	Description string          `json:"description"`
	Enabled     bool            `json:"enabled"`
	Builtin     bool            `json:"builtin"`
	Private     bool            `json:"private"` // slash trigger hide_replies
	GroupID     *int64          `json:"groupId"`
	Kind        string          `json:"kind,omitempty"`      // "" = command, "event" = custom event
	EventType   string          `json:"eventType,omitempty"` // custom events: key from shared/events.json
	UpdatedAt   time.Time       `json:"updatedAt"`
	Graph       json.RawMessage `json:"graph,omitempty"`
	versions    []cmdVersion    // saved graphs, newest last (max. keepVersions)
	versionSeq  int64
}

// keepVersions is how many saved versions a command keeps.
const keepVersions = 3

type cmdVersion struct {
	ID      int64           `json:"id"`
	SavedAt time.Time       `json:"savedAt"`
	Nodes   int             `json:"nodes"`
	Graph   json.RawMessage `json:"graph,omitempty"`
}

var commandName = regexp.MustCompile(`^[a-z0-9_-]{1,32}( [a-z0-9_-]{1,32}){0,2}$`)

func starterGraph(name, description string) json.RawMessage {
	g := map[string]any{
		"schemaVersion": 1,
		"nodes": []map[string]any{
			{"id": "trigger", "type": "trigger.slash", "typeVersion": 1, "config": map[string]any{"command_name": name, "description": description}, "position": map[string]int{"x": 120, "y": 120}},
			{"id": "error", "type": "utility.error_handler", "typeVersion": 1, "config": map[string]any{"variable": "error"}, "position": map[string]int{"x": 440, "y": 120}},
		},
		"edges": []any{},
	}
	b, _ := json.Marshal(g)
	return b
}

// builtinActive reports whether an enabled built-in module command uses the
// same top-level name. A custom command may copy a built-in one, but Discord
// knows one command per name, so only one of them can be on.
func (s *store) builtinActive(botID int64, name string) bool {
	top, _, _ := strings.Cut(name, " ")
	for module, list := range s.commandCatalog {
		for _, c := range list {
			if first, _, _ := strings.Cut(c, " "); first != top {
				continue
			}
			if on, ok := s.cmdStates[strconv.FormatInt(botID, 10)+"/"+module+"/"+c]; !ok || on {
				return true
			}
		}
	}
	return false
}

// Custom events share the command code: the path decides the kind.
func kindOf(r *http.Request) string {
	if strings.Contains(r.URL.Path, "/events") {
		return "event"
	}
	return ""
}

func (s *store) listCommands(w http.ResponseWriter, r *http.Request, b *bot) {
	s.mu.Lock()
	defer s.mu.Unlock()
	items := []customCommand{}
	for _, c := range s.customCmds[b.ID] {
		if c.Kind != kindOf(r) {
			continue
		}
		cc := *c
		cc.Graph = nil // list without graphs
		items = append(items, cc)
	}
	writeJSON(w, 200, map[string]any{"items": items})
}

func (s *store) findCommand(b *bot, r *http.Request) *customCommand {
	id, _ := strconv.ParseInt(r.PathValue("cid"), 10, 64)
	for _, c := range s.customCmds[b.ID] {
		if c.ID == id && c.Kind == kindOf(r) {
			return c
		}
	}
	return nil
}

func starterEventGraph(name, eventType string) json.RawMessage {
	cfg := map[string]any{"event_name": name}
	if eventType != "" {
		cfg["event"] = eventType
	}
	g := map[string]any{
		"schemaVersion": 1,
		"nodes": []map[string]any{
			{"id": "trigger", "type": "trigger.event", "typeVersion": 1, "config": cfg, "position": map[string]int{"x": 120, "y": 120}},
			{"id": "error", "type": "utility.error_handler", "typeVersion": 1, "config": map[string]any{"variable": "error"}, "position": map[string]int{"x": 440, "y": 120}},
		},
		"edges": []any{},
	}
	b, _ := json.Marshal(g)
	return b
}

// validEvent checks an event name and type ("" = not picked yet).
func (s *store) validEvent(name, eventType string) string {
	if n := len([]rune(strings.TrimSpace(name))); n == 0 || n > 100 {
		return "error.event.name"
	}
	if eventType != "" && !s.eventTypes[eventType] {
		return "error.event.type"
	}
	return ""
}

func (s *store) getCommand(w http.ResponseWriter, r *http.Request, b *bot) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if c := s.findCommand(b, r); c != nil {
		writeJSON(w, 200, c)
		return
	}
	apiError(w, 404, "error.command.unknown")
}

func (s *store) createCommand(w http.ResponseWriter, r *http.Request, b *bot) {
	var in struct {
		Name        string `json:"name"`
		Description string `json:"description"`
		Enabled     bool   `json:"enabled"`
		EventType   string `json:"eventType"`
	}
	if !readJSON(w, r, &in) {
		return
	}
	if kindOf(r) == "event" {
		if key := s.validEvent(in.Name, in.EventType); key != "" {
			apiError(w, 422, key)
			return
		}
		s.mu.Lock()
		defer s.mu.Unlock()
		s.cmdSeq++
		c := &customCommand{ID: s.cmdSeq, Kind: "event", Name: strings.TrimSpace(in.Name), EventType: in.EventType, Enabled: in.Enabled, UpdatedAt: time.Now().UTC(), Graph: starterEventGraph(strings.TrimSpace(in.Name), in.EventType)}
		s.customCmds[b.ID] = append(s.customCmds[b.ID], c)
		writeJSON(w, 201, c)
		return
	}
	if !commandName.MatchString(in.Name) || len(in.Description) > 100 {
		apiError(w, 422, "error.command.name")
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, c := range s.customCmds[b.ID] {
		if c.Kind == "" && c.Name == in.Name {
			apiError(w, 409, "error.command.name_taken")
			return
		}
	}
	if in.Enabled && s.builtinActive(b.ID, in.Name) {
		apiError(w, 409, "error.command.name_builtin")
		return
	}
	s.cmdSeq++
	c := &customCommand{ID: s.cmdSeq, Name: in.Name, Description: in.Description, Enabled: in.Enabled, UpdatedAt: time.Now().UTC(), Graph: starterGraph(in.Name, in.Description)}
	s.customCmds[b.ID] = append(s.customCmds[b.ID], c)
	writeJSON(w, 201, c)
}

func (s *store) patchCommand(w http.ResponseWriter, r *http.Request, b *bot) {
	var in struct {
		Enabled *bool           `json:"enabled"`
		Private *bool           `json:"private"`
		GroupID json.RawMessage `json:"groupId"`
	}
	if !readJSON(w, r, &in) {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	c := s.findCommand(b, r)
	if c == nil {
		apiError(w, 404, "error.command.unknown")
		return
	}
	if in.Enabled != nil {
		if *in.Enabled && c.Kind == "" && s.builtinActive(b.ID, c.Name) {
			apiError(w, 409, "error.command.name_builtin")
			return
		}
		c.Enabled, c.UpdatedAt = *in.Enabled, time.Now().UTC()
	}
	if in.Private != nil {
		c.Private, c.UpdatedAt = *in.Private, time.Now().UTC()
	}
	if len(in.GroupID) > 0 && !s.setCommandGroup(b, c, in.GroupID) {
		apiError(w, 422, "error.group.unknown")
		return
	}
	writeJSON(w, 200, c)
}

func (s *store) deleteCommand(w http.ResponseWriter, r *http.Request, b *bot) {
	s.mu.Lock()
	defer s.mu.Unlock()
	c := s.findCommand(b, r)
	if c == nil {
		apiError(w, 404, "error.command.unknown")
		return
	}
	s.customCmds[b.ID] = slices.DeleteFunc(s.customCmds[b.ID], func(x *customCommand) bool { return x.ID == c.ID })
	// Kept 30 days under "Recently deleted".
	s.deletedCmds[b.ID] = append(s.deletedCmds[b.ID], deletedCmd{cmd: c, deletedAt: time.Now().UTC()})
	w.WriteHeader(204)
}

// saveCommand stores the graph after a basic structure check (the real API
// validates against shared/graph.schema.json and the node definitions).
func (s *store) saveCommand(w http.ResponseWriter, r *http.Request, b *bot) {
	var in struct {
		Name        string          `json:"name"`
		Description string          `json:"description"`
		Enabled     bool            `json:"enabled"`
		Graph       json.RawMessage `json:"graph"`
	}
	if !readJSON(w, r, &in) {
		return
	}
	event := kindOf(r) == "event"
	if !event && (!commandName.MatchString(in.Name) || len(in.Description) > 100) {
		apiError(w, 422, "error.command.name")
		return
	}
	var g simGraph
	if err := json.Unmarshal(in.Graph, &g); err != nil || g.SchemaVersion != 1 || len(g.Nodes) == 0 || len(g.Nodes) > 500 {
		apiError(w, 422, "error.graph.invalid")
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	c := s.findCommand(b, r)
	if c == nil {
		apiError(w, 404, "error.command.unknown")
		return
	}
	if event {
		// The event type lives on the trigger block.
		eventType := ""
		for _, n := range g.Nodes {
			if n.Type == "trigger.event" {
				eventType, _ = n.Config["event"].(string)
			}
		}
		if key := s.validEvent(in.Name, eventType); key != "" {
			apiError(w, 422, key)
			return
		}
		c.EventType = eventType
	} else {
		for _, other := range s.customCmds[b.ID] {
			if other != c && other.Kind == "" && other.Name == in.Name {
				apiError(w, 409, "error.command.name_taken")
				return
			}
		}
		if in.Enabled && s.builtinActive(b.ID, in.Name) {
			apiError(w, 409, "error.command.name_builtin")
			return
		}
	}
	c.Name, c.Description = strings.TrimSpace(in.Name), in.Description
	c.Enabled, c.Graph, c.UpdatedAt = in.Enabled, in.Graph, time.Now().UTC()
	c.versionSeq++
	c.versions = append(c.versions, cmdVersion{ID: c.versionSeq, SavedAt: c.UpdatedAt, Nodes: len(g.Nodes), Graph: in.Graph})
	if len(c.versions) > keepVersions {
		c.versions = c.versions[len(c.versions)-keepVersions:]
	}
	writeJSON(w, 200, c)
}

type simNode struct {
	ID     string         `json:"id"`
	Type   string         `json:"type"`
	Config map[string]any `json:"config"`
	Paths  bool           `json:"paths"` // success/error paths instead of "next"
}

type simGraph struct {
	SchemaVersion int       `json:"schemaVersion"`
	Nodes         []simNode `json:"nodes"`
	Edges         []struct {
		From struct{ Node, Port string } `json:"from"`
		To   struct{ Node, Port string } `json:"to"`
	} `json:"edges"`
}

// simulateCommand walks the graph like the BotCore would, without touching
// Discord: options get sample values, actions report what they would do,
// conditions pick a branch. A missing reference fails the step and continues
// at the error handler.
func (s *store) simulateCommand(w http.ResponseWriter, r *http.Request, b *bot) {
	var in struct {
		Graph simGraph `json:"graph"`
	}
	if !readJSON(w, r, &in) {
		return
	}
	g := in.Graph
	byID := map[string]simNode{}
	var start, errorHandler string
	for _, n := range g.Nodes {
		byID[n.ID] = n
		switch {
		case strings.HasPrefix(n.Type, "trigger."):
			start = n.ID
		case n.Type == "utility.error_handler":
			errorHandler = n.ID
		}
	}
	next := func(id, port string) string {
		for _, e := range g.Edges {
			if e.From.Node == id && e.From.Port == port {
				return e.To.Node
			}
		}
		return ""
	}
	vars := map[string]bool{}
	steps := []map[string]any{}
	step := func(n simNode, status, key string, params map[string]any) {
		steps = append(steps, map[string]any{"node": n.ID, "status": status, "key": key, "params": params})
	}
	cur, failed := start, false
	for i := 0; cur != "" && i < 1000; i++ {
		n := byID[cur]
		str := func(k string) string { v, _ := n.Config[k].(string); return v }
		port := "next"
		switch {
		case strings.HasPrefix(n.Type, "trigger."):
			step(n, "ok", "builder.sim.trigger", map[string]any{"user": s.user})
			// Options hang above the trigger: the member filled them in.
			for _, e := range g.Edges {
				if e.To.Node == n.ID && e.To.Port == "options" {
					if o, ok := byID[e.From.Node]; ok {
						name, _ := o.Config["name"].(string)
						v, _ := o.Config["variable"].(string)
						step(o, "ok", "builder.sim.option", map[string]any{"name": name, "var": v})
						if v != "" {
							vars[v] = true
						}
					}
				}
			}
		case n.Type == "utility.error_handler":
			step(n, "ok", "builder.sim.error_handler", nil)
		case strings.HasPrefix(n.Type, "option."):
			step(n, "ok", "builder.sim.option", map[string]any{"name": str("name"), "var": str("variable")})
		case strings.HasPrefix(n.Type, "condition."):
			// The query node checks, then one of its state nodes matches.
			if subject := str("subject"); subject != "" {
				step(n, "ok", "builder.sim.condition", map[string]any{"subject": sampleValue(subject, s.user)})
			} else {
				step(n, "ok", "builder.sim.check", nil)
			}
			state := pickState(n, g, byID, s.user)
			if state.ID == "" {
				cur = ""
				continue
			}
			if state.Type == "condition.else" {
				step(state, "ok", "builder.sim.else", nil)
			} else {
				step(state, "ok", "builder.sim.state", nil)
			}
			cur = next(state.ID, "next")
			continue
		default:
			// Actions: references must name an existing variable or a placeholder.
			for _, k := range []string{"message", "user", "role", "channel"} {
				ref := str(k)
				if ref == "" {
					continue
				}
				if !strings.Contains(ref, "{") && !vars[ref] {
					step(n, "error", "builder.sim.unknown_var", map[string]any{"name": ref})
					failed = true
				}
			}
			if !failed {
				step(n, "ok", "builder.sim.action", nil)
			}
		}
		if v := str("variable"); v != "" {
			vars[v] = true
		}
		if failed {
			cur, failed = errorHandler, false
			if cur == "" {
				break
			}
			continue
		}
		if port == "next" && n.Paths {
			port = "success"
		}
		cur = next(cur, port)
	}
	writeJSON(w, 200, map[string]any{"steps": steps})
}

// statesOf returns the state nodes of a condition in edge order.
func statesOf(cond simNode, g simGraph, byID map[string]simNode) (states []simNode, elseNode simNode) {
	for _, e := range g.Edges {
		if e.From.Node != cond.ID || e.From.Port != "branches" {
			continue
		}
		if st, ok := byID[e.To.Node]; ok {
			if st.Type == "condition.else" {
				elseNode = st
			} else {
				states = append(states, st)
			}
		}
	}
	return states, elseNode
}

// pickState decides which state of a condition matches. Chance rolls against
// the summed percentages, compare evaluates the operator against a sample
// subject, match picks a random state (the mock has no real Discord data).
func pickState(cond simNode, g simGraph, byID map[string]simNode, user string) simNode {
	states, elseNode := statesOf(cond, g, byID)
	str := func(n simNode, k string) string { v, _ := n.Config[k].(string); return v }
	switch conditionKinds[cond.Type] {
	case "chance":
		roll, sum := rand.Float64()*100, 0.0
		for _, st := range states {
			p, _ := st.Config["percent"].(float64)
			if sum += p; roll < sum {
				return st
			}
		}
	case "compare":
		subject := sampleValue(str(cond, "subject"), user)
		for _, st := range states {
			if compare(subject, str(st, "operator"), sampleValue(str(st, "value"), user)) {
				return st
			}
		}
	default:
		if i := rand.Intn(len(states) + 1); i < len(states) {
			return states[i]
		}
	}
	return elseNode
}

var conditionKinds = map[string]string{
	"condition.chance": "chance", "condition.comparison": "compare", "condition.if": "compare",
}

// sampleValue fills placeholders with sample data for the simulation.
func sampleValue(v, user string) string {
	return strings.NewReplacer("{user}", user, "{user.id}", "100000000000000001", "{user.mention}", "@"+user,
		"{server}", "Test Server", "{server.id}", "200000000000000002", "{channel}", "general", "{members}", "42").Replace(v)
}

func compare(a, op, b string) bool {
	x, errA := strconv.ParseFloat(a, 64)
	y, errB := strconv.ParseFloat(b, 64)
	numeric := errA == nil && errB == nil
	la, lb := strings.ToLower(a), strings.ToLower(b)
	inList := func() bool {
		for _, item := range strings.Split(la, ",") {
			if strings.TrimSpace(item) == lb {
				return true
			}
		}
		return false
	}
	switch op {
	case "", "eq", "==":
		return a == b
	case "ne", "!=":
		return a != b
	case "gt", ">", "after":
		return numeric && x > y || !numeric && op == "after" && a > b
	case "lt", "<", "before":
		return numeric && x < y || !numeric && op == "before" && a < b
	case "gte", ">=":
		return numeric && x >= y
	case "lte", "<=":
		return numeric && x <= y
	case "contains":
		return strings.Contains(la, lb)
	case "not_contains":
		return !strings.Contains(la, lb)
	case "starts_with":
		return strings.HasPrefix(la, lb)
	case "not_starts_with":
		return !strings.HasPrefix(la, lb)
	case "ends_with":
		return strings.HasSuffix(la, lb)
	case "not_ends_with":
		return !strings.HasSuffix(la, lb)
	case "in":
		return inList()
	case "not_in":
		return !inList()
	}
	return false
}

// listVersions returns the saved versions of a command, newest first.
func (s *store) listVersions(w http.ResponseWriter, r *http.Request, b *bot) {
	s.mu.Lock()
	defer s.mu.Unlock()
	c := s.findCommand(b, r)
	if c == nil {
		apiError(w, 404, "error.command.unknown")
		return
	}
	items := []cmdVersion{}
	for i := len(c.versions) - 1; i >= 0; i-- {
		v := c.versions[i]
		v.Graph = nil
		items = append(items, v)
	}
	writeJSON(w, 200, map[string]any{"items": items})
}

func (s *store) getVersion(w http.ResponseWriter, r *http.Request, b *bot) {
	id, _ := strconv.ParseInt(r.PathValue("vid"), 10, 64)
	s.mu.Lock()
	defer s.mu.Unlock()
	c := s.findCommand(b, r)
	if c == nil {
		apiError(w, 404, "error.command.unknown")
		return
	}
	for _, v := range c.versions {
		if v.ID == id {
			writeJSON(w, 200, v)
			return
		}
	}
	apiError(w, 404, "error.version.unknown")
}
