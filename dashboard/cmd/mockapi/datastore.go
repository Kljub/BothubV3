package main

import (
	"encoding/csv"
	"encoding/json"
	"fmt"
	"math"
	"net/http"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"time"
)

// Data Storage module: variables defined on the dashboard and their values
// (api/migrations/0007_data_storage.sql). Blocks reference them as
// {var.<key>}; that is also how "used in" is counted.

type dataVariable struct {
	ID           int64     `json:"id"`
	Key          string    `json:"key"`
	Name         string    `json:"name"`
	Description  string    `json:"description"`
	Type         string    `json:"type"`
	Owner        string    `json:"owner"`
	PerServer    bool      `json:"perServer"`
	DefaultValue string    `json:"defaultValue"`
	Group        string    `json:"group"`
	Values       int       `json:"values"`
	UsedIn       int       `json:"usedIn"`
	UpdatedAt    time.Time `json:"updatedAt"`
}

type dataValue struct {
	ServerID  string    `json:"serverId"`
	OwnerID   string    `json:"ownerId"`
	Value     string    `json:"value"`
	UpdatedAt time.Time `json:"updatedAt"`
}

type dataStore struct {
	seq    int64
	vars   map[int64][]*dataVariable // by bot
	values map[int64][]*dataValue    // by variable
}

const (
	maxDataVariables = 200
	dataPageSize     = 25
	maxDataCSVRows   = 5000
	// maxDataValues: stored values per variable (same as the bot).
	maxDataValues = 100000
)

var (
	dataKey     = regexp.MustCompile(`^[a-z][a-z0-9_]{0,31}$`)
	dataKeyJunk = regexp.MustCompile(`[^a-z0-9_]+`)
	snowflakeID = regexp.MustCompile(`^[0-9]{17,20}$`)
	dataNumber  = regexp.MustCompile(`(?i)^\s*-?(\d+(\.\d*)?|\.\d+)(e[+-]?\d+)?\s*$`)
)

func (d *dataStore) init() {
	if d.vars == nil {
		d.vars = map[int64][]*dataVariable{}
		d.values = map[int64][]*dataValue{}
	}
}

// keyFromName turns "Daily Coins" into "daily_coins".
func keyFromName(name string) string {
	k := strings.Trim(dataKeyJunk.ReplaceAllString(strings.ToLower(name), "_"), "_")
	k = strings.TrimLeft(k, "0123456789_")
	if len(k) > 32 {
		k = strings.TrimRight(k[:32], "_")
	}
	return k
}

// validDataValue checks a value against the variable type.
func validDataValue(typ, v string) bool {
	if len(v) > 4000 {
		return false
	}
	if v == "" {
		return true
	}
	switch typ {
	case "number":
		// Same rule as the bot: a finite decimal number (no NaN, Inf, hex).
		if !dataNumber.MatchString(v) {
			return false
		}
		f, err := strconv.ParseFloat(strings.TrimSpace(v), 64)
		return err == nil && !math.IsInf(f, 0) && !math.IsNaN(f)
	case "list":
		var a []any
		if json.Unmarshal([]byte(v), &a) != nil {
			return false
		}
		for _, x := range a {
			switch x.(type) {
			case string, float64, bool:
			default:
				return false
			}
		}
		return true
	case "object":
		var o map[string]any
		return json.Unmarshal([]byte(v), &o) == nil
	case "object_list":
		var a []map[string]any
		return json.Unmarshal([]byte(v), &a) == nil
	}
	return true
}

type dataVariableInput struct {
	Key          string `json:"key"`
	Name         string `json:"name"`
	Description  string `json:"description"`
	Type         string `json:"type"`
	Owner        string `json:"owner"`
	PerServer    bool   `json:"perServer"`
	DefaultValue string `json:"defaultValue"`
	Group        string `json:"group"`
}

