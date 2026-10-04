package web

import (
	"encoding/json"
	"io"
	"net/http"
	"regexp"
	"slices"
	"strconv"
	"strings"

	"github.com/Kljub/BothubV3/dashboard/internal/api"
)

// Plugin management lives in the App Store (store.go): install from the
// market or a zip upload, update, endpoint sharing, uninstall. Only an admin
// does this; bot owners switch plugins on per bot. The API checks every zip
// (size, paths, manifest, lang, commands) before anything is stored.

const maxPluginZip = 5 << 20 // same limit as the API

var (
	pluginIDPattern      = regexp.MustCompile(`^plugin_[a-z0-9_]{1,57}$`)
	pluginVersionPattern = regexp.MustCompile(`^\d{1,4}\.\d{1,4}\.\d{1,6}$`)
)

// secretShareRow is one secret the plugin asks for in its manifest.
type secretShareRow struct {
	Key                 string
	Exists, Set, Shared bool
}

// manifestSummary is the part of an installed plugin's normalized manifest
// the App Store shows.
type manifestSummary struct {
	Name        string   `json:"name"`
	Description string   `json:"description"`
	Author      string   `json:"author"`
	License     string   `json:"license"`
	Icon        string   `json:"icon"`
	Category    string   `json:"category"`
	Permissions []string `json:"permissions"`
	Blocks      []any    `json:"blocks"`
	Commands    []string `json:"commands"`
	Settings    *struct {
		Fields []any `json:"fields"`
	} `json:"settings"`
	// Secrets the plugin reads by name (services.secrets, secrets.read).
	Secrets []string `json:"secrets"`
	// Connect: secret name -> sign-in provider (services.connect).
	Connect map[string]string `json:"connect"`
	Events  []string          `json:"events"`
	Tasks   []struct {
		Name  string `json:"name"`
		Every string `json:"every"`
		Cron  string `json:"cron"`
	} `json:"tasks"`
}

// installedInfo is what only an installed plugin has: hash, date, events,
// tasks and the secret shares.
type installedInfo struct {
	SHA, InstalledAt string
	Events, Tasks    []string
	Secrets          []secretShareRow
	// Enabled is the admin's switch for every bot; BlockedBy lists declared
	// SDK permissions that are off (the bot does not start the plugin).
	Enabled   bool
	BlockedBy []string
	// Connect: sign-in helpers (services.connect) with their state.
	Connect []connectRow
	// Missing: declared secrets the plugin cannot use yet (not created, still
	// empty [NULL], or not shared). Sign-in slots count only when none is
	// connected: one Plex server is enough.
	Missing []missingSecret
}

// missingSecret is one thing a plugin still needs: a secret value (Key) or
// a sign-in (Provider).
type missingSecret struct {
	Key, Provider string
}

// connectRow is one secret with a sign-in helper (e.g. PLEX_TOKEN);
// Connected means it exists and is shared with the plugin. Name is the
// server the sign-in found (description of its address secret), set by the
// store page.
type connectRow struct {
	Key, Provider string
	Connected     bool
	Name          string
}

// connectGroup is one provider with all its slots (e.g. PLEX_TOKEN …
// PLEX_TOKEN_5): the connected ones and the next free one.
type connectGroup struct {
	Provider  string
	Connected []connectRow
	Next      string // secret of the next free slot, "" when all are used
}

// connectGroups groups the slots by provider, in manifest order.
func connectGroups(rows []connectRow) []connectGroup {
	var out []connectGroup
	index := map[string]int{}
	for _, row := range rows {
		i, ok := index[row.Provider]
		if !ok {
			i = len(out)
			index[row.Provider] = i
			out = append(out, connectGroup{Provider: row.Provider})
		}
		if row.Connected {
			out[i].Connected = append(out[i].Connected, row)
		} else if out[i].Next == "" {
			out[i].Next = row.Key
		}
	}
	return out
}

// installedPlugins loads the installed plugins (texts go into the i18n
// bundle) keyed by id, with their manifest summary.
func (s *Server) installedPlugins(r *http.Request, p Page) (map[string]api.AdminPlugin, map[string]manifestSummary, error) {
	plugins, err := s.api.AdminPlugins(r.Context(), session(r))
	if err != nil {
		return nil, nil, err
	}
	byID := make(map[string]api.AdminPlugin, len(plugins))
	manifests := make(map[string]manifestSummary, len(plugins))
	for _, pl := range plugins {
		if pl.Lang != nil {
			s.i18n.SetPlugin(pl.ID, pl.Lang)
		}
		var m manifestSummary
		_ = json.Unmarshal(pl.Manifest, &m)
		// The plugin's own texts win when it ships them.
		if name := s.i18n.T(p.Locale, "plugin."+pl.ID+".name"); name != "plugin."+pl.ID+".name" {
			m.Name = name
		}
		if desc := s.i18n.T(p.Locale, "plugin."+pl.ID+".description"); desc != "plugin."+pl.ID+".description" {
			m.Description = desc
		}
		byID[pl.ID], manifests[pl.ID] = pl, m
	}
	return byID, manifests, nil
}

