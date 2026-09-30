package main

import (
	"net/http"
	"strconv"
	"time"
)

// Plugins and logs of the mock API. No example data: every value comes
// from what the user creates.

type installedPlugin struct {
	ID                 string   `json:"id"`
	Name               string   `json:"name"`
	Description        string   `json:"description"`
	Icon               string   `json:"icon"`
	Version            string   `json:"version"`
	Enabled            bool     `json:"enabled"`
	Beta               bool     `json:"beta"`
	GrantedPermissions []string `json:"grantedPermissions"`
}

type logChange struct {
	Field string  `json:"field"`
	Old   *string `json:"old"`
	New   *string `json:"new"`
}

type logEntry struct {
	ID     int64          `json:"id"`
	Time   time.Time      `json:"time"`
	Level  string         `json:"level"`
	Code   *string        `json:"code"`
	Key    string         `json:"key"`
	Params map[string]any `json:"params,omitempty"`
	Change *logChange     `json:"change,omitempty"`
	Source string         `json:"source,omitempty"`
	Actor  string         `json:"actor,omitempty"`
}

const maxLogs = 500

// addLog appends an entry; caller holds s.mu. code is "" for changes and updates.
func (s *store) addLog(botID int64, at time.Time, level, code, key string, params map[string]any, change *logChange) {
	if s.logs == nil {
		s.logs = map[int64][]logEntry{}
	}
	s.logSeq++
	e := logEntry{ID: s.logSeq, Time: at.UTC(), Level: level, Key: key, Params: params, Change: change}
	if code != "" {
		c := code
		e.Code = &c
		e.Key = "log.code." + code
	}
	list := append(s.logs[botID], e)
	if len(list) > maxLogs {
		list = list[len(list)-maxLogs:]
	}
	s.logs[botID] = list
}

func strp(v string) *string { return &v }

func (s *store) listLogs(w http.ResponseWriter, r *http.Request, b *bot) {
	level := r.URL.Query().Get("level")
	limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
	if limit < 1 || limit > maxLogs {
		limit = 200
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	items := []logEntry{}
	for _, e := range s.logs[b.ID] {
		if level == "" || e.Level == level {
			items = append(items, e)
		}
	}
	if len(items) > limit {
		items = items[len(items)-limit:]
	}
	writeJSON(w, 200, map[string]any{"items": items})
}

func (s *store) clearLogs(w http.ResponseWriter, r *http.Request, b *bot) {
	s.mu.Lock()
	delete(s.logs, b.ID)
	s.mu.Unlock()
	w.WriteHeader(204)
}

func (s *store) listPlugins(w http.ResponseWriter, r *http.Request, b *bot) {
	s.mu.Lock()
	defer s.mu.Unlock()
	items := s.plugins[b.ID]
	if items == nil {
		items = []*installedPlugin{}
	}
	writeJSON(w, 200, map[string]any{"items": items})
}

func (s *store) patchPlugin(w http.ResponseWriter, r *http.Request, b *bot) {
	var in struct {
		Enabled *bool `json:"enabled"`
	}
	if !readJSON(w, r, &in) {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, p := range s.plugins[b.ID] {
		if p.ID != r.PathValue("plugin") {
			continue
		}
		if in.Enabled != nil && *in.Enabled != p.Enabled {
			p.Enabled = *in.Enabled
			key := "log.change.module_disabled"
			if p.Enabled {
				key = "log.change.module_enabled"
			}
			s.addLog(b.ID, time.Now(), "change", "", key, map[string]any{"module": p.Name}, nil)
		}
		writeJSON(w, 200, p)
		return
	}
	apiError(w, 404, "error.not_found")
}

// serverLog is the instance log (bot id 0 in the log store).
const serverLogID = 0

func (s *store) addServerLog(at time.Time, level, code, key, source, actor string, params map[string]any, change *logChange) {
	s.addLog(serverLogID, at, level, code, key, params, change)
	list := s.logs[serverLogID]
	list[len(list)-1].Source, list[len(list)-1].Actor = source, actor
}

func (s *store) listServerLogs(w http.ResponseWriter, r *http.Request, _ string) {
	level := r.URL.Query().Get("level")
	s.mu.Lock()
	defer s.mu.Unlock()
	items := []logEntry{}
	for _, e := range s.logs[serverLogID] {
		if level == "" || e.Level == level {
			items = append(items, e)
		}
	}
	writeJSON(w, 200, map[string]any{"items": items})
}
