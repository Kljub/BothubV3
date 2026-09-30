package web

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"sync"

	"github.com/Kljub/BothubV3/dashboard/internal/api"
)

// Settings pages of the ready-made modules, generated from
// shared/module-settings/<module>.json (format: README.md there). The API
// validates and stores the config; this file turns the schema into a form
// and the form back into the config JSON.

type settingsField struct {
	Key          string              `json:"key"`
	Type         string              `json:"type"`
	Default      json.RawMessage     `json:"default"`
	Options      []string            `json:"options"`
	Min          *int                `json:"min"`
	Max          *int                `json:"max"`
	Multiline    bool                `json:"multiline"`
	ChannelTypes []string            `json:"channelTypes"`
	ShowIf       map[string][]string `json:"showIf"`
	Item         []settingsField     `json:"item"`
	TitleField   string              `json:"titleField"`
	Pattern      string              `json:"pattern"`
	Hint         bool                `json:"hint"`
}

type settingsSchema struct {
	Module string          `json:"module"`
	Fields []settingsField `json:"fields"`
}

var (
	schemaOnce sync.Once
	schemas    map[string]settingsSchema
)

// moduleSchema returns the settings schema of a module, if it has one.
func moduleSchema(key string) (settingsSchema, bool) {
	schemaOnce.Do(func() {
		shared := os.Getenv("SHARED_DIR")
		if shared == "" {
			shared = "/shared"
		}
		schemas = loadSchemaDir(filepath.Join(shared, "module-settings"))
	})
	sc, ok := schemas[key]
	return sc, ok
}

func loadSchemaDir(dir string) map[string]settingsSchema {
	out := map[string]settingsSchema{}
	files, _ := filepath.Glob(filepath.Join(dir, "*.json"))
	for _, f := range files {
		raw, err := os.ReadFile(f)
		if err != nil {
			continue
		}
		var sc settingsSchema
		if json.Unmarshal(raw, &sc) == nil && sc.Module != "" {
			out[sc.Module] = sc
		}
	}
	return out
}

// --- view ---

type settingsGuild struct {
	ID, Name string
	Channels []api.GuildChannel
	Roles    []api.GuildRole
}

type settingsView struct {
	BotID  int64
	Module string
	Guilds []settingsGuild
	Top    []fieldView        // fields outside lists
	Lists  []settingsListView // one section per list field
	Values map[string]any     // for showIf of top-level fields
}

type settingsListView struct {
	Field fieldView
	Items []settingsItemView
	New   []fieldView
	Full  bool
}

type settingsItemView struct {
	Index  int
	Title  string
	Fields []fieldView
}

// fieldView is one form field with its current value.
type fieldView struct {
	settingsField
	Label, Name string // i18n key prefix, form name
	Value       any
	Selected    map[string]bool // channel(s)/role(s): "guild:id"
	Text        string          // words/emojis joined, color, text
	Message     map[string]string
	ShowIfJSON  string
	View        *settingsView
}

func refKey(v any) string {
	m, ok := v.(map[string]any)
	if !ok {
		return ""
	}
	g, _ := m["guild"].(string)
	id, _ := m["id"].(string)
	return g + ":" + id
}

func (s *Server) buildFields(v *settingsView, module, prefix string, fields []settingsField, values map[string]any) []fieldView {
	out := make([]fieldView, 0, len(fields))
	for _, f := range fields {
		if f.Type == "list" && prefix == "" {
			continue
		}
		fv := fieldView{settingsField: f, Label: "modset." + module + "." + prefix + f.Key, Name: f.Key, Value: values[f.Key], Selected: map[string]bool{}, View: v}
		if len(f.ShowIf) > 0 {
			b, _ := json.Marshal(f.ShowIf)
			fv.ShowIfJSON = string(b)
		}
		switch f.Type {
		case "channel", "role":
			if k := refKey(values[f.Key]); k != ":" && k != "" {
				fv.Selected[k] = true
			}
		case "channels", "roles":
			list, _ := values[f.Key].([]any)
			for _, r := range list {
				fv.Selected[refKey(r)] = true
			}
		case "words", "emojis":
			list, _ := values[f.Key].([]any)
			parts := make([]string, 0, len(list))
			for _, w := range list {
				if s, ok := w.(string); ok {
					parts = append(parts, s)
				}
			}
			sep := "\n"
			if f.Type == "emojis" {
				sep = " "
			}
			fv.Text = strings.Join(parts, sep)
		case "message":
			fv.Message = map[string]string{}
			m, _ := values[f.Key].(map[string]any)
			for _, k := range []string{"mode", "content", "title", "description", "color", "image", "footer"} {
				fv.Message[k], _ = m[k].(string)
			}
			if fv.Message["mode"] == "" {
				fv.Message["mode"] = "text"
			}
		default:
			if s, ok := values[f.Key].(string); ok {
				fv.Text = s
			}
		}
		out = append(out, fv)
	}
	return out
}

