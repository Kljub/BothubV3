package main

import (
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base32"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"time"
)

// Webhooks module (in-memory stand-in for the PHP API, same contract).
// External services call POST /api/hooks/{botId}/{eventId}; the bot runs the
// custom events of type "webhook" that picked this webhook. The API key of a
// bot is kept as a SHA-256 hash only; its value is shown once on creation.

type webhook struct {
	ID           int64      `json:"id"`
	EventID      string     `json:"eventId"`
	Name         string     `json:"name"`
	RequireKey   bool       `json:"requireKey"`
	Enabled      bool       `json:"enabled"`
	URL          string     `json:"url"`
	Calls        int        `json:"calls"`
	LastCalledAt *time.Time `json:"lastCalledAt"`
	CreatedAt    time.Time  `json:"createdAt"`
	lastVars     map[string]string
	window       []time.Time // calls in the last minute (rate limit)
}

type webhookKey struct {
	hash      [32]byte
	hint      string
	createdAt time.Time
}

const (
	maxWebhooks      = 50
	webhookBodyLimit = 64 << 10
	webhookPerMinute = 60
)

var (
	webhookEventID = regexp.MustCompile(`^[a-z0-9]{16,40}$`)
	webhookVarName = regexp.MustCompile(`^[A-Za-z0-9_]{1,32}$`)
)

func (s *store) webhooksOf(botID int64) []*webhook {
	if s.webhooks == nil {
		s.webhooks = map[int64][]*webhook{}
	}
	return s.webhooks[botID]
}

func (s *store) listWebhooks(w http.ResponseWriter, r *http.Request, b *bot) {
	s.mu.Lock()
	defer s.mu.Unlock()
	items := []webhook{}
	for _, h := range s.webhooksOf(b.ID) {
		items = append(items, *h)
	}
	key := map[string]any{"set": false, "hint": nil, "createdAt": nil}
	if k, ok := s.webhookKeys[b.ID]; ok {
		key = map[string]any{"set": true, "hint": k.hint, "createdAt": k.createdAt}
	}
	writeJSON(w, 200, map[string]any{"items": items, "apiKey": key})
}

