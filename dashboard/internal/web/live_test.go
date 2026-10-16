package web

import (
	"bufio"
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/Kljub/BothubV3/dashboard/internal/api"
	"github.com/Kljub/BothubV3/dashboard/internal/i18n"
	"github.com/Kljub/BothubV3/dashboard/internal/live"
	"github.com/Kljub/BothubV3/dashboard/ui"
)

// /live sends a status change only for bots the account may see (GetBot
// answers), with the sidebar texts; other bots stay silent.
func TestLiveStreamsOwnBotsOnly(t *testing.T) {
	fake := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/v1/bots/12":
			_, _ = w.Write([]byte(`{"id":12,"name":"Mine","status":"stopped"}`))
		default:
			w.WriteHeader(http.StatusNotFound)
			_, _ = w.Write([]byte(`{"error":{"key":"error.not_found"}}`))
		}
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
	hub := live.New()
	s, err := New(Config{API: client, I18n: b, UI: ui.FS, DefaultLocale: "en", Live: hub})
	if err != nil {
		t.Fatal(err)
	}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /live", func(w http.ResponseWriter, r *http.Request) { s.handleLive(w, r, Page{Locale: "en"}) })
	srv := httptest.NewServer(mux)
	defer srv.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, srv.URL+"/live", nil)
	req.Header.Set("Accept", "text/event-stream")
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	if ct := res.Header.Get("Content-Type"); ct != "text/event-stream" {
		t.Fatalf("content type %q", ct)
	}
	r := bufio.NewReader(res.Body)
	if line, _ := r.ReadString('\n'); line != "retry: 5000\n" {
		t.Fatalf("first line %q", line)
	}
	hub.Publish([]byte(`{"type":"bot.status","botId":99,"status":"running"}`)) // not this account's
	hub.Publish([]byte(`{"type":"bot.status","botId":12,"status":"stopped"}`))
	var got []string
	for len(got) < 2 {
		line, err := r.ReadString('\n')
		if err != nil {
			t.Fatal(err)
		}
		if strings.HasPrefix(line, "event:") || strings.HasPrefix(line, "data:") {
			got = append(got, strings.TrimSpace(line))
		}
	}
	if got[0] != "event: bot" || !strings.Contains(got[1], `"id":12`) || !strings.Contains(got[1], `"light":"stopped"`) || strings.Contains(got[1], "99") {
		t.Fatalf("events %v", got)
	}
	// A plugin process changed: the task manager of that bot reloads.
	hub.Publish([]byte(`{"type":"plugin.tasks","botId":12}`))
	for {
		line, err := r.ReadString('\n')
		if err != nil {
			t.Fatal(err)
		}
		if strings.HasPrefix(line, "event:") {
			if line != "event: tasks\n" {
				t.Fatalf("event %q", line)
			}
			break
		}
	}
}

// The task manager box: rows of the bot's report, actions per state.
func TestPluginTasksTab(t *testing.T) {
	fake := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/v1/bots":
			_, _ = w.Write([]byte(`{"items":[{"id":7,"name":"Njetflix","status":"running"},{"id":8,"name":"Quiet","status":"stopped"}]}`))
		case "/api/v1/bots/7/plugin-tasks":
			_, _ = w.Write([]byte(`{"running":true,"tasks":[
				{"pluginId":"plugin_a","name":"Alpha","version":"1.0.0","state":"running","pid":41,"restarts":0,"calls":12,"callsPerMinute":3,"memoryBytes":31457280,"cpuPercent":1.25},
				{"pluginId":"plugin_b","name":"Beta","version":"2.0.0","state":"killed","pid":null,"restarts":0,"calls":0,"callsPerMinute":0,"memoryBytes":null,"cpuPercent":null,"reason":"sdk.plugin.killed_disabled"}]}`))
		default:
			_, _ = w.Write([]byte(`{"running":false,"tasks":[]}`))
		}
	}))
	defer fake.Close()
	client, _ := api.New(fake.URL)
	b, _ := i18n.Load(ui.FS, "lang")
	s, err := New(Config{API: client, I18n: b, UI: ui.FS, DefaultLocale: "en"})
	if err != nil {
		t.Fatal(err)
	}
	r := httptest.NewRequest(http.MethodGet, "/account/tasks", nil)
	r.Header.Set("HX-Request", "true")
	w := httptest.NewRecorder()
	s.handleAllTasks(w, r, Page{Locale: "en"})
	body := w.Body.String()
	for _, want := range []string{"Njetflix", "Alpha", "PID 41", "1.2 %", "3/min", "/account/tasks/7/plugin_a/kill", "Ended", "it used the SDK although it is switched off"} {
		if !strings.Contains(body, want) {
			t.Fatalf("missing %q in %s", want, body)
		}
	}
	if strings.Contains(body, "/plugin_b/kill") {
		t.Fatal("an ended task has no End task button")
	}
	if strings.Contains(body, "Quiet") {
		t.Fatal("a bot without plugins is left out")
	}
}

// Without Redis /live answers 204: the browser stops reconnecting.
func TestLiveOffWithoutRedis(t *testing.T) {
	s := &Server{}
	w := httptest.NewRecorder()
	s.handleLive(w, httptest.NewRequest(http.MethodGet, "/live", nil), Page{})
	if w.Code != http.StatusNoContent {
		t.Fatalf("code %d", w.Code)
	}
}
