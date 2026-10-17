package web

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/Kljub/BothubV3/dashboard/internal/api"
)

// Sharing commands and events: the command hub exports the picked commands
// (or events) as one file and imports such a file into any bot. Imported
// entries start disabled, so IDs of roles, channels and users from the
// other server can be fixed before they run. A whole bot (settings,
// modules, every command) is the bot backup instead.

const (
	shareFormat   = "bothub.commands"
	shareVersion  = 1
	shareMaxItems = 100
	shareMaxBytes = 4 << 20
)

// shareFile is the exported file.
type shareFile struct {
	Format     string      `json:"format"`
	Version    int         `json:"version"`
	Kind       api.Kind    `json:"kind"`
	ExportedAt time.Time   `json:"exportedAt"`
	Items      []shareItem `json:"items"`
}

type shareItem struct {
	Name        string          `json:"name"`
	Description string          `json:"description"`
	EventType   string          `json:"eventType,omitempty"`
	Graph       json.RawMessage `json:"graph"`
}

var shareCommandName = regexp.MustCompile(`^[a-z0-9_-]{1,32}( [a-z0-9_-]{1,32}){0,2}$`)

// exportView: the export dialog (commands of this hub to pick).
type exportView struct {
	Hub      hub
	BotID    int64
	Commands []api.CustomCommand
}

