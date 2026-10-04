package web

import (
	"encoding/json"
	"net/http"
	"slices"
	"strings"

	"github.com/Kljub/BothubV3/dashboard/internal/api"
)

// "API / Secrets" in two places. User settings: the user's own secrets and
// integrations (name, value, description; write-only); their bots, modules
// and plugins use them, other users never do. Admin settings: the
// instance's own secret, the market GitHub token. An address is a secret
// too: plugins and the API Request block take the address and the key from
// secrets by name. The page never shows a secret value.

// secretScope: which secrets a page shows and where its forms go.
type secretScope struct {
	User   bool   // own secrets (else the instance's)
	Base   string // form target of secrets: /account/secrets or /admin/secrets
	Integ  string // form target of integrations (user only)
	Target string // element the forms swap
}

var (
	userSecrets  = secretScope{User: true, Base: "/account/secrets", Integ: "/account/integrations", Target: "#user-secrets-body"}
	adminSecrets = secretScope{Base: "/admin/secrets", Target: "#secrets-body"}
)

func (s *Server) listSecrets(r *http.Request, sc secretScope) ([]api.GlobalSecret, error) {
	if sc.User {
		return s.api.UserSecrets(r.Context(), session(r))
	}
	return s.api.GlobalSecrets(r.Context(), session(r))
}

func (s *Server) saveSecret(r *http.Request, sc secretScope, key, description string, value *string) error {
	if sc.User {
		return s.api.SaveUserSecret(r.Context(), session(r), key, description, value)
	}
	return s.api.SaveGlobalSecret(r.Context(), session(r), key, description, value)
}

func (s *Server) deleteSecret(r *http.Request, sc secretScope, key string) error {
	if sc.User {
		return s.api.DeleteUserSecret(r.Context(), session(r), key)
	}
	return s.api.DeleteGlobalSecret(r.Context(), session(r), key)
}

type secretsView struct {
	secretScope
	Secrets []secretRow
	// Market is the GitHub token for the private plugin market (own row,
	// not in Secrets); nil when it is not set.
	Market *secretRow
	// Integrations: API apps with client ID and client secret (Spotify, Twitch).
	Integrations []integrationRow
	Notice       string
}

// integration is an external API whose app credentials the admin enters
// once; modules and plugins use them by the secret names.
type integration struct {
	Key, Name, Icon, Console string
	IDKey, SecretKey         string
	// RedirectPath: OAuth callback of this BotHub (shown as full URL to copy
	// into the provider's console); empty when the API needs none.
	RedirectPath string
}

var integrations = []integration{
	{Key: "spotify", Name: "Spotify", Icon: "🎵", Console: "https://developer.spotify.com/dashboard", IDKey: "SPOTIFY_CLIENT_ID", SecretKey: "SPOTIFY_CLIENT_SECRET"},
	{Key: "twitch", Name: "Twitch", Icon: "📺", Console: "https://dev.twitch.tv/console/apps", IDKey: "TWITCH_CLIENT_ID", SecretKey: "TWITCH_CLIENT_SECRET"},
	{Key: "google", Name: "Google OAuth", Icon: "🔐", Console: "https://console.cloud.google.com/apis/credentials", IDKey: "GOOGLE_OAUTH_CLIENT_ID", SecretKey: "GOOGLE_OAUTH_CLIENT_SECRET",
		RedirectPath: "/auth/oauth/google/callback"},
	{Key: "github", Name: "GitHub OAuth", Icon: "🐙", Console: "https://github.com/settings/developers", IDKey: "GITHUB_OAUTH_CLIENT_ID", SecretKey: "GITHUB_OAUTH_CLIENT_SECRET",
		RedirectPath: "/auth/oauth/github/callback"},
	{Key: "kick", Name: "Kick", Icon: "🟢", Console: "https://kick.com/settings/developer", IDKey: "KICK_CLIENT_ID", SecretKey: "KICK_CLIENT_SECRET"},
}

// integrationRow: the stored client ID and secret (nil when not set).
type integrationRow struct {
	integration
	ID, Secret *secretRow
	// RedirectURI: the full callback URL (domain of this dashboard + RedirectPath).
	RedirectURI string
}

// Set: both values are stored.
func (r integrationRow) Set() bool { return r.ID != nil && r.Secret != nil }

func integrationByKey(key string) (integration, bool) {
	for _, in := range integrations {
		if in.Key == key {
			return in, true
		}
	}
	return integration{}, false
}

// marketTokenKey is the secret the API sends to GitHub when it reads the
// market index and plugin zips (api/public/index.php, PluginStore).
const marketTokenKey = "MARKET_GITHUB_TOKEN"

type secretRow struct {
	api.GlobalSecret
	Updated string
	// Address: the name says it holds an address (…_URL, …_URL_2).
	Address bool
	// UsedBy: names of the plugins it is shared with.
	UsedBy []string
}

// isAddressKey reports whether a secret name marks an address (PLEX_URL, PLEX_URL_2).
func isAddressKey(key string) bool {
	return strings.HasSuffix(key, "_URL") || strings.Contains(key, "_URL_")
}