// defaults of a list item: the API fills them when the list is empty, so
// ask the schema for them via an empty item round trip is not needed; the
// form simply starts with the schema defaults.
func itemDefaults(fields []settingsField) map[string]any {
	out := map[string]any{}
	for _, f := range fields {
		if len(f.Default) > 0 {
			var v any
			if json.Unmarshal(f.Default, &v) == nil {
				out[f.Key] = v
			}
		}
	}
	return out
}

func (s *Server) settingsData(r *http.Request, botID int64, sc settingsSchema) (settingsView, error) {
	var cfg map[string]any
	if err := s.api.ModuleConfigRaw(r.Context(), session(r), botID, sc.Module, &cfg); err != nil {
		return settingsView{}, err
	}
	v := settingsView{BotID: botID, Module: sc.Module, Values: cfg}
	needGuild := false
	var walk func([]settingsField)
	walk = func(fs []settingsField) {
		for _, f := range fs {
			switch f.Type {
			case "channel", "channels", "role", "roles":
				needGuild = true
			case "list":
				walk(f.Item)
			}
		}
	}
	walk(sc.Fields)
	if needGuild {
		// Without a running bot there are no servers; the page still works.
		guilds, _ := s.api.ListGuilds(r.Context(), session(r), botID)
		for _, g := range guilds {
			sg := settingsGuild{ID: g.ID, Name: g.Name}
			sg.Channels, _ = s.api.GuildChannels(r.Context(), session(r), botID, g.ID)
			sg.Roles, _ = s.api.GuildRoles(r.Context(), session(r), botID, g.ID)
			v.Guilds = append(v.Guilds, sg)
		}
	}
	v.Top = s.buildFields(&v, sc.Module, "", sc.Fields, cfg)
	for _, f := range sc.Fields {
		if f.Type != "list" {
			continue
		}
		lv := settingsListView{Field: fieldView{settingsField: f, Label: "modset." + sc.Module + "." + f.Key}}
		items, _ := cfg[f.Key].([]any)
		for i, it := range items {
			m, _ := it.(map[string]any)
			iv := settingsItemView{Index: i, Fields: s.buildFields(&v, sc.Module, f.Key+".", f.Item, m)}
			iv.Title = s.itemTitle(v, f, m, i)
			lv.Items = append(lv.Items, iv)
		}
		lv.New = s.buildFields(&v, sc.Module, f.Key+".", f.Item, itemDefaults(f.Item))
		lv.Full = f.Max != nil && len(items) >= *f.Max
		v.Lists = append(v.Lists, lv)
	}
	return v, nil
}

// itemTitle names a list entry by its titleField (channel name, keywords …).
func (s *Server) itemTitle(v settingsView, f settingsField, m map[string]any, i int) string {
	val := m[f.TitleField]
	switch x := val.(type) {
	case []any:
		parts := []string{}
		for _, w := range x {
			if s, ok := w.(string); ok {
				parts = append(parts, s)
			}
		}
		if len(parts) > 0 {
			t := strings.Join(parts, ", ")
			if len(t) > 80 {
				t = t[:77] + "…"
			}
			return t
		}
	case map[string]any:
		key := refKey(x)
		for _, g := range v.Guilds {
			for _, c := range g.Channels {
				if g.ID+":"+c.ID == key {
					return "#" + c.Name
				}
			}
		}
		if id, _ := x["id"].(string); id != "" {
			return "#" + id
		}
	case string:
		if x != "" {
			return x
		}
	}
	return "#" + strconv.Itoa(i+1)
}

// ChannelOK reports whether a channel type fits the field.
func (f fieldView) ChannelOK(t string) bool {
	return len(f.ChannelTypes) == 0 || slices.Contains(f.ChannelTypes, t)
}

// --- form -> config ---

func parseRef(v string) any {
	g, id, ok := strings.Cut(v, ":")
	if !ok || g == "" || id == "" {
		return nil
	}
	return map[string]string{"guild": g, "id": id}
}

func splitList(v string, emojis bool) []string {
	sep := func(r rune) bool { return r == '\n' || r == '\r' }
	if emojis {
		sep = func(r rune) bool { return r == '\n' || r == '\r' || r == ' ' || r == ',' }
	}
	out := []string{}
	for _, p := range strings.FieldsFunc(v, sep) {
		if p = strings.TrimSpace(p); p != "" {
			out = append(out, p)
		}
	}
	return out
}

