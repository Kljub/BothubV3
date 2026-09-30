package main

import (
	"net/http"
	"time"
)

// restartProcess: the dashboard restarts itself after a 202 (the API only
// authorizes); the BotCore gets a core.restart job from the PHP API. Other
// processes cannot be restarted from inside.
func (s *store) restartProcess(w http.ResponseWriter, r *http.Request, _ string) {
	switch r.PathValue("key") {
	case "dashboard":
		writeJSON(w, 202, map[string]any{"key": "dashboard"})
	case "botcore":
		if s.php == nil {
			apiError(w, 503, "error.api.unreachable")
			return
		}
		var out map[string]any
		if err := s.php.do(r.Context(), http.MethodPost, "/internal/processes/botcore/restart", nil, &out); err != nil {
			pe := asPHPError(err)
			apiError(w, pe.Status, pe.Key)
			return
		}
		writeJSON(w, 202, out)
	default:
		apiError(w, 422, "error.process.not_restartable")
	}
}

// processes reports what the mock can really check: the PHP API (health
// endpoint) and the Discord API (latency of GET /gateway). BotCore (Node
// heartbeat) and the database come from the PHP API (/internal/processes).
// Plugin manager and Redis numbers follow.
func (s *store) processes(w http.ResponseWriter, r *http.Request, _ string) {
	client := &http.Client{Timeout: 3 * time.Second}
	probe := func(url string) (string, int) {
		start := time.Now()
		resp, err := client.Get(url)
		if err != nil {
			return "stopped", 0
		}
		resp.Body.Close()
		if resp.StatusCode >= 500 {
			return "crashed", int(time.Since(start).Milliseconds())
		}
		return "running", int(time.Since(start).Milliseconds())
	}
	apiStatus, _ := probe(envOr("PHP_API_URL", "http://api:9000") + "/api/health")
	discordStatus, latency := probe("https://discord.com/api/v10/gateway")
	items := []map[string]any{
		{"key": "api", "kind": "service", "status": apiStatus},
	}
	if s.php != nil {
		var fromPHP struct {
			Items []map[string]any `json:"items"`
		}
		if err := s.php.do(r.Context(), http.MethodGet, "/internal/processes", nil, &fromPHP); err == nil {
			items = append(items, fromPHP.Items...)
		} else {
			items = append(items, map[string]any{"key": "botcore", "kind": "service", "status": "stopped"}, map[string]any{"key": "database", "kind": "database", "status": "stopped"})
		}
	}
	items = append(items, map[string]any{"key": "discord_api", "kind": "external", "status": discordStatus, "latencyMs": latency})
	writeJSON(w, 200, map[string]any{"items": items})
}
