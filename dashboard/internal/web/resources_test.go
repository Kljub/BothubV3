package web

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/Kljub/BothubV3/dashboard/internal/api"
	"github.com/Kljub/BothubV3/dashboard/internal/i18n"
	"github.com/Kljub/BothubV3/dashboard/ui"
)

// The dashboard exits only after the API allowed the restart; processes
// that cannot restart never reach the API.
func TestRestartProcess(t *testing.T) {
	var calls []string
	fake := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls = append(calls, r.Method+" "+r.URL.Path)
		w.WriteHeader(http.StatusAccepted)
		_, _ = w.Write([]byte(`{}`))
	}))
	defer fake.Close()
	client, err := api.New(fake.URL)
	if err != nil {
		t.Fatal(err)
	}
	b, err := i18n.Load(ui.FS, "lang")
	if err != nil {
		t.Fatal(err)
	}
	s, err := New(Config{API: client, I18n: b, UI: ui.FS, DefaultLocale: "en"})
	if err != nil {
		t.Fatal(err)
	}
	exited := make(chan struct{}, 1)
	s.exit = func() { exited <- struct{}{} }

	do := func(key string) *httptest.ResponseRecorder {
		r := httptest.NewRequest(http.MethodPost, "/admin/resources/"+key+"/restart", nil)
		r.SetPathValue("key", key)
		r.Header.Set("HX-Request", "true")
		w := httptest.NewRecorder()
		s.handleRestartProcess(w, r, Page{Locale: "en"})
		return w
	}

	if w := do("database"); !strings.Contains(w.Body.String(), "cannot be restarted") || len(calls) != 0 {
		t.Fatalf("database: body %q, calls %v", w.Body.String(), calls)
	}
	if w := do("botcore"); !strings.Contains(w.Body.String(), "BotCore is restarting") || calls[0] != "POST /api/v1/admin/processes/botcore/restart" {
		t.Fatalf("botcore: body %q, calls %v", w.Body.String(), calls)
	}
	select {
	case <-exited:
		t.Fatal("botcore restart must not end the dashboard")
	default:
	}
	do("dashboard")
	<-exited
}
