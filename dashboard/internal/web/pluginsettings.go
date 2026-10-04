package web

import (
	"encoding/json"
	"fmt"
	"net/http"

	"github.com/Kljub/BothubV3/dashboard/internal/api"
)

// Settings page of an installed plugin. The form comes from the manifest's
// "settings" block (same format as shared/module-settings) and is rendered
// by the module settings renderer; plugins ship no HTML, CSS or JS. Labels
// are the plugin's own texts "plugin.<id>.setting.<key>".

type pluginManifest struct {
	Settings *struct {
		Fields []settingsField `json:"fields"`
	} `json:"settings"`
}

// pluginSchema reads the settings schema from a plugin manifest.
func pluginSchema(pl api.InstalledPlugin) (settingsSchema, bool) {
	var m pluginManifest
	if len(pl.Manifest) == 0 || json.Unmarshal(pl.Manifest, &m) != nil || m.Settings == nil || len(m.Settings.Fields) == 0 {
		return settingsSchema{}, false
	}
	return settingsSchema{Module: pl.ID, Fields: m.Settings.Fields}, true
}

// pluginScope is the settings form of one plugin on one bot.
func (s *Server) pluginScope(botID int64, pl api.InstalledPlugin, sc settingsSchema) settingsScope {
	return settingsScope{
		Schema:      sc,
		LabelPrefix: "plugin." + pl.ID + ".setting.",
		URLBase:     fmt.Sprintf("/bot/%d/plugins/%s/settings", botID, pl.ID),
		FileBase:    fmt.Sprintf("/bot/%d/plugins/%s/files", botID, pl.ID),
		load: func(r *http.Request) (map[string]any, error) {
			var cfg map[string]any
			err := s.api.PluginConfigRaw(r.Context(), session(r), botID, pl.ID, &cfg)
			return cfg, err
		},
		save: func(r *http.Request, cfg map[string]any) error {
			var out map[string]any
			return s.api.SetPluginConfigRaw(r.Context(), session(r), botID, pl.ID, cfg, &out)
		},
	}
}

// findPlugin loads the bot's plugins (which also refreshes their texts) and
// returns the one with the given ID.
func (s *Server) findPlugin(r *http.Request, botID int64, id string) (pluginView, bool, error) {
	plugins, err := s.pluginViews(r, botID)
	if err != nil {
		return pluginView{}, false, err
	}
	for _, pl := range plugins {
		if pl.ID == id {
			return pl, true, nil
		}
	}
	return pluginView{}, false, nil
}

func (s *Server) pluginSettingsScope(w http.ResponseWriter, r *http.Request, p Page, botID int64) (settingsScope, bool) {
	pl, found, err := s.findPlugin(r, botID, r.PathValue("plugin"))
	if err != nil {
		s.failTo(w, r, p, err, "#modset-error")
		return settingsScope{}, false
	}
	sc, ok := pluginSchema(pl.InstalledPlugin)
	if !found || !ok {
		s.fail(w, r, p, &api.Error{Status: http.StatusNotFound, Key: "error.module.no_settings"})
		return settingsScope{}, false
	}
	return s.pluginScope(botID, pl.InstalledPlugin, sc), true
}

// pluginSettingsData is the settings view for the plugin page, if the
// plugin has settings.
func (s *Server) pluginSettingsData(r *http.Request, botID int64, pl api.InstalledPlugin) (*settingsView, error) {
	sc, ok := pluginSchema(pl)
	if !ok {
		return nil, nil
	}
	v, err := s.scopeData(r, botID, s.pluginScope(botID, pl, sc))
	if err != nil {
		return nil, err
	}
	return &v, nil
}

func (s *Server) handlePluginSettingsSave(w http.ResponseWriter, r *http.Request, p Page) {
	s.settingsSave(w, r, p, s.pluginSettingsScope)
}

func (s *Server) handlePluginSettingsItem(w http.ResponseWriter, r *http.Request, p Page) {
	s.settingsItem(w, r, p, s.pluginSettingsScope)
}