// formValues reads the fields of one form into config values.
func formValues(fields []settingsField, form url.Values) map[string]any {
	out := map[string]any{}
	for _, f := range fields {
		k := f.Key
		switch f.Type {
		case "list":
			continue
		case "bool":
			out[k] = form.Get(k) == "true"
		case "number":
			if n, err := strconv.Atoi(strings.TrimSpace(form.Get(k))); err == nil {
				out[k] = n
			}
		case "channel", "role":
			out[k] = parseRef(form.Get(k))
		case "channels", "roles":
			refs := []any{}
			for _, v := range form[k] {
				if ref := parseRef(v); ref != nil {
					refs = append(refs, ref)
				}
			}
			out[k] = refs
		case "words":
			out[k] = splitList(form.Get(k), false)
		case "emojis":
			out[k] = splitList(form.Get(k), true)
		case "message":
			m := map[string]string{}
			for _, part := range []string{"mode", "content", "title", "description", "color", "image", "footer"} {
				m[part] = strings.TrimSpace(form.Get(k + "." + part))
			}
			if m["mode"] != "embed" {
				m["mode"] = "text"
			}
			out[k] = m
		default:
			out[k] = form.Get(k)
		}
	}
	return out
}

// --- handlers ---

func (s *Server) settingsTarget(w http.ResponseWriter, r *http.Request, p Page) (int64, settingsSchema, map[string]any, bool) {
	id, ok := s.botID(w, r, p)
	if !ok {
		return 0, settingsSchema{}, nil, false
	}
	sc, found := moduleSchema(r.PathValue("key"))
	if !found {
		s.fail(w, r, p, &api.Error{Status: http.StatusNotFound, Key: "error.module.no_settings"})
		return 0, settingsSchema{}, nil, false
	}
	var cfg map[string]any
	if err := s.api.ModuleConfigRaw(r.Context(), session(r), id, sc.Module, &cfg); err != nil {
		s.failTo(w, r, p, err, "#modset-error")
		return 0, settingsSchema{}, nil, false
	}
	_ = r.ParseForm()
	return id, sc, cfg, true
}

func (s *Server) saveSettings(w http.ResponseWriter, r *http.Request, p Page, id int64, sc settingsSchema, cfg map[string]any) {
	var out map[string]any
	if err := s.api.SetModuleConfigRaw(r.Context(), session(r), id, sc.Module, cfg, &out); err != nil {
		s.failTo(w, r, p, err, "#modset-error")
		return
	}
	v, err := s.settingsData(r, id, sc)
	if err != nil {
		s.failTo(w, r, p, err, "#modset-error")
		return
	}
	w.Header().Set("HX-Trigger", "bothub:saved")
	s.render(w, http.StatusOK, "module_item", "module_settings_fragment", withData(p, v))
}

func listField(sc settingsSchema, key string) (settingsField, bool) {
	for _, f := range sc.Fields {
		if f.Type == "list" && f.Key == key {
			return f, true
		}
	}
	return settingsField{}, false
}

// handleSettingsSave stores the fields outside lists.
func (s *Server) handleSettingsSave(w http.ResponseWriter, r *http.Request, p Page) {
	id, sc, cfg, ok := s.settingsTarget(w, r, p)
	if !ok {
		return
	}
	for k, v := range formValues(sc.Fields, r.PostForm) {
		cfg[k] = v
	}
	s.saveSettings(w, r, p, id, sc, cfg)
}

// handleSettingsItem adds (POST), replaces (PUT) or removes (DELETE) one
// entry of a list field.
func (s *Server) handleSettingsItem(w http.ResponseWriter, r *http.Request, p Page) {
	id, sc, cfg, ok := s.settingsTarget(w, r, p)
	if !ok {
		return
	}
	lf, found := listField(sc, r.PathValue("list"))
	if !found {
		s.fail(w, r, p, &api.Error{Status: http.StatusNotFound, Key: "error.not_found"})
		return
	}
	items, _ := cfg[lf.Key].([]any)
	idx := -1
	if raw := r.PathValue("idx"); raw != "" {
		n, err := strconv.Atoi(raw)
		if err != nil || n < 0 || n >= len(items) {
			s.failTo(w, r, p, &api.Error{Status: http.StatusNotFound, Key: "error.not_found"}, "#modset-error")
			return
		}
		idx = n
	}
	switch r.Method {
	case http.MethodPost:
		items = append(items, formValues(lf.Item, r.PostForm))
	case http.MethodPut:
		items[idx] = formValues(lf.Item, r.PostForm)
	case http.MethodDelete:
		items = slices.Delete(items, idx, idx+1)
	}
	cfg[lf.Key] = items
	s.saveSettings(w, r, p, id, sc, cfg)
}

// URL is the form target of a list entry ("" = top-level fields, idx -1 =
// new entry).
func (v settingsView) URL(list string, idx int) string {
	base := fmt.Sprintf("/bot/%d/modules/%s/settings", v.BotID, v.Module)
	if list == "" {
		return base
	}
	if idx < 0 {
		return base + "/" + list
	}
	return fmt.Sprintf("%s/%s/%d", base, list, idx)
}
