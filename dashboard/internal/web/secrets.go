package web

import (
	"encoding/json"
	"net/http"
	"slices"
	"strings"

	"github.com/Kljub/BothubV3/dashboard/internal/api"
)

// Admin settings, tab "API / Secrets": global secrets (name, value,
// description; write-only). An address is a secret too: plugins and the API
// Request block take the address and the key from secrets by name. The page
// never shows a secret value.

type secretsView struct {
	Secrets []secretRow
	// Market is the GitHub token for the private plugin market (own row,
	// not in Secrets); nil when it is not set.
	Market *secretRow
	Notice string
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

func (s *Server) secretsData(r *http.Request, p Page) (secretsView, error) {
	secrets, err := s.api.GlobalSecrets(r.Context(), session(r))
	if err != nil {
		return secretsView{}, err
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
	var v secretsView
	for _, x := range secrets {
		row := secretRow{GlobalSecret: x, Updated: formatDateTime(x.UpdatedAt, p.Locale), Address: isAddressKey(x.Key), UsedBy: usedBy[x.Key]}
		slices.Sort(row.UsedBy)
		if x.Key == marketTokenKey {
			v.Market = &row
			continue
		}
		v.Secrets = append(v.Secrets, row)
	}
	slices.SortFunc(v.Secrets, func(a, b secretRow) int { return strings.Compare(a.Key, b.Key) })
	return v, nil
}

func (s *Server) renderSecrets(w http.ResponseWriter, r *http.Request, p Page, notice string) {
	v, err := s.secretsData(r, p)
	if err != nil {
		s.failTo(w, r, p, err, "#secrets-error")
		return
	}
	v.Notice = notice
	s.render(w, http.StatusOK, "admin", "api_secrets_fragment", withData(p, v))
}

func secretKey(v string) string { return strings.ToUpper(strings.TrimSpace(v)) }

// handleSecretSave creates or updates a secret. An empty value keeps the
// stored one (only when it exists; the API refuses a new secret without one).
func (s *Server) handleSecretSave(w http.ResponseWriter, r *http.Request, p Page) {
	key := secretKey(r.PostFormValue("key"))
	if key == "" {
		key = r.PathValue("key")
	}
	var value *string
	if v := r.PostFormValue("value"); v != "" {
		value = &v
	}
	if err := s.api.SaveGlobalSecret(r.Context(), session(r), key, strings.TrimSpace(r.PostFormValue("description")), value); err != nil {
		s.failTo(w, r, p, err, "#secrets-error")
		return
	}
	// The value must not stay in any cache on its way back.
	w.Header().Set("Cache-Control", "no-store")
	s.renderSecrets(w, r, p, "admin.secrets.saved")
}

func (s *Server) handleSecretDelete(w http.ResponseWriter, r *http.Request, p Page) {
	if err := s.api.DeleteGlobalSecret(r.Context(), session(r), r.PathValue("key")); err != nil {
		s.failTo(w, r, p, err, "#secrets-error")
		return
	}
	s.renderSecrets(w, r, p, "admin.secrets.deleted")
}
