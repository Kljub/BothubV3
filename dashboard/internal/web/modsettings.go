package web

import (
	"encoding/json"
	"errors"
	"fmt"
	"html/template"
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
	Required     bool                `json:"required"`
	// Drop: a list whose entries can be made by dropping image files on it;
	// File is the image field of an entry, Name the text field that gets the
	// file name (without extension).
	Drop *struct {
		File string `json:"file"`
		Name string `json:"name"`
	} `json:"drop"`
	// permissions: which lists of the block the field shows (default all
	// four: allowed_roles, banned_roles, required_permissions, banned_channels).
	Lists []string `json:"lists"`
	// permissions: a group of members (who is exempt, …) instead of access:
	// no @everyone, no open/restricted badge, no value is nobody.
	Group bool `json:"group"`
	// Vars: the placeholders the bot fills in this text or message field
	// (the variable picker shows exactly these).
	Vars []string `json:"vars"`
	// Dynamic: a "choices" field whose options the plugin sets (ctx.config.setOptions).
	Dynamic bool `json:"dynamic"`
	// Accept: what a "file" field takes ("audio").
	Accept string `json:"accept"`
}

// Limit is the shown maximum of a list: 0 when it has none ("max": 0).
func (f settingsField) Limit() int {
	if f.Max == nil {
		return 0
	}
	return *f.Max
}

type settingsSchema struct {
	Module string          `json:"module"`
	Fields []settingsField `json:"fields"`
	// Integration: key of an integration (Admin → API / Secrets) the module
	// uses; the page warns while its client ID or secret is missing.
	// IntegrationOptional: the module also works without it (a tip only).
	Integration         string `json:"integration"`
	IntegrationOptional bool   `json:"integrationOptional"`
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
	IconURL  string
	Channels []api.GuildChannel
	Roles    []api.GuildRole
}

// settingsScope says where one settings form lives: a module
// (bot_modules.config) or a plugin (plugin_settings). The form, the parsing
// and the list handling are the same for both.
type settingsScope struct {
	Schema      settingsSchema
	LabelPrefix string // i18n key prefix of the labels, ends with "."
	URLBase     string // form target of the top-level fields
	FileBase    string // plugins: upload and preview URL of "image" fields
	load        func(r *http.Request) (map[string]any, error)
	save        func(r *http.Request, cfg map[string]any) error
	// options: options of dynamic "choices" fields (plugins), field => options.
	options func(r *http.Request) map[string][]api.ChoiceOption
}

// moduleScope is the settings form of a ready-made module.
func (s *Server) moduleScope(botID int64, sc settingsSchema) settingsScope {
	return settingsScope{
		Schema:      sc,
		LabelPrefix: "modset." + sc.Module + ".",
		URLBase:     fmt.Sprintf("/bot/%d/modules/%s/settings", botID, sc.Module),
		load: func(r *http.Request) (map[string]any, error) {
			var cfg map[string]any
			err := s.api.ModuleConfigRaw(r.Context(), session(r), botID, sc.Module, &cfg)
			return cfg, err
		},
		save: func(r *http.Request, cfg map[string]any) error {
			var out map[string]any
			return s.api.SetModuleConfigRaw(r.Context(), session(r), botID, sc.Module, cfg, &out)
		},
	}
}

type settingsView struct {
	// Picker: servers with roles and channels plus the permission groups,
	// for the role/channel pickers and the permissions block (permissions.js).
	Picker template.JS
	BotID  int64
	Module string
	Base   string // settingsScope.URLBase
	Files  string // settingsScope.FileBase
	Guilds []settingsGuild
	Top    []fieldView        // fields outside lists
	Lists  []settingsListView // one section per list field
	Values map[string]any     // for showIf of top-level fields
	// Options of dynamic "choices" fields, by field key.
	Options map[string][]api.ChoiceOption
	// Currencies: the bot's Economy currencies for "currency" fields (key, label).
	Currencies []api.ChoiceOption
	// Cards: the bot's cards (Card Designer) for "card" fields (ID, name).
	Cards []api.ChoiceOption
	// Integration: set while the module's integration is not set up.
	Integration *integrationNotice
}

