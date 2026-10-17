package web

import (
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"

	"github.com/Kljub/BothubV3/dashboard/internal/api"
	"github.com/Kljub/BothubV3/dashboard/internal/i18n"
	"github.com/Kljub/BothubV3/dashboard/ui"
)

// The own secrets carry what the search, filter and sort of the list need.
func TestSecretToolsData(t *testing.T) {
	fake := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/v1/me/secrets":
			_, _ = w.Write([]byte(`{"items":[
				{"key":"PLEX_URL","description":"Home server","set":true,"createdAt":"2026-01-01T00:00:00Z","updatedAt":"2026-05-01T00:00:00Z"},
				{"key":"WEATHER_KEY","description":"","set":false,"createdAt":"2026-03-01T00:00:00Z","updatedAt":"2026-03-01T00:00:00Z"},
				{"key":"FORGE_URL","description":"Stable Diffusion","set":true,"createdAt":"2026-10-01T00:00:00Z","updatedAt":"2026-10-02T00:00:00Z"}]}`))
		default:
			_, _ = w.Write([]byte(`{"items":[]}`))
		}
	}))
	defer fake.Close()
	client, _ := api.New(fake.URL)
	b, _ := i18n.Load(ui.FS, "lang")
	s, err := New(Config{API: client, I18n: b, UI: ui.FS, DefaultLocale: "en"})
	if err != nil {
		t.Fatal(err)
	}
	w := httptest.NewRecorder()
	s.handleUserSecrets(w, httptest.NewRequest(http.MethodGet, "/account/secrets", nil), Page{Locale: "en"})
	body := w.Body.String()
	for _, want := range []string{`data-secret-tools`, `data-secret-filter`, `>Empty ([NULL])<`, `>Newest first<`, `data-key="WEATHER_KEY"`, `data-set="false"`, `data-address="true"`, `data-created="1767225600"`, `data-secret-none hidden`} {
		if !strings.Contains(body, want) {
			t.Fatalf("missing %q", want)
		}
	}
	if p := os.Getenv("SECRETS_PREVIEW"); p != "" {
		_ = os.WriteFile(p, []byte(body), 0o644)
	}
}
