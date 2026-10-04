package web

import (
	"net/http/httptest"
	"testing"
)

func TestDeviceCheckReturnPath(t *testing.T) {
	for in, want := range map[string]string{
		"/bots/3?tab=logs":     "/bots/3?tab=logs",
		"//evil.example/x":     "/",
		"/\\evil.example":      "/",
		"https://evil.example": "/",
		"/device-check?next=/": "/",
		"":                     "/",
	} {
		if got := safeNext(in); got != want {
			t.Errorf("safeNext(%q) = %q, want %q", in, got, want)
		}
	}
	r := httptest.NewRequest("GET", "/docs", nil)
	r.Header.Set("HX-Request", "true")
	r.Header.Set("HX-Current-URL", "http://localhost:8080/bots/2/commands?x=1")
	if got := returnPath(r); got != "/bots/2/commands?x=1" {
		t.Errorf("htmx return path = %q", got)
	}
	if got := returnPath(httptest.NewRequest("POST", "/bots/2", nil)); got != "/" {
		t.Errorf("post return path = %q", got)
	}
}
