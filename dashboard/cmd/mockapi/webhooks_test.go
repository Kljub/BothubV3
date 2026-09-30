package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func webhookStore() *store {
	return &store{bots: map[int64]*bot{1: {ID: 1, Name: "B"}}, logs: map[int64][]logEntry{}}
}

// call runs a bot handler (dashboard side) with {id} and {wid} set.
func call(s *store, h botHandler, method, pattern, target, body string) *httptest.ResponseRecorder {
	mux := http.NewServeMux()
	mux.HandleFunc(method+" "+pattern, func(w http.ResponseWriter, r *http.Request) { h(w, r, s.bots[1]) })
	req := httptest.NewRequest(method, target, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	return rec
}

func hook(s *store, eventID, auth, body string) int {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /api/hooks/{botId}/{eventId}", s.receiveWebhook)
	req := httptest.NewRequest("POST", "/api/hooks/1/"+eventID, strings.NewReader(body))
	if auth != "" {
		req.Header.Set("Authorization", auth)
	}
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	return rec.Code
}

func TestWebhookFlow(t *testing.T) {
	s := webhookStore()
	const id = "abcdefghij0123456789wxyz"
	if rec := call(s, s.createWebhook, "POST", "/b/{id}", "/b/1", `{"eventId":"`+id+`","name":"GitHub","requireKey":true}`); rec.Code != 201 {
		t.Fatalf("create: %d %s", rec.Code, rec.Body)
	}
	if rec := call(s, s.createWebhook, "POST", "/b/{id}", "/b/1", `{"eventId":"`+id+`","name":"Again","requireKey":true}`); rec.Code != 409 {
		t.Fatalf("duplicate event id: %d", rec.Code)
	}
	if rec := call(s, s.createWebhook, "POST", "/b/{id}", "/b/1", `{"eventId":"Short","name":"X"}`); rec.Code != 422 {
		t.Fatalf("bad event id: %d", rec.Code)
	}

	// No key yet: a webhook that requires one refuses every call.
	if code := hook(s, id, "anything", `{}`); code != 401 {
		t.Fatalf("no key: %d", code)
	}
	rec := call(s, s.createWebhookKey, "POST", "/b/{id}", "/b/1", "")
	var out struct {
		APIKey string `json:"apiKey"`
	}
	_ = json.Unmarshal(rec.Body.Bytes(), &out)
	if !strings.HasPrefix(out.APIKey, "bh_") {
		t.Fatalf("key = %q", out.APIKey)
	}
	// The list shows only the hint, never the key.
	list := call(s, s.listWebhooks, "GET", "/b/{id}", "/b/1", "").Body.String()
	if strings.Contains(list, out.APIKey) || !strings.Contains(list, out.APIKey[len(out.APIKey)-4:]) {
		t.Fatalf("list leaks the key or misses the hint: %s", list)
	}

	if code := hook(s, id, "wrong", `{}`); code != 401 {
		t.Fatalf("wrong key: %d", code)
	}
	if code := hook(s, id, out.APIKey, `{"variables":[{"name":"message","value":"hi"}]}`); code != 202 {
		t.Fatalf("list variables: %d", code)
	}
	if code := hook(s, id, "Bearer "+out.APIKey, `{"variables":{"message":"hi","bad name":"x"}}`); code != 202 {
		t.Fatalf("map variables with Bearer: %d", code)
	}
	if got := s.webhooks[1][0].lastVars; got["message"] != "hi" || got["bad name"] != "" {
		t.Fatalf("vars = %v", got)
	}
	if code := hook(s, id, out.APIKey, `not json`); code != 415 {
		t.Fatalf("not json: %d", code)
	}
	if code := hook(s, id, out.APIKey, `{"x":"`+strings.Repeat("a", webhookBodyLimit)+`"}`); code != 413 {
		t.Fatalf("too large: %d", code)
	}
	if code := hook(s, "nope000000000000000", out.APIKey, `{}`); code != 404 {
		t.Fatalf("unknown: %d", code)
	}

	// Switched off: 404 like an unknown webhook.
	if rec := call(s, s.patchWebhook, "PATCH", "/b/{id}/{wid}", "/b/1/1", `{"enabled":false}`); rec.Code != 200 {
		t.Fatalf("patch: %d", rec.Code)
	}
	if code := hook(s, id, out.APIKey, `{}`); code != 404 {
		t.Fatalf("disabled: %d", code)
	}
	if s.webhooks[1][0].Calls != 2 {
		t.Fatalf("calls = %d", s.webhooks[1][0].Calls)
	}
}

func TestWebhookRateLimit(t *testing.T) {
	s := webhookStore()
	const id = "open00000000000000000000"
	call(s, s.createWebhook, "POST", "/b/{id}", "/b/1", `{"eventId":"`+id+`","name":"Open","requireKey":false}`)
	for i := 0; i < webhookPerMinute; i++ {
		if code := hook(s, id, "", `{}`); code != 202 {
			t.Fatalf("call %d: %d", i, code)
		}
	}
	if code := hook(s, id, "", `{}`); code != 429 {
		t.Fatalf("over the limit: %d", code)
	}
}
