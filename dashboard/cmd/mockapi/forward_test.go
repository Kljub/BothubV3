package main

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// fakePHP records forwarded requests and answers like the internal API.
func fakePHP(t *testing.T, seen *[]string) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("X-BotHub-Internal") != "k" {
			w.WriteHeader(401)
			return
		}
		body, _ := io.ReadAll(r.Body)
		*seen = append(*seen, r.Method+" "+r.URL.RequestURI()+" "+string(body))
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.URL.Path == "/internal/bots/1/modules":
			_, _ = w.Write([]byte(`{"items":[{"key":"economy","enabled":false}]}`))
		case r.Method == "GET" && r.URL.Path == "/internal/bots/1/commands/7":
			_, _ = w.Write([]byte(`{"id":7,"name":"purge","enabled":false}`))
		case r.Method == "POST":
			w.WriteHeader(201)
			_, _ = w.Write([]byte(`{"id":9,"name":"x"}`))
		default:
			_, _ = w.Write([]byte(`{"items":[]}`))
		}
	}))
}

func newForwardStore(url string) *store {
	s := &store{
		bots:           map[int64]*bot{1: {ID: 1, Name: "B"}},
		known:          map[string]bool{"economy": true, "moderation": true},
		modules:        map[string]bool{},
		cmdStates:      map[string]bool{},
		commandCatalog: map[string][]string{"moderation": {"purge"}},
	}
	s.php = &phpBots{base: url, key: "k", http: http.DefaultClient}
	return s
}

func serve(s *store, h botHandler, method, target, pattern, body string) *httptest.ResponseRecorder {
	mux := http.NewServeMux()
	mux.HandleFunc(method+" "+pattern, func(w http.ResponseWriter, r *http.Request) { h(w, r, s.bots[1]) })
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, httptest.NewRequest(method, target, strings.NewReader(body)))
	return rec
}

func TestForwardCommands(t *testing.T) {
	var seen []string
	php := fakePHP(t, &seen)
	defer php.Close()
	s := newForwardStore(php.URL)
	local := func(w http.ResponseWriter, r *http.Request, b *bot) { t.Fatal("local handler must not run") }

	rec := serve(s, s.viaPHP(local), "GET", "/api/v1/bots/1/commands?builtin=false", "/api/v1/bots/{id}/commands", "")
	if rec.Code != 200 || seen[0] != "GET /internal/bots/1/commands?builtin=false " {
		t.Fatalf("list: %d %v", rec.Code, seen)
	}
	rec = serve(s, s.viaPHP(local), "POST", "/api/v1/bots/1/events", "/api/v1/bots/{id}/events", `{"name":"Welcome","enabled":true}`)
	if rec.Code != 201 || !strings.HasSuffix(seen[1], `{"name":"Welcome","enabled":true}`) {
		t.Fatalf("event create: %d %v", rec.Code, seen)
	}
}

func TestCopiesOfModuleCommandsCanBeEnabled(t *testing.T) {
	var seen []string
	php := fakePHP(t, &seen)
	defer php.Close()
	s := newForwardStore(php.URL)
	local := func(w http.ResponseWriter, r *http.Request, b *bot) {}
	// The copy of /purge is the runnable command: switching it on goes through.
	rec := serve(s, s.viaPHP(local), "POST", "/api/v1/bots/1/commands", "/api/v1/bots/{id}/commands", `{"name":"purge","enabled":true}`)
	if rec.Code != 201 || len(seen) != 1 {
		t.Fatalf("create enabled copy: %d %v", rec.Code, seen)
	}
}

func TestModulesMissingMeansOn(t *testing.T) {
	var seen []string
	php := fakePHP(t, &seen)
	defer php.Close()
	s := newForwardStore(php.URL)
	rec := serve(s, s.modulesFromPHP(nil), "GET", "/api/v1/bots/1/modules", "/api/v1/bots/{id}/modules", "")
	var out struct {
		Items []struct {
			Key     string `json:"key"`
			Enabled bool   `json:"enabled"`
		} `json:"items"`
	}
	_ = json.Unmarshal(rec.Body.Bytes(), &out)
	got := map[string]bool{}
	for _, m := range out.Items {
		got[m.Key] = m.Enabled
	}
	if len(got) != 2 || got["economy"] || !got["moderation"] {
		t.Fatalf("modules = %v", got)
	}
}