// check returns the error key of an invalid input, or "".
func (in *dataVariableInput) check() string {
	in.Name, in.Group, in.Description = strings.TrimSpace(in.Name), strings.TrimSpace(in.Group), strings.TrimSpace(in.Description)
	switch {
	case in.Name == "" || len([]rune(in.Name)) > 32:
		return "error.data.name"
	case !slices.Contains([]string{"text", "number", "list", "object", "object_list"}, in.Type):
		return "error.data.type"
	case !slices.Contains([]string{"shared", "member", "channel"}, in.Owner):
		return "error.data.owner"
	case len([]rune(in.Group)) > 40 || len([]rune(in.Description)) > 200:
		return "error.data.too_long"
	case !validDataValue(in.Type, in.DefaultValue):
		return "error.data.value"
	}
	return ""
}

// usedIn counts commands and events that reference {var.<key>} or the key
// in a variable block (var_name "var.<key>").
func (s *store) usedIn(botID int64, key string) int {
	re := regexp.MustCompile(`var\.` + regexp.QuoteMeta(key) + `\b`)
	n := 0
	for _, c := range s.customCmds[botID] {
		if re.Match(c.Graph) {
			n++
		}
	}
	return n
}

func (s *store) dataVar(b *bot, r *http.Request) *dataVariable {
	id, _ := strconv.ParseInt(r.PathValue("vid"), 10, 64)
	for _, v := range s.data.vars[b.ID] {
		if v.ID == id {
			return v
		}
	}
	return nil
}

func (s *store) dataVarOut(b *bot, v *dataVariable) dataVariable {
	out := *v
	out.Values = len(s.data.values[v.ID])
	out.UsedIn = s.usedIn(b.ID, v.Key)
	return out
}

func (s *store) listDataVariables(w http.ResponseWriter, r *http.Request, b *bot) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.data.init()
	items := []dataVariable{}
	for _, v := range s.data.vars[b.ID] {
		items = append(items, s.dataVarOut(b, v))
	}
	slices.SortStableFunc(items, func(a, b dataVariable) int {
		if c := strings.Compare(strings.ToLower(a.Group), strings.ToLower(b.Group)); c != 0 {
			return c
		}
		return strings.Compare(strings.ToLower(a.Name), strings.ToLower(b.Name))
	})
	writeJSON(w, 200, map[string]any{"items": items})
}

