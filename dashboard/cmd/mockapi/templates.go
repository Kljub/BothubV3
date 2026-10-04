package main

import (
	"encoding/json"
	"net/http"
	"slices"
	"strconv"
	"strings"
	"time"
)

// Message templates of the message builder, per bot.

type msgTemplate struct {
	ID        int64           `json:"id"`
	Name      string          `json:"name"`
	Message   json.RawMessage `json:"message"`
	CreatedAt time.Time       `json:"createdAt"`
}

func (s *store) listTemplates(w http.ResponseWriter, r *http.Request, b *bot) {
	s.mu.Lock()
	defer s.mu.Unlock()
	items := []*msgTemplate{}
	items = append(items, s.templates[b.ID]...)
	writeJSON(w, 200, map[string]any{"items": items})
}

func (s *store) createTemplate(w http.ResponseWriter, r *http.Request, b *bot) {
	var in struct {
		Name    string          `json:"name"`
		Message json.RawMessage `json:"message"`
	}
	if !readJSON(w, r, &in) {
		return
	}
	in.Name = strings.TrimSpace(in.Name)
	var msg map[string]any
	if in.Name == "" || len([]rune(in.Name)) > 60 || json.Unmarshal(in.Message, &msg) != nil || len(in.Message) > 64<<10 {
		apiError(w, 422, "error.template.invalid")
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.tplSeq++
	t := &msgTemplate{ID: s.tplSeq, Name: in.Name, Message: in.Message, CreatedAt: time.Now().UTC()}
	s.templates[b.ID] = append(s.templates[b.ID], t)
	writeJSON(w, 201, t)
}

func (s *store) deleteTemplate(w http.ResponseWriter, r *http.Request, b *bot) {
	id, _ := strconv.ParseInt(r.PathValue("tid"), 10, 64)
	s.mu.Lock()
	defer s.mu.Unlock()
	before := len(s.templates[b.ID])
	s.templates[b.ID] = slices.DeleteFunc(s.templates[b.ID], func(t *msgTemplate) bool { return t.ID == id })
	if len(s.templates[b.ID]) == before {
		apiError(w, 404, "error.template.unknown")
		return
	}
	w.WriteHeader(204)
}

// updateTemplate changes name and/or message (the PHP API does the same).
func (s *store) updateTemplate(w http.ResponseWriter, r *http.Request, b *bot) {
	var in struct {
		Name    *string         `json:"name"`
		Message json.RawMessage `json:"message"`
	}
	if !readJSON(w, r, &in) {
		return
	}
	id, _ := strconv.ParseInt(r.PathValue("tid"), 10, 64)
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, t := range s.templates[b.ID] {
		if t.ID != id {
			continue
		}
		if in.Name != nil {
			name := strings.TrimSpace(*in.Name)
			if name == "" || len([]rune(name)) > 60 {
				apiError(w, 422, "error.template.invalid")
				return
			}
			t.Name = name
		}
		if in.Message != nil {
			var msg map[string]any
			if json.Unmarshal(in.Message, &msg) != nil || len(in.Message) > 64<<10 {
				apiError(w, 422, "error.template.invalid")
				return
			}
			t.Message = in.Message
		}
		writeJSON(w, 200, t)
		return
	}
	apiError(w, 404, "error.template.unknown")
}

func (s *store) getTemplate(w http.ResponseWriter, r *http.Request, b *bot) {
	id, _ := strconv.ParseInt(r.PathValue("tid"), 10, 64)
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, t := range s.templates[b.ID] {
		if t.ID == id {
			writeJSON(w, 200, t)
			return
		}
	}
	apiError(w, 404, "error.template.unknown")
}
