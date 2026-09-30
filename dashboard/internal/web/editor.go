package web

import (
	"encoding/json"
	"fmt"
	"html/template"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// Node editor (command builder, later also timed and custom events). The page
// is a full-screen app: builder.js reads its data from JSON islands.

// LoadNodeDefs reads every shared/nodes/*.json as raw JSON for the editor.
func LoadNodeDefs(dir string) ([]json.RawMessage, error) {
	files, err := filepath.Glob(filepath.Join(dir, "*.json"))
	if err != nil {
		return nil, err
	}
	sort.Strings(files)
	defs := make([]json.RawMessage, 0, len(files))
	for _, f := range files {
		raw, err := os.ReadFile(f)
		if err != nil {
			return nil, fmt.Errorf("read node definition: %w", err)
		}
		if !json.Valid(raw) {
			return nil, fmt.Errorf("node definition %s: invalid JSON", filepath.Base(f))
		}
		defs = append(defs, raw)
	}
	return defs, nil
}

// jsonIsland marshals v for <script type="application/json">; json.Marshal
// escapes <, > and &, so the data cannot close the script element.
func jsonIsland(v any) template.JS {
	b, err := json.Marshal(v)
	if err != nil {
		return "null"
	}
	return template.JS(b)
}

// editorTexts returns all builder.* translations for the editor script.
func (s *Server) editorTexts(locale string) map[string]string {
	out := map[string]string{}
	for _, k := range s.i18n.Keys("en") {
		if strings.HasPrefix(k, "builder.") || strings.HasPrefix(k, "vars.") || strings.HasPrefix(k, "data.shape.") || strings.HasPrefix(k, "action.") || strings.HasPrefix(k, "error.command.") || strings.HasPrefix(k, "error.graph.") || strings.HasPrefix(k, "error.template.") || strings.HasPrefix(k, "error.auth.") || strings.HasPrefix(k, "error.api.") || strings.HasPrefix(k, "error.csrf.") {
			out[k] = s.i18n.T(locale, k)
		}
	}
	return out
}
