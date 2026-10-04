// Command dashboard serves the BotHub web UI.
package main

import (
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	_ "time/tzdata" // chart times use TZ; the runtime image has no zoneinfo

	"github.com/Kljub/BothubV3/dashboard/internal/api"
	"github.com/Kljub/BothubV3/dashboard/internal/i18n"
	"github.com/Kljub/BothubV3/dashboard/internal/web"
	"github.com/Kljub/BothubV3/dashboard/ui"
)

func main() {
	if err := run(); err != nil {
		slog.Error("dashboard stopped", "err", err)
		os.Exit(1)
	}
}

func run() error {
	addr := envOr("LISTEN_ADDR", ":8080")

	client, err := api.New(envOr("API_URL", "http://127.0.0.1:9000"))
	if err != nil {
		return err
	}
	bundle, err := i18n.Load(ui.FS, "lang")
	if err != nil {
		return err
	}
	modules, err := web.LoadModules(filepath.Join(envOr("SHARED_DIR", "/shared"), "modules.json"))
	if err != nil {
		return err
	}

	commands, err := web.LoadCommands(
		filepath.Join(envOr("SHARED_DIR", "/shared"), "commands.json"),
		filepath.Join(envOr("SHARED_DIR", "/shared"), "command-presets.json"),
	)
	if err != nil {
		return err
	}

	nodeDefs, err := web.LoadNodeDefs(filepath.Join(envOr("SHARED_DIR", "/shared"), "nodes"))
	if err != nil {
		return err
	}

	events, err := web.LoadEvents(filepath.Join(envOr("SHARED_DIR", "/shared"), "events.json"))
	if err != nil {
		return err
	}

	docs, err := web.LoadDocs(filepath.Join(envOr("SHARED_DIR", "/shared"), "docs"))
	if err != nil {
		return err
	}

	srv, err := web.New(web.Config{
		API:           client,
		I18n:          bundle,
		UI:            ui.FS,
		DefaultLocale: envOr("BOTHUB_DEFAULT_LOCALE", i18n.Fallback),
		Modules:       modules,
		Commands:      commands,
		NodeDefs:      nodeDefs,
		Events:        events,
		Docs:          docs,
	})
	if err != nil {
		return err
	}

	slog.Info("dashboard listening", "addr", addr, "api_url", client.BaseURL().String())
	httpSrv := &http.Server{
		Addr:              addr,
		Handler:           srv,
		ReadHeaderTimeout: web.ReadHeaderTimeout,
		WriteTimeout:      web.WriteTimeout,
		IdleTimeout:       web.IdleTimeout,
	}
	return httpSrv.ListenAndServe()
}

func envOr(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}