type integrationNotice struct {
	Name     string
	Optional bool
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
	// Thumb: preview of the entry's first image field, if it has one.
	Thumb string
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
	// permissions: the block's value and the lists it shows, as JSON for permissions.js.
	PermJSON, PermLists string
	// image: upload URL and preview of the stored file.
	UploadURL, ImageURL string
	// choices: every option with its pick state.
	Choices []choiceItem
	// Currencies: options of a "currency" field (the bot's Economy currencies).
	Currencies []api.ChoiceOption
}

// choiceItem is one option of a "choices" field. Static options are i18n
// keys (Key), dynamic ones come with their label from the plugin.
type choiceItem struct {
	Value, Label, Key string
	Picked            bool
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

func (s *Server) buildFields(v *settingsView, labels, prefix string, fields []settingsField, values map[string]any) []fieldView {
	out := make([]fieldView, 0, len(fields))
	for _, f := range fields {
		if f.Type == "list" && prefix == "" {
			continue
		}
		fv := fieldView{settingsField: f, Label: labels + prefix + f.Key, Name: f.Key, Value: values[f.Key], Selected: map[string]bool{}, View: v}

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
		case "permissions":
			val := values[f.Key]
			if val == nil && len(f.Default) > 0 {
				_ = json.Unmarshal(f.Default, &val)
			}
			if val == nil && f.Group {
				val = map[string]any{}
			}
			if val == nil {
				val = map[string]any{"allowed_roles": []any{map[string]any{"id": "everyone"}}}
			}
			b, _ := json.Marshal(val)
			fv.PermJSON = string(b)
			lists, _ := json.Marshal(f.Lists)
			fv.PermLists = string(lists)
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
		case "choices":
			fv.Choices = choiceItems(f, labels+prefix+f.Key, values[f.Key], v.Options[f.Key])
		case "currency":
			fv.Text, _ = values[f.Key].(string)
			fv.Currencies = v.Currencies
		case "card":
			fv.Text, _ = values[f.Key].(string)
		case "image", "file":
			fv.Text, _ = values[f.Key].(string)
			fv.UploadURL = v.Files
			if fv.Text != "" && v.Files != "" {
				fv.ImageURL = v.Files + "/" + fv.Text
			}
		case "message":
			fv.Message = map[string]string{}
			m, _ := values[f.Key].(map[string]any)
			if text, ok := values[f.Key].(string); ok {
				m = map[string]any{"mode": "text", "content": text} // older plain-text value
			}
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
	return s.scopeData(r, botID, s.moduleScope(botID, sc))
}

func (s *Server) scopeData(r *http.Request, botID int64, scope settingsScope) (settingsView, error) {
	sc := scope.Schema
	cfg, err := scope.load(r)
	if err != nil {
		return settingsView{}, err
	}
	v := settingsView{BotID: botID, Module: sc.Module, Base: scope.URLBase, Files: scope.FileBase, Values: cfg}
	if scope.options != nil && hasDynamic(sc.Fields) {
		v.Options = scope.options(r)
	}
	if hasType(sc.Fields, "currency") {
		v.Currencies = s.currencyOptions(r, botID)
	}
	if hasType(sc.Fields, "card") {
		v.Cards = s.cardOptions(r, botID)
	}
	needGuild := false
	var walk func([]settingsField)
	walk = func(fs []settingsField) {
		for _, f := range fs {
			switch f.Type {
			case "channel", "channels", "role", "roles", "permissions":
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
			if g.IconURL != nil {
				sg.IconURL = *g.IconURL
			}
			sg.Channels, _ = s.api.GuildChannels(r.Context(), session(r), botID, g.ID)
			sg.Roles, _ = s.api.GuildRoles(r.Context(), session(r), botID, g.ID)
			v.Guilds = append(v.Guilds, sg)
		}
		v.Picker = s.pickerData(v.Guilds)
	}
	if sc.Integration != "" {
		v.Integration = s.integrationNotice(r, sc)
	}
	v.Top = s.buildFields(&v, scope.LabelPrefix, "", sc.Fields, cfg)
	for _, f := range sc.Fields {
		if f.Type != "list" {
			continue
		}
		lv := settingsListView{Field: fieldView{settingsField: f, Label: scope.LabelPrefix + f.Key}}
		items, _ := cfg[f.Key].([]any)
		for i, it := range items {
			m, _ := it.(map[string]any)
			iv := settingsItemView{Index: i, Fields: s.buildFields(&v, scope.LabelPrefix, f.Key+".", f.Item, m)}
			iv.Title = s.itemTitle(v, f, m, i)
			for _, fv := range iv.Fields {
				if fv.Type == "image" && fv.ImageURL != "" {
					iv.Thumb = fv.ImageURL
					break
				}
			}
			lv.Items = append(lv.Items, iv)
		}
		lv.New = s.buildFields(&v, scope.LabelPrefix, f.Key+".", f.Item, itemDefaults(f.Item))
		lv.Full = f.Max != nil && *f.Max > 0 && len(items) >= *f.Max // "max": 0 = no limit
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
		case "list", "section":
			continue
		case "bool":
			out[k] = form.Get(k) == "true"
		case "choices":
			picked := []string{}
			for _, c := range form[k] {
				if c != "" && !slices.Contains(picked, c) {
					picked = append(picked, c)
				}
			}
			out[k] = picked
		case "number":
			if n, err := strconv.Atoi(strings.TrimSpace(form.Get(k))); err == nil {
				out[k] = n
			}
		case "channel", "role":
			out[k] = parseRef(form.Get(k))
		case "permissions":
			// JSON from permissions.js; the API checks every list.
			var val map[string]any
			if json.Unmarshal([]byte(form.Get(k)), &val) == nil {
				out[k] = val
			}
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

// scopeResolver finds the settings form a request is for (module or plugin).
type scopeResolver func(w http.ResponseWriter, r *http.Request, p Page, botID int64) (settingsScope, bool)

func (s *Server) moduleSettingsScope(w http.ResponseWriter, r *http.Request, p Page, botID int64) (settingsScope, bool) {
	sc, found := moduleSchema(r.PathValue("key"))
	if !found {
		s.fail(w, r, p, &api.Error{Status: http.StatusNotFound, Key: "error.module.no_settings"})
		return settingsScope{}, false
	}
	return s.moduleScope(botID, sc), true
}

func (s *Server) settingsTarget(w http.ResponseWriter, r *http.Request, p Page, resolve scopeResolver) (int64, settingsScope, map[string]any, bool) {
	id, ok := s.botID(w, r, p)
	if !ok {
		return 0, settingsScope{}, nil, false
	}
	scope, ok := resolve(w, r, p, id)
	if !ok {
		return 0, settingsScope{}, nil, false
	}
	cfg, err := scope.load(r)
	if err != nil {
		s.failTo(w, r, p, err, "#modset-error")
		return 0, settingsScope{}, nil, false
	}
	if cfg == nil {
		cfg = map[string]any{}
	}
	_ = r.ParseForm()
	return id, scope, cfg, true
}

func (s *Server) saveSettings(w http.ResponseWriter, r *http.Request, p Page, id int64, scope settingsScope, cfg map[string]any) {
	if err := scope.save(r, cfg); err != nil {
		s.failTo(w, r, p, fieldError(err, scope, p.Locale, s), "#modset-error")
		return
	}
	v, err := s.scopeData(r, id, scope)
	if err != nil {
		s.failTo(w, r, p, err, "#modset-error")
		return
	}
	w.Header().Set("HX-Trigger", "bothub:saved")
	s.render(w, http.StatusOK, "module_item", "module_settings_fragment", withData(p, v))
}

// fieldError names the field of a refused value ("Please check: URL"),
// e.g. sites.0.url is the URL of the first entry of the list "sites".
func fieldError(err error, scope settingsScope, locale string, s *Server) error {
	var ae *api.Error
	if !errors.As(err, &ae) || ae.Key != "error.validation.failed" {
		return err
	}
	path, _ := ae.Params["field"].(string)
	parts := strings.Split(path, ".")
	if path == "" || len(parts) > 3 {
		return err
	}
	name := func(key, fallback string) string {
		if t := s.i18n.T(locale, scope.LabelPrefix+key); t != scope.LabelPrefix+key {
			return t
		}
		return fallback
	}
	label := name(parts[0], parts[0])
	if len(parts) == 3 {
		n, _ := strconv.Atoi(parts[1])
		label = fmt.Sprintf("%s #%d: %s", label, n+1, name(parts[0]+"."+parts[2], parts[2]))
	}
	return &api.Error{Status: ae.Status, Key: "error.validation.field", Params: map[string]any{"field": label}}
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
	s.settingsSave(w, r, p, s.moduleSettingsScope)
}

func (s *Server) settingsSave(w http.ResponseWriter, r *http.Request, p Page, resolve scopeResolver) {
	id, scope, cfg, ok := s.settingsTarget(w, r, p, resolve)
	if !ok {
		return
	}
	for k, v := range formValues(scope.Schema.Fields, r.PostForm) {
		cfg[k] = v
	}
	s.saveSettings(w, r, p, id, scope, cfg)
}

// handleSettingsItem adds (POST), replaces (PUT) or removes (DELETE) one
// entry of a list field.
func (s *Server) handleSettingsItem(w http.ResponseWriter, r *http.Request, p Page) {
	s.settingsItem(w, r, p, s.moduleSettingsScope)
}

func (s *Server) settingsItem(w http.ResponseWriter, r *http.Request, p Page, resolve scopeResolver) {
	id, scope, cfg, ok := s.settingsTarget(w, r, p, resolve)
	if !ok {
		return
	}
	lf, found := listField(scope.Schema, r.PathValue("list"))
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
		item := formValues(lf.Item, r.PostForm)
		// Keep the stable entry ID the API gave it (module state hangs on it).
		if old, ok := items[idx].(map[string]any); ok && old["_id"] != nil {
			item["_id"] = old["_id"]
		}
		items[idx] = item
	case http.MethodDelete:
		items = slices.Delete(items, idx, idx+1)
	}
	cfg[lf.Key] = items
	// Required fields of the top form that are still empty are left out: a
	// list entry can be saved before the rest of the form is filled in.
	for _, f := range scope.Schema.Fields {
		if f.Required && f.Type != "list" && emptyValue(cfg[f.Key]) {
			delete(cfg, f.Key)
		}
	}
	s.saveSettings(w, r, p, id, scope, cfg)
}

func emptyValue(v any) bool {
	switch x := v.(type) {
	case nil:
		return true
	case string:
		return x == ""
	case []any:
		return len(x) == 0
	}
	return false
}

// URL is the form target of a list entry ("" = top-level fields, idx -1 =
// new entry).
func (v settingsView) URL(list string, idx int) string {
	base := v.Base
	if list == "" {
		return base
	}
	if idx < 0 {
		return base + "/" + list
	}
	return fmt.Sprintf("%s/%s/%d", base, list, idx)
}

// pickerData is the JSON the settings page's pickers read: the bot's servers
// with their roles (managed ones left out) and channels, and the groups of
// Discord permissions (same as the slash trigger's permissions block).
func (s *Server) pickerData(guilds []settingsGuild) template.JS {
	type item struct {
		ID   string `json:"id"`
		Name string `json:"name"`
		Type string `json:"type,omitempty"`
	}
	type guild struct {
		ID       string `json:"id"`
		Name     string `json:"name"`
		IconURL  string `json:"iconUrl,omitempty"`
		Roles    []item `json:"roles"`
		Channels []item `json:"channels"`
	}
	out := struct {
		Guilds           []guild `json:"guilds"`
		PermissionGroups any     `json:"permissionGroups"`
	}{Guilds: []guild{}, PermissionGroups: s.permissionGroups()}
	for _, g := range guilds {
		pg := guild{ID: g.ID, Name: g.Name, IconURL: g.IconURL, Roles: []item{}, Channels: []item{}}
		for _, r := range g.Roles {
			if !r.Managed {
				pg.Roles = append(pg.Roles, item{ID: r.ID, Name: r.Name})
			}
		}
		for _, c := range g.Channels {
			pg.Channels = append(pg.Channels, item{ID: c.ID, Name: c.Name, Type: c.Type})
		}
		out.Guilds = append(out.Guilds, pg)
	}
	return jsonIsland(out)
}

// permissionGroups are the Discord permission groups of the slash trigger's
// permissions block (shared/nodes/trigger.slash.json x-permissionGroups).
func (s *Server) permissionGroups() any {
	for _, raw := range s.nodeDefs {
		var def struct {
			Type   string `json:"type"`
			Config struct {
				Properties map[string]struct {
					Groups any `json:"x-permissionGroups"`
				} `json:"properties"`
			} `json:"config"`
		}
		if json.Unmarshal(raw, &def) == nil && def.Type == "trigger.slash" {
			return def.Config.Properties["permissions"].Groups
		}
	}
	return []any{}
}

// integrationNotice says whether the integration of a module still lacks its
// client ID or secret (nil when set up or when the secrets cannot be read).
func (s *Server) integrationNotice(r *http.Request, sc settingsSchema) *integrationNotice {
	i := slices.IndexFunc(integrations, func(in integration) bool { return in.Key == sc.Integration })
	if i < 0 {
		return nil
	}
	in := integrations[i]
	secrets, err := s.api.UserSecrets(r.Context(), session(r))
	if err != nil {
		return nil
	}
	set := map[string]bool{}
	for _, x := range secrets {
		set[x.Key] = x.Set
	}
	if set[in.IDKey] && set[in.SecretKey] {
		return nil
	}
	return &integrationNotice{Name: in.Name, Optional: sc.IntegrationOptional}
}

// choiceItems lists the options of a "choices" field: static options (label
// from the i18n key <label>.<option>) or the plugin's dynamic ones; a picked
// value without an option (gone from the plugin's list) stays listed.
func choiceItems(f settingsField, label string, value any, dynamic []api.ChoiceOption) []choiceItem {
	picked := map[string]bool{}
	switch v := value.(type) {
	case []any:
		for _, x := range v {
			if s, ok := x.(string); ok {
				picked[s] = true
			}
		}
	case string: // older text value: "5, 2:3"
		for _, s := range strings.FieldsFunc(v, func(r rune) bool { return r == ',' || r == ' ' }) {
			picked[s] = true
		}
	}
	var out []choiceItem
	seen := map[string]bool{}
	if f.Dynamic {
		for _, o := range dynamic {
			out = append(out, choiceItem{Value: o.Value, Label: o.Label, Picked: picked[o.Value]})
			seen[o.Value] = true
		}
	} else {
		for _, o := range f.Options {
			out = append(out, choiceItem{Value: o, Key: label + "." + o, Picked: picked[o]})
			seen[o] = true
		}
	}
	rest := []string{}
	for p := range picked {
		if !seen[p] {
			rest = append(rest, p)
		}
	}
	slices.Sort(rest)
	for _, p := range rest {
		out = append(out, choiceItem{Value: p, Label: p, Picked: true})
	}
	return out
}

// hasType reports whether a form has a field of the type (also inside lists).
func hasType(fields []settingsField, typ string) bool {
	return slices.ContainsFunc(fields, func(f settingsField) bool { return f.Type == typ || hasType(f.Item, typ) })
}

// currencyOptions: the currencies of the bot's Economy settings for a
// "currency" field; the first is the default one.
func (s *Server) currencyOptions(r *http.Request, botID int64) []api.ChoiceOption {
	var cfg struct {
		Currencies []struct {
			Key, Name, Emoji string
		} `json:"currencies"`
	}
	_ = s.api.ModuleConfigRaw(r.Context(), session(r), botID, "economy", &cfg) // optional: only "default" on error
	out := []api.ChoiceOption{}
	for _, c := range cfg.Currencies {
		if c.Key == "" || c.Name == "" {
			continue
		}
		label := c.Name
		if c.Emoji != "" && !strings.HasPrefix(c.Emoji, "<") {
			label = c.Emoji + " " + c.Name
		}
		out = append(out, api.ChoiceOption{Value: c.Key, Label: label})
	}
	return out
}

// cardOptions: the bot's cards of the Card Designer for a "card" field.
func (s *Server) cardOptions(r *http.Request, botID int64) []api.ChoiceOption {
	cards, _ := s.api.Cards(r.Context(), session(r), botID) // optional: no cards on error
	out := []api.ChoiceOption{}
	for _, c := range cards {
		out = append(out, api.ChoiceOption{Value: strconv.FormatInt(c.ID, 10), Label: c.Name})
	}
	return out
}

// hasDynamic reports whether a form has a "choices" field the plugin fills.
func hasDynamic(fields []settingsField) bool {
	return slices.ContainsFunc(fields, func(f settingsField) bool { return f.Dynamic || hasDynamic(f.Item) })
}