func installedDetails(pl api.AdminPlugin, m manifestSummary, locale string) installedInfo {
	info := installedInfo{SHA: pl.SHA256, InstalledAt: formatDateTime(pl.InstalledAt, locale), Events: m.Events, Enabled: pl.Enabled, BlockedBy: pl.BlockedBy}
	if len(info.SHA) > 12 {
		info.SHA = info.SHA[:12]
	}
	for _, t := range m.Tasks {
		if t.Cron != "" {
			info.Tasks = append(info.Tasks, t.Name+" · cron "+t.Cron)
		} else {
			info.Tasks = append(info.Tasks, t.Name+" · "+t.Every)
		}
	}
	for _, key := range m.Secrets {
		share := pl.SecretShares[key]
		info.Secrets = append(info.Secrets, secretShareRow{Key: key, Exists: share.Exists, Set: share.Set, Shared: share.Shared})
		if provider := m.Connect[key]; provider != "" {
			info.Connect = append(info.Connect, connectRow{Key: key, Provider: provider, Connected: share.Exists && share.Set && share.Shared})
		}
	}
	connected := map[string]bool{}
	for _, c := range info.Connect {
		if c.Connected {
			connected[c.Provider] = true
		}
	}
	for _, sec := range info.Secrets {
		if sec.Exists && sec.Set && sec.Shared {
			continue
		}
		if provider := m.Connect[sec.Key]; provider != "" {
			if !connected[provider] && !slices.Contains(info.Missing, missingSecret{Provider: provider}) {
				info.Missing = append(info.Missing, missingSecret{Provider: provider})
			}
			continue
		}
		if isAddressKey(sec.Key) && connectAddress(m.Connect, sec.Key) {
			continue // filled by the sign-in together with its token
		}
		info.Missing = append(info.Missing, missingSecret{Key: sec.Key})
	}
	return info
}

// newerVersion reports whether a (x.y.z) is higher than b.
func newerVersion(a, b string) bool {
	pa, pb := strings.Split(a, "."), strings.Split(b, ".")
	for i := 0; i < len(pa) && i < len(pb); i++ {
		x, _ := strconv.Atoi(pa[i])
		y, _ := strconv.Atoi(pb[i])
		if x != y {
			return x > y
		}
	}
	return len(pa) > len(pb)
}

// handleStoreUpload installs an uploaded zip and opens its detail page.
func (s *Server) handleStoreUpload(w http.ResponseWriter, r *http.Request, p Page) {
	r.Body = http.MaxBytesReader(w, r.Body, maxPluginZip+1<<20)
	file, header, err := r.FormFile("file")
	if err != nil || header.Size > maxPluginZip || !strings.HasSuffix(strings.ToLower(header.Filename), ".zip") {
		s.failTo(w, r, p, &api.Error{Status: http.StatusUnprocessableEntity, Key: "error.plugin.upload"}, "#store-upload-error")
		return
	}
	defer file.Close()
	zip, err := io.ReadAll(io.LimitReader(file, maxPluginZip+1))
	if err != nil || len(zip) > maxPluginZip {
		s.failTo(w, r, p, &api.Error{Status: http.StatusUnprocessableEntity, Key: "error.plugin.upload"}, "#store-upload-error")
		return
	}
	res, err := s.api.InstallPluginUpload(r.Context(), session(r), zip)
	if err != nil {
		s.failTo(w, r, p, err, "#store-upload-error")
		return
	}
	redirect(w, r, "/store/"+res.ID)
}

// handleStoreSecrets saves which declared secrets the plugin may read.
func (s *Server) handleStoreSecrets(w http.ResponseWriter, r *http.Request, p Page) {
	id := r.PathValue("plugin")
	if !pluginIDPattern.MatchString(id) {
		s.fail(w, r, p, &api.Error{Status: http.StatusNotFound, Key: "error.not_found"})
		return
	}
	_ = r.ParseForm()
	shared := []string{}
	for _, key := range r.PostForm["shared"] {
		if key = strings.TrimSpace(key); key != "" {
			shared = append(shared, key)
		}
	}
	if err := s.api.SharePluginSecrets(r.Context(), session(r), id, shared); err != nil {
		s.fail(w, r, p, err)
		return
	}
	s.renderStoreDetail(w, r, p, id, "admin.plugins.secrets_saved", "plugin", id)
}

// connectAddress reports whether an address secret belongs to a sign-in slot
// (PLEX_URL_2 to PLEX_TOKEN_2): the sign-in stores both.
func connectAddress(connect map[string]string, key string) bool {
	for token := range connect {
		if addressKeyFor(token) == key {
			return true
		}
	}
	return false
}
