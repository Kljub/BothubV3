// Command dashboard serves the BotHub web UI.
//
// Phase 0 skeleton: health endpoint only. Routing, templates, i18n and the
// /api proxy follow in phase 1 (see plan.md).
package main

import (
	"log/slog"
	"net/http"
	"os"
)

func main() {
	addr := envOr("LISTEN_ADDR", ":8080")

	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		_, _ = w.Write([]byte("ok"))
	})

	slog.Info("dashboard listening", "addr", addr, "api_url", os.Getenv("API_URL"))
	if err := http.ListenAndServe(addr, mux); err != nil {
		slog.Error("dashboard stopped", "err", err)
		os.Exit(1)
	}
}

func envOr(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}