func (s *store) createDataVariable(w http.ResponseWriter, r *http.Request, b *bot) {
	var in dataVariableInput
	if !readJSON(w, r, &in) {
		return
	}
	if key := in.check(); key != "" {
		apiError(w, 422, key)
		return
	}
	if in.Key == "" {
		in.Key = keyFromName(in.Name)
	}
	if !dataKey.MatchString(in.Key) {
		apiError(w, 422, "error.data.key")
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.data.init()
	if len(s.data.vars[b.ID]) >= maxDataVariables {
		apiError(w, 422, "error.data.limit")
		return
	}
	for _, v := range s.data.vars[b.ID] {
		if v.Key == in.Key {
			apiError(w, 409, "error.data.key_taken")
			return
		}
	}
	s.data.seq++
	v := &dataVariable{ID: s.data.seq, Key: in.Key, Name: in.Name, Description: in.Description, Type: in.Type, Owner: in.Owner,
		PerServer: in.PerServer, DefaultValue: in.DefaultValue, Group: in.Group, UpdatedAt: time.Now().UTC()}
	s.data.vars[b.ID] = append(s.data.vars[b.ID], v)
	writeJSON(w, 201, s.dataVarOut(b, v))
}

func (s *store) updateDataVariable(w http.ResponseWriter, r *http.Request, b *bot) {
	var in dataVariableInput
	if !readJSON(w, r, &in) {
		return
	}
	if key := in.check(); key != "" {
		apiError(w, 422, key)
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.data.init()
	v := s.dataVar(b, r)
	if v == nil {
		apiError(w, 404, "error.data.unknown")
		return
	}
	// Values stored under another shape no longer fit.
	if v.Type != in.Type || v.Owner != in.Owner || v.PerServer != in.PerServer {
		delete(s.data.values, v.ID)
	}
	v.Name, v.Description, v.Type, v.Owner, v.PerServer, v.DefaultValue, v.Group = in.Name, in.Description, in.Type, in.Owner, in.PerServer, in.DefaultValue, in.Group
	v.UpdatedAt = time.Now().UTC()
	writeJSON(w, 200, s.dataVarOut(b, v))
}

func (s *store) deleteDataVariable(w http.ResponseWriter, r *http.Request, b *bot) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.data.init()
	v := s.dataVar(b, r)
	if v == nil {
		apiError(w, 404, "error.data.unknown")
		return
	}
	s.data.vars[b.ID] = slices.DeleteFunc(s.data.vars[b.ID], func(x *dataVariable) bool { return x == v })
	delete(s.data.values, v.ID)
	w.WriteHeader(204)
}

// sortedValues returns the values of a variable filtered by q, sorted.
func (s *store) sortedValues(v *dataVariable, q, sort string) []*dataValue {
	list := []*dataValue{}
	for _, x := range s.data.values[v.ID] {
		if q == "" || strings.HasPrefix(x.ServerID, q) || strings.HasPrefix(x.OwnerID, q) {
			list = append(list, x)
		}
	}
	slices.SortStableFunc(list, func(a, b *dataValue) int {
		if sort == "value" {
			if v.Type == "number" {
				fa, _ := strconv.ParseFloat(a.Value, 64)
				fb, _ := strconv.ParseFloat(b.Value, 64)
				switch {
				case fa > fb:
					return -1
				case fa < fb:
					return 1
				}
				return 0
			}
			return strings.Compare(a.Value, b.Value)
		}
		return b.UpdatedAt.Compare(a.UpdatedAt)
	})
	return list
}

func (s *store) listDataValues(w http.ResponseWriter, r *http.Request, b *bot) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.data.init()
	v := s.dataVar(b, r)
	if v == nil {
		apiError(w, 404, "error.data.unknown")
		return
	}
	list := s.sortedValues(v, strings.TrimSpace(r.URL.Query().Get("q")), r.URL.Query().Get("sort"))
	page, _ := strconv.Atoi(r.URL.Query().Get("page"))
	page = max(page, 1)
	from := min((page-1)*dataPageSize, len(list))
	to := min(from+dataPageSize, len(list))
	writeJSON(w, 200, map[string]any{"items": list[from:to], "total": len(list), "page": page, "pageSize": dataPageSize})
}

func (s *store) setDataValue(w http.ResponseWriter, r *http.Request, b *bot) {
	var in dataValue
	if !readJSON(w, r, &in) {
		return
	}
	in.ServerID, in.OwnerID = strings.TrimSpace(in.ServerID), strings.TrimSpace(in.OwnerID)
	s.mu.Lock()
	defer s.mu.Unlock()
	s.data.init()
	v := s.dataVar(b, r)
	if v == nil {
		apiError(w, 404, "error.data.unknown")
		return
	}
	// The IDs a value needs follow from the variable.
	needServer, needOwner := v.PerServer, v.Owner != "shared"
	if needServer != (in.ServerID != "") || needOwner != (in.OwnerID != "") ||
		(needServer && !snowflakeID.MatchString(in.ServerID)) || (needOwner && !snowflakeID.MatchString(in.OwnerID)) {
		apiError(w, 422, "error.data.ids")
		return
	}
	if !validDataValue(v.Type, in.Value) {
		apiError(w, 422, "error.data.value")
		return
	}
	in.UpdatedAt = time.Now().UTC()
	for _, x := range s.data.values[v.ID] {
		if x.ServerID == in.ServerID && x.OwnerID == in.OwnerID {
			*x = in
			writeJSON(w, 200, x)
			return
		}
	}
	if len(s.data.values[v.ID]) >= maxDataValues {
		apiError(w, 422, "error.data.limit_values")
		return
	}
	nv := in
	s.data.values[v.ID] = append(s.data.values[v.ID], &nv)
	writeJSON(w, 200, &nv)
}

