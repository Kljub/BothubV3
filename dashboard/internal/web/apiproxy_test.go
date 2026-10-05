package web

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/Kljub/BothubV3/dashboard/internal/api"
)

// The API trusts X-BotHub-Client-IP (sign-in limits, IP blocklist): the
// proxy must set it itself, never pass on what the browser sent.
func TestAPIProxySetsClientIP(t *testing.T) {
	got := ""
	fake := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got = r.Header.Get("X-BotHub-Client-IP")
		w.WriteHeader(http.StatusNoContent)
	}))
	t.Cleanup(fake.Close)
	client, err := api.New(fake.URL)
	if err != nil {
		t.Fatal(err)
	}
	s := &Server{api: client}
	req := httptest.NewRequest(http.MethodPost, "/api/v1/auth/login", nil)
	req.RemoteAddr = "203.0.113.5:4000"
	req.Header.Set("X-BotHub-Client-IP", "1.2.3.4")
	s.apiProxy().ServeHTTP(httptest.NewRecorder(), req)
	if got != "203.0.113.5" {
		t.Fatalf("client IP sent to the API: %q", got)
	}
}
