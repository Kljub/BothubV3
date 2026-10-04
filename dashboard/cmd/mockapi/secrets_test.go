package main

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func secretsStore() *store {
	return &store{logs: map[int64][]logEntry{}}
}

func adminCall(s *store, h authed, method, pattern, target, body string) *httptest.ResponseRecorder {
	mux := http.NewServeMux()
	mux.HandleFunc(method+" "+pattern, func(w http.ResponseWriter, r *http.Request) { h(w, r, "sid") })
	req := httptest.NewRequest(method, target, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	return rec
}

// A secret value is write-only: no answer may contain it.
func TestSecretValueNeverReturned(t *testing.T) {
	s := secretsStore()
	const value = "super-secret-token-123"
	for _, rec := range []*httptest.ResponseRecorder{
		adminCall(s, s.putSecret, "PUT", "/s/{key}", "/s/YOUTUBE_API_KEY", `{"value":"`+value+`","description":"yt"}`),
		adminCall(s, s.listSecrets, "GET", "/s", "/s", ""),
		adminCall(s, s.putSecret, "PUT", "/s/{key}", "/s/YOUTUBE_API_KEY", `{"description":"changed"}`),
	} {
		if rec.Code >= 300 {
			t.Fatalf("status %d: %s", rec.Code, rec.Body)
		}
		// "super-secret" catches a cut-off value too; "123" alone would match timestamps (…:43.123Z).
		if strings.Contains(rec.Body.String(), value) || strings.Contains(rec.Body.String(), "super-secret") {
			t.Fatalf("answer contains the secret: %s", rec.Body)
		}
	}
	if s.secrets["YOUTUBE_API_KEY"].value != value {
		t.Fatal("empty value on update must keep the stored value")
	}
}

func TestSecretRules(t *testing.T) {
	s := secretsStore()
	if rec := adminCall(s, s.putSecret, "PUT", "/s/{key}", "/s/lower", `{"value":"x"}`); rec.Code != 422 {
		t.Fatalf("bad key: %d", rec.Code)
	}
	if rec := adminCall(s, s.putSecret, "PUT", "/s/{key}", "/s/NEW_KEY", `{"description":"no value"}`); rec.Code != 422 {
		t.Fatalf("new secret without value: %d", rec.Code)
	}
	adminCall(s, s.putSecret, "PUT", "/s/{key}", "/s/WEATHER_KEY", `{"value":"abc"}`)
	if rec := adminCall(s, s.deleteSecret, "DELETE", "/s/{key}", "/s/WEATHER_KEY", ""); rec.Code != 204 {
		t.Fatalf("delete secret: %d", rec.Code)
	}
}