func (s *store) deleteDataValues(w http.ResponseWriter, r *http.Request, b *bot) {
	q := r.URL.Query()
	s.mu.Lock()
	defer s.mu.Unlock()
	s.data.init()
	v := s.dataVar(b, r)
	if v == nil {
		apiError(w, 404, "error.data.unknown")
		return
	}
	if q.Get("all") == "true" {
		delete(s.data.values, v.ID)
		w.WriteHeader(204)
		return
	}
	before := len(s.data.values[v.ID])
	s.data.values[v.ID] = slices.DeleteFunc(s.data.values[v.ID], func(x *dataValue) bool {
		return x.ServerID == q.Get("serverId") && x.OwnerID == q.Get("ownerId")
	})
	if len(s.data.values[v.ID]) == before {
		apiError(w, 404, "error.data.value_unknown")
		return
	}
	w.WriteHeader(204)
}

func (s *store) exportDataValues(w http.ResponseWriter, r *http.Request, b *bot) {
	if s.php != nil {
		s.exportDataValuesPHP(w, r, b)
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.data.init()
	v := s.dataVar(b, r)
	if v == nil {
		apiError(w, 404, "error.data.unknown")
		return
	}
	list := s.sortedValues(v, "", "updated")
	if len(list) > maxDataCSVRows {
		list = list[:maxDataCSVRows]
	}
	w.Header().Set("Content-Type", "text/csv; charset=utf-8")
	w.Header().Set("Content-Disposition", `attachment; filename="`+v.Key+`.csv"`)
	cw := csv.NewWriter(w)
	_ = cw.Write([]string{"server", "owner", "value", "updated"})
	for _, x := range list {
		_ = cw.Write([]string{x.ServerID, x.OwnerID, x.Value, x.UpdatedAt.Format(time.RFC3339)})
	}
	cw.Flush()
}

func (s *store) lookupDataValues(w http.ResponseWriter, r *http.Request, b *bot) {
	id := strings.TrimSpace(r.URL.Query().Get("id"))
	if !snowflakeID.MatchString(id) {
		apiError(w, 422, "error.data.ids")
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.data.init()
	type row struct {
		dataValue
		VariableID int64  `json:"variableId"`
		Key        string `json:"key"`
	}
	items := []row{}
	for _, v := range s.data.vars[b.ID] {
		for _, x := range s.data.values[v.ID] {
			if x.OwnerID == id {
				items = append(items, row{dataValue: *x, VariableID: v.ID, Key: v.Key})
			}
		}
	}
	writeJSON(w, 200, map[string]any{"items": items})
}

// exportDataValuesPHP builds the CSV from the API's values (export=1: the
// newest 5,000), so the file looks the same with and without the PHP API.
func (s *store) exportDataValuesPHP(w http.ResponseWriter, r *http.Request, b *bot) {
	vid := r.PathValue("vid")
	path := fmt.Sprintf("/internal/bots/%d/data/variables/%s", b.ID, vid)
	var v struct {
		Key string `json:"key"`
	}
	var page struct {
		Items []dataValue `json:"items"`
	}
	for _, call := range []struct {
		path string
		out  any
	}{{path, &v}, {path + "/values?export=1", &page}} {
		req, err := http.NewRequestWithContext(r.Context(), http.MethodGet, s.php.base+call.path, nil)
		if err != nil {
			apiError(w, 500, "error.internal")
			return
		}
		req.Header.Set("X-BotHub-Internal", s.php.key)
		resp, err := s.php.http.Do(req)
		if err != nil {
			apiError(w, 502, "error.api.unreachable")
			return
		}
		ok := resp.StatusCode == http.StatusOK && json.NewDecoder(resp.Body).Decode(call.out) == nil
		resp.Body.Close()
		if !ok {
			apiError(w, resp.StatusCode, "error.data.unknown")
			return
		}
	}
	w.Header().Set("Content-Type", "text/csv; charset=utf-8")
	w.Header().Set("Content-Disposition", `attachment; filename="`+v.Key+`.csv"`)
	cw := csv.NewWriter(w)
	_ = cw.Write([]string{"server", "owner", "value", "updated"})
	for _, x := range page.Items {
		_ = cw.Write([]string{x.ServerID, x.OwnerID, x.Value, x.UpdatedAt.Format(time.RFC3339)})
	}
	cw.Flush()
}