func (s *store) createWebhook(w http.ResponseWriter, r *http.Request, b *bot) {
	var in struct {
		EventID    string `json:"eventId"`
		Name       string `json:"name"`
		RequireKey bool   `json:"requireKey"`
	}
	if !readJSON(w, r, &in) {
		return
	}
	in.EventID, in.Name = strings.TrimSpace(in.EventID), strings.TrimSpace(in.Name)
	if !webhookEventID.MatchString(in.EventID) {
		apiError(w, 422, "error.webhook.event_id")
		return
	}
	if n := len([]rune(in.Name)); n == 0 || n > 60 {
		apiError(w, 422, "error.webhook.name")
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	list := s.webhooksOf(b.ID)
	if len(list) >= maxWebhooks {
		apiErrorParams(w, 422, "error.webhook.limit", map[string]any{"max": maxWebhooks})
		return
	}
	if slices.ContainsFunc(list, func(h *webhook) bool { return h.EventID == in.EventID }) {
		apiError(w, 409, "error.webhook.event_taken")
		return
	}
	s.webhookSeq++
	h := &webhook{ID: s.webhookSeq, EventID: in.EventID, Name: in.Name, RequireKey: in.RequireKey, Enabled: true,
		URL: fmt.Sprintf("/api/hooks/%d/%s", b.ID, in.EventID), CreatedAt: time.Now().UTC()}
	s.webhooks[b.ID] = append(list, h)
	writeJSON(w, 201, h)
}

func (s *store) findWebhook(w http.ResponseWriter, r *http.Request, b *bot) *webhook {
	id, _ := strconv.ParseInt(r.PathValue("wid"), 10, 64)
	for _, h := range s.webhooksOf(b.ID) {
		if h.ID == id {
			return h
		}
	}
	apiError(w, 404, "error.webhook.unknown")
	return nil
}

func (s *store) patchWebhook(w http.ResponseWriter, r *http.Request, b *bot) {
	var in struct {
		Name       *string `json:"name"`
		RequireKey *bool   `json:"requireKey"`
		Enabled    *bool   `json:"enabled"`
	}
	if !readJSON(w, r, &in) {
		return
	}
	if in.Name != nil {
		*in.Name = strings.TrimSpace(*in.Name)
		if n := len([]rune(*in.Name)); n == 0 || n > 60 {
			apiError(w, 422, "error.webhook.name")
			return
		}
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	h := s.findWebhook(w, r, b)
	if h == nil {
		return
	}
	if in.Name != nil {
		h.Name = *in.Name
	}
	if in.RequireKey != nil {
		h.RequireKey = *in.RequireKey
	}
	if in.Enabled != nil {
		h.Enabled = *in.Enabled
	}
	writeJSON(w, 200, h)
}

func (s *store) deleteWebhook(w http.ResponseWriter, r *http.Request, b *bot) {
	s.mu.Lock()
	defer s.mu.Unlock()
	h := s.findWebhook(w, r, b)
	if h == nil {
		return
	}
	s.webhooks[b.ID] = slices.DeleteFunc(s.webhooks[b.ID], func(x *webhook) bool { return x == h })
	w.WriteHeader(204)
}

// testWebhook runs the webhook like a real call, without the key check.
func (s *store) testWebhook(w http.ResponseWriter, r *http.Request, b *bot) {
	var in struct {
		Variables map[string]string `json:"variables"`
	}
	if !readJSON(w, r, &in) {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	h := s.findWebhook(w, r, b)
	if h == nil {
		return
	}
	s.recordWebhookCall(b.ID, h, in.Variables)
	writeJSON(w, 202, map[string]any{"ok": true})
}

// createWebhookKey makes a new API key; the value is returned only here.
func (s *store) createWebhookKey(w http.ResponseWriter, r *http.Request, b *bot) {
	raw := make([]byte, 30)
	_, _ = rand.Read(raw)
	key := "bh_" + strings.ToLower(base32.StdEncoding.WithPadding(base32.NoPadding).EncodeToString(raw))
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.webhookKeys == nil {
		s.webhookKeys = map[int64]webhookKey{}
	}
	s.webhookKeys[b.ID] = webhookKey{hash: sha256.Sum256([]byte(key)), hint: "…" + key[len(key)-4:], createdAt: time.Now().UTC()}
	s.addLog(b.ID, time.Now(), "change", "", "log.change.webhook_key", nil, &logChange{Field: "webhookKey"})
	writeJSON(w, 201, map[string]string{"apiKey": key})
}

// receiveWebhook is the public endpoint external services call.
func (s *store) receiveWebhook(w http.ResponseWriter, r *http.Request) {
	botID, _ := strconv.ParseInt(r.PathValue("botId"), 10, 64)
	eventID := r.PathValue("eventId")
	body, err := io.ReadAll(io.LimitReader(r.Body, webhookBodyLimit+1))
	if err != nil {
		apiError(w, 400, "error.request.invalid")
		return
	}
	if len(body) > webhookBodyLimit {
		apiError(w, 413, "error.webhook.too_large")
		return
	}
	vars, ok := webhookVariables(body)
	if !ok {
		apiError(w, 415, "error.webhook.json")
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	var h *webhook
	for _, x := range s.webhooksOf(botID) {
		if x.EventID == eventID && x.Enabled {
			h = x
		}
	}
	if h == nil {
		apiError(w, 404, "error.webhook.unknown")
		return
	}
	if h.RequireKey {
		k, has := s.webhookKeys[botID]
		sum := sha256.Sum256([]byte(strings.TrimSpace(strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer "))))
		if !has || subtle.ConstantTimeCompare(sum[:], k.hash[:]) != 1 {
			apiError(w, 401, "error.webhook.key")
			return
		}
	}
	now := time.Now()
	h.window = slices.DeleteFunc(h.window, func(t time.Time) bool { return now.Sub(t) > time.Minute })
	if len(h.window) >= webhookPerMinute {
		apiError(w, 429, "error.webhook.rate_limited")
		return
	}
	h.window = append(h.window, now)
	vars["body"] = truncate(string(body), 4000)
	s.recordWebhookCall(botID, h, vars)
	writeJSON(w, 202, map[string]any{"ok": true})
}

// recordWebhookCall counts the call; the PHP API also hands it to the
// NodeCore, the mock only logs it. Caller holds s.mu.
func (s *store) recordWebhookCall(botID int64, h *webhook, vars map[string]string) {
	now := time.Now().UTC()
	h.Calls++
	h.LastCalledAt = &now
	h.lastVars = vars
	s.addLog(botID, now, "update", "", "log.update.webhook_called", map[string]any{"name": h.Name}, nil)
}

// webhookVariables reads {"variables": {...}} or {"variables": [{name, value}]}.
// Other JSON is accepted without variables; non-JSON is refused.
func webhookVariables(body []byte) (map[string]string, bool) {
	vars := map[string]string{}
	if len(strings.TrimSpace(string(body))) == 0 {
		return vars, true
	}
	var doc map[string]json.RawMessage
	if err := json.Unmarshal(body, &doc); err != nil {
		var other json.RawMessage
		return vars, json.Unmarshal(body, &other) == nil
	}
	raw, ok := doc["variables"]
	if !ok {
		return vars, true
	}
	var asMap map[string]any
	if json.Unmarshal(raw, &asMap) == nil {
		for k, v := range asMap {
			if webhookVarName.MatchString(k) {
				vars[k] = truncate(fmt.Sprint(v), 1000)
			}
		}
		return vars, true
	}
	var asList []struct {
		Name  string `json:"name"`
		Value any    `json:"value"`
	}
	if json.Unmarshal(raw, &asList) == nil {
		for _, e := range asList {
			if webhookVarName.MatchString(e.Name) {
				vars[e.Name] = truncate(fmt.Sprint(e.Value), 1000)
			}
		}
	}
	return vars, true
}

func truncate(s string, max int) string {
	if len(s) <= max {
		return s
	}
	return s[:max]
}