// handleCommandExport: without ids the dialog body, with ids the file.
func (s *Server) handleCommandExport(w http.ResponseWriter, r *http.Request, p Page) {
	botID, ok := s.botID(w, r, p)
	if !ok {
		return
	}
	h := hubOf(r)
	all, err := s.api.CustomCommands(r.Context(), session(r), h.Kind, botID)
	if err != nil {
		s.fail(w, r, p, err)
		return
	}
	cmds := make([]api.CustomCommand, 0, len(all))
	for _, c := range all {
		if !c.Hidden && !c.Copy {
			cmds = append(cmds, c)
		}
	}
	slices.SortFunc(cmds, func(a, b api.CustomCommand) int { return strings.Compare(a.Name, b.Name) })
	_ = r.ParseForm()
	ids := r.Form["ids"]
	if len(ids) == 0 {
		s.render(w, http.StatusOK, "module_item", "cmd_export_fragment", withData(p, exportView{Hub: h, BotID: botID, Commands: cmds}))
		return
	}
	file := shareFile{Format: shareFormat, Version: shareVersion, Kind: h.Kind, ExportedAt: time.Now().UTC()}
	for _, raw := range ids {
		id, _ := strconv.ParseInt(raw, 10, 64)
		if !slices.ContainsFunc(cmds, func(c api.CustomCommand) bool { return c.ID == id }) {
			continue
		}
		c, err := s.api.CustomCommand(r.Context(), session(r), h.Kind, botID, id)
		if err != nil {
			s.fail(w, r, p, err)
			return
		}
		file.Items = append(file.Items, shareItem{Name: c.Name, Description: c.Description, EventType: c.EventType, Graph: c.Graph})
	}
	if len(file.Items) == 0 {
		http.Error(w, "nothing to export", http.StatusBadRequest)
		return
	}
	name := string(h.Kind) + "-" + time.Now().UTC().Format("2006-01-02")
	if len(file.Items) == 1 {
		name = fileSafe(file.Items[0].Name)
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Content-Disposition", fmt.Sprintf(`attachment; filename="%s.bothub.json"`, name))
	enc := json.NewEncoder(w)
	enc.SetIndent("", "  ")
	_ = enc.Encode(file)
}

var unsafeFileChars = regexp.MustCompile(`[^A-Za-z0-9_-]+`)

func fileSafe(name string) string {
	out := strings.Trim(unsafeFileChars.ReplaceAllString(name, "-"), "-")
	if out == "" {
		return "command"
	}
	return out
}

// parseShareFile reads and checks an uploaded file for this hub.
func parseShareFile(data []byte, kind api.Kind) (shareFile, error) {
	var f shareFile
	if err := json.Unmarshal(data, &f); err != nil || f.Format != shareFormat {
		return f, errors.New("cmdshare.import.bad_file")
	}
	if f.Version > shareVersion {
		return f, errors.New("cmdshare.import.newer")
	}
	if f.Kind != kind {
		return f, errors.New("cmdshare.import.wrong_kind")
	}
	if len(f.Items) == 0 || len(f.Items) > shareMaxItems {
		return f, errors.New("cmdshare.import.count")
	}
	return f, nil
}

// withCommandName puts name into the slash trigger of a graph (the name of
// an imported command can change when it is taken).
func withCommandName(graph json.RawMessage, name string) json.RawMessage {
	var g map[string]any
	if json.Unmarshal(graph, &g) != nil {
		return graph
	}
	nodes, _ := g["nodes"].([]any)
	for _, n := range nodes {
		node, _ := n.(map[string]any)
		if node == nil || node["type"] != "trigger.slash" {
			continue
		}
		cfg, _ := node["config"].(map[string]any)
		if cfg == nil {
			cfg = map[string]any{}
			node["config"] = cfg
		}
		cfg["command_name"] = name
	}
	out, err := json.Marshal(g)
	if err != nil {
		return graph
	}
	return out
}

// importName: the name, or with -2 … -9 when it is taken already.
func importName(name string, try int) string {
	if try == 0 {
		return name
	}
	suffix := "-" + strconv.Itoa(try+1)
	parts := strings.Split(name, " ")
	last := parts[len(parts)-1]
	if len(last)+len(suffix) > 32 {
		last = last[:32-len(suffix)]
	}
	parts[len(parts)-1] = last + suffix
	return strings.Join(parts, " ")
}

type importResult struct {
	Imported []string
	Failed   []importFailure
}

type importFailure struct {
	Name string
	Key  string
}

func (s *Server) handleCommandImport(w http.ResponseWriter, r *http.Request, p Page) {
	botID, ok := s.botID(w, r, p)
	if !ok {
		return
	}
	h := hubOf(r)
	r.Body = http.MaxBytesReader(w, r.Body, shareMaxBytes+64<<10)
	fail := func(key string) {
		s.render(w, http.StatusOK, "module_item", "cmd_import_result", withData(p, importResult{Failed: []importFailure{{Key: key}}}))
	}
	file, _, err := r.FormFile("file")
	if err != nil {
		fail("cmdshare.import.no_file")
		return
	}
	defer file.Close()
	data, err := io.ReadAll(io.LimitReader(file, shareMaxBytes+1))
	if err != nil || len(data) > shareMaxBytes {
		fail("cmdshare.import.too_big")
		return
	}
	f, err := parseShareFile(data, h.Kind)
	if err != nil {
		fail(err.Error())
		return
	}
	existing, err := s.api.CustomCommands(r.Context(), session(r), h.Kind, botID)
	if err != nil {
		s.fail(w, r, p, err)
		return
	}
	taken := map[string]bool{}
	for _, c := range existing {
		taken[c.Name] = true
	}
	var res importResult
	for _, it := range f.Items {
		name := strings.TrimSpace(it.Name)
		if h.Kind == api.KindCommand && !shareCommandName.MatchString(name) {
			res.Failed = append(res.Failed, importFailure{Name: name, Key: "error.command.name"})
			continue
		}
		var created api.CustomCommand
		var cerr error
		final := name
		for try := 0; try < 9; try++ {
			final = importName(name, try)
			if h.Kind == api.KindCommand && taken[final] {
				continue
			}
			if h.Kind == api.KindEvent {
				created, cerr = s.api.CreateCustomEvent(r.Context(), session(r), botID, final)
			} else {
				created, cerr = s.api.CreateCustomCommand(r.Context(), session(r), botID, final, it.Description)
			}
			var ae *api.Error
			if cerr != nil && errors.As(cerr, &ae) && ae.Key == "error.command.name_taken" {
				taken[final] = true
				continue
			}
			break
		}
		if cerr != nil {
			res.Failed = append(res.Failed, importFailure{Name: name, Key: api.AsError(cerr).Key})
			continue
		}
		taken[final] = true
		graph := it.Graph
		if h.Kind == api.KindCommand {
			graph = withCommandName(graph, final)
		}
		// Disabled: IDs from the other server are checked first.
		if _, err := s.api.SaveCustomCommand(r.Context(), session(r), h.Kind, botID, created.ID, final, it.Description, false, graph); err != nil {
			_ = s.api.DeleteCustomCommand(r.Context(), session(r), h.Kind, botID, created.ID)
			res.Failed = append(res.Failed, importFailure{Name: name, Key: api.AsError(err).Key})
			continue
		}
		res.Imported = append(res.Imported, final)
	}
	if len(res.Imported) > 0 {
		w.Header().Set("HX-Trigger", "bothub:commands-changed")
	}
	s.render(w, http.StatusOK, "module_item", "cmd_import_result", withData(p, res))
}