func (s *Server) secretsData(r *http.Request, p Page, sc secretScope) (secretsView, error) {
	secrets, err := s.listSecrets(r, sc)
	if err != nil {
		return secretsView{}, err
	}
	v := secretsView{secretScope: sc}
	if !sc.User {
		// The instance keeps the market token only.
		for _, x := range secrets {
			if x.Key == marketTokenKey {
				v.Market = &secretRow{GlobalSecret: x, Updated: formatDateTime(x.UpdatedAt, p.Locale)}
			}
		}
		return v, nil
	}
	// Which plugins each secret is shared with (App Store shares).
	usedBy := map[string][]string{}
	if plugins, err := s.api.AdminPlugins(r.Context(), session(r)); err == nil {
		for _, pl := range plugins {
			var m struct {
				Name string `json:"name"`
			}
			_ = json.Unmarshal(pl.Manifest, &m)
			if m.Name == "" {
				m.Name = pl.ID
			}
			for key, share := range pl.SecretShares {
				if share.Shared {
					usedBy[key] = append(usedBy[key], m.Name)
				}
			}
		}
	}
	rows := map[string]*secretRow{}
	for _, x := range secrets {
		row := secretRow{GlobalSecret: x, Updated: formatDateTime(x.UpdatedAt, p.Locale), Address: isAddressKey(x.Key), UsedBy: usedBy[x.Key]}
		slices.Sort(row.UsedBy)
		rows[x.Key] = &row
		if slices.ContainsFunc(integrations, func(in integration) bool { return in.IDKey == x.Key || in.SecretKey == x.Key }) {
			continue // shown in its integration row
		}
		v.Secrets = append(v.Secrets, row)
	}
	for _, in := range integrations {
		row := integrationRow{integration: in, ID: rows[in.IDKey], Secret: rows[in.SecretKey]}
		if in.RedirectPath != "" {
			row.RedirectURI = baseURL(r) + in.RedirectPath
		}
		v.Integrations = append(v.Integrations, row)
	}
	slices.SortFunc(v.Secrets, func(a, b secretRow) int { return strings.Compare(a.Key, b.Key) })
	return v, nil
}

func (s *Server) renderSecrets(w http.ResponseWriter, r *http.Request, p Page, sc secretScope, notice string) {
	v, err := s.secretsData(r, p, sc)
	if err != nil {
		s.failTo(w, r, p, err, sc.Target+"-error")
		return
	}
	v.Notice = notice
	s.render(w, http.StatusOK, "admin", "api_secrets_fragment", withData(p, v))
}

func secretKey(v string) string { return strings.ToUpper(strings.TrimSpace(v)) }

// scopeOf: /account/… are the user's own secrets, /admin/… the instance's.
func scopeOf(r *http.Request) secretScope {
	if strings.HasPrefix(r.URL.Path, "/account/") {
		return userSecrets
	}
	return adminSecrets
}

// handleUserSecrets renders the user's own secrets (loaded when the tab opens).
func (s *Server) handleUserSecrets(w http.ResponseWriter, r *http.Request, p Page) {
	s.renderSecrets(w, r, p, userSecrets, "")
}

// handleSecretSave creates or updates a secret. An empty value keeps the
// stored one (only when it exists; the API refuses a new secret without one).
func (s *Server) handleSecretSave(w http.ResponseWriter, r *http.Request, p Page) {
	sc := scopeOf(r)
	key := secretKey(r.PostFormValue("key"))
	if key == "" {
		key = r.PathValue("key")
	}
	var value *string
	if v := r.PostFormValue("value"); v != "" {
		value = &v
	}
	if err := s.saveSecret(r, sc, key, strings.TrimSpace(r.PostFormValue("description")), value); err != nil {
		s.failTo(w, r, p, err, sc.Target+"-error")
		return
	}
	// The value must not stay in any cache on its way back.
	w.Header().Set("Cache-Control", "no-store")
	s.renderSecrets(w, r, p, sc, "admin.secrets.saved")
}

func (s *Server) handleSecretDelete(w http.ResponseWriter, r *http.Request, p Page) {
	sc := scopeOf(r)
	if err := s.deleteSecret(r, sc, r.PathValue("key")); err != nil {
		s.failTo(w, r, p, err, sc.Target+"-error")
		return
	}
	s.renderSecrets(w, r, p, sc, "admin.secrets.deleted")
}

// handleIntegrationSave stores the client ID and client secret of an
// integration among the user's own secrets. An empty field keeps the stored
// value; a new integration needs both.
func (s *Server) handleIntegrationSave(w http.ResponseWriter, r *http.Request, p Page) {
	in, ok := integrationByKey(r.PathValue("name"))
	if !ok {
		s.fail(w, r, p, &api.Error{Status: http.StatusNotFound, Key: "error.not_found"})
		return
	}
	for _, f := range []struct{ form, key, desc string }{
		{"client_id", in.IDKey, in.Name + " Client ID"},
		{"client_secret", in.SecretKey, in.Name + " Client Secret"},
	} {
		var value *string
		if v := strings.TrimSpace(r.PostFormValue(f.form)); v != "" {
			value = &v
		}
		if err := s.saveSecret(r, userSecrets, f.key, f.desc, value); err != nil {
			s.failTo(w, r, p, err, userSecrets.Target+"-error")
			return
		}
	}
	w.Header().Set("Cache-Control", "no-store")
	s.renderSecrets(w, r, p, userSecrets, "admin.secrets.saved")
}

// handleIntegrationDelete removes both values of an integration.
func (s *Server) handleIntegrationDelete(w http.ResponseWriter, r *http.Request, p Page) {
	in, ok := integrationByKey(r.PathValue("name"))
	if !ok {
		s.fail(w, r, p, &api.Error{Status: http.StatusNotFound, Key: "error.not_found"})
		return
	}
	for _, key := range []string{in.IDKey, in.SecretKey} {
		if err := s.deleteSecret(r, userSecrets, key); err != nil && !api.IsStatus(err, http.StatusNotFound) {
			s.failTo(w, r, p, err, userSecrets.Target+"-error")
			return
		}
	}
	s.renderSecrets(w, r, p, userSecrets, "admin.secrets.deleted")
}
