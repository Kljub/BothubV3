package web

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/Kljub/BothubV3/dashboard/internal/api"
)

// Sign-in helpers for plugin secrets (bothub.json services.connect: token
// secret -> provider). The admin clicks "Sign in with Plex" on the plugin's
// App Store page, signs in on app.plex.tv and comes back; the dashboard then
// fetches the token, finds the Plex server and stores two secrets: the token
// (e.g. PLEX_TOKEN) and the server address (PLEX_URL), and shares both with
// the plugin. The plugin uses them with ctx.http.secret and never sees them.

var secretKeyPattern = regexp.MustCompile(`^[A-Z][A-Z0-9_]{1,39}$`)

// Plex API hosts; tests point them to a fake server.
var (
	plexTVURL      = "https://plex.tv"
	plexClientsURL = "https://clients.plex.tv"
	plexAppURL     = "https://app.plex.tv"
)

const plexProduct = "BotHub"

// connectFlow is one sign-in in progress (15 minutes), bound to the admin's session.
type connectFlow struct {
	plugin, key string
	pinID       int64
	clientID    string
	session     string // hash of the session cookie
	expires     time.Time
}

var connectFlows = struct {
	sync.Mutex
	m map[string]connectFlow
}{m: map[string]connectFlow{}}

func sessionHash(r *http.Request) string {
	sum := sha256.Sum256([]byte(session(r).Cookie))
	return hex.EncodeToString(sum[:])
}

func randomHex(n int) string {
	b := make([]byte, n)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

// connectProvider returns the provider the plugin declares for the
// secret, or "" when it declares none.
func (s *Server) connectProvider(r *http.Request, p Page, plugin, key string) (string, error) {
	installed, manifests, err := s.installedPlugins(r, p)
	if err != nil {
		return "", err
	}
	if _, ok := installed[plugin]; !ok {
		return "", &api.Error{Status: http.StatusNotFound, Key: "error.not_found"}
	}
	return manifests[plugin].Connect[key], nil
}

// handleConnectStart creates a Plex PIN and sends the browser to Plex.
func (s *Server) handleConnectStart(w http.ResponseWriter, r *http.Request, p Page) {
	plugin, key := r.PathValue("plugin"), r.PathValue("secret")
	if !pluginIDPattern.MatchString(plugin) || !secretKeyPattern.MatchString(key) {
		s.fail(w, r, p, &api.Error{Status: http.StatusNotFound, Key: "error.not_found"})
		return
	}
	provider, err := s.connectProvider(r, p, plugin, key)
	if err != nil || provider != "plex" {
		if err == nil {
			err = &api.Error{Status: http.StatusNotFound, Key: "error.not_found"}
		}
		s.fail(w, r, p, err)
		return
	}
	clientID := "bothub-" + randomHex(12)
	pin, err := plexCreatePin(r.Context(), clientID)
	if err != nil {
		slog.Warn("plex pin failed", "err", err)
		s.fail(w, r, p, &api.Error{Status: http.StatusBadGateway, Key: "error.connect.plex"})
		return
	}
	state := randomHex(16)
	connectFlows.Lock()
	for k, f := range connectFlows.m { // drop old flows
		if time.Now().After(f.expires) {
			delete(connectFlows.m, k)
		}
	}
	connectFlows.m[state] = connectFlow{plugin: plugin, key: key, pinID: pin.ID, clientID: clientID, session: sessionHash(r), expires: time.Now().Add(15 * time.Minute)}
	connectFlows.Unlock()

	back := baseURL(r) + "/store/" + plugin + "/connect/" + key + "/done?state=" + state
	to := plexAppURL + "/auth#?" + url.Values{
		"clientID":                 {clientID},
		"code":                     {pin.Code},
		"context[device][product]": {plexProduct},
		"forwardUrl":               {back},
	}.Encode()
	if isHTMX(r) {
		w.Header().Set("HX-Redirect", to)
		w.WriteHeader(http.StatusNoContent)
		return
	}
	http.Redirect(w, r, to, http.StatusSeeOther)
}

// handleConnectDone finishes the sign-in when Plex sends the browser back.
func (s *Server) handleConnectDone(w http.ResponseWriter, r *http.Request, p Page) {
	plugin, key := r.PathValue("plugin"), r.PathValue("secret")
	state := r.URL.Query().Get("state")
	connectFlows.Lock()
	flow, ok := connectFlows.m[state]
	delete(connectFlows.m, state)
	connectFlows.Unlock()
	back := "/store/" + plugin
	if !ok || flow.plugin != plugin || flow.key != key || flow.session != sessionHash(r) || time.Now().After(flow.expires) {
		http.Redirect(w, r, back+"?connect_error=expired", http.StatusSeeOther)
		return
	}
	if err := s.finishPlex(r, flow); err != nil {
		slog.Warn("plex sign-in failed", "plugin", plugin, "err", err)
		reason := "plex"
		if errors.Is(err, errNoPlexServer) {
			reason = "no_server"
		} else if errors.Is(err, errNoPlexToken) {
			reason = "no_token"
		}
		http.Redirect(w, r, back+"?connect_error="+reason, http.StatusSeeOther)
		return
	}
	http.Redirect(w, r, back+"?connected="+key, http.StatusSeeOther)
}

var (
	errNoPlexToken  = errors.New("plex: sign-in not finished")
	errNoPlexServer = errors.New("plex: no server in the account")
)

// finishPlex fetches the token and the server, then stores both secrets
// (token and address) and shares them with the plugin.
func (s *Server) finishPlex(r *http.Request, f connectFlow) error {
	ctx := r.Context()
	token, err := plexPinToken(ctx, f.clientID, f.pinID)
	if err != nil {
		return err
	}
	sess := session(r)
	// The token is kept even when no server is found (the admin enters the address as a secret).
	if err := s.api.SaveGlobalSecret(ctx, sess, f.key, "Plex token (App Store sign-in)", &token); err != nil {
		return err
	}
	server, address, err := plexServer(ctx, f.clientID, token)
	if err != nil {
		return err
	}
	addressKey := addressKeyFor(f.key)
	if err := s.api.SaveGlobalSecret(ctx, sess, addressKey, truncate("Plex server "+server, 200), &address); err != nil {
		return err
	}
	// Share both with the plugin, keeping the secrets already shared.
	plugins, err := s.api.AdminPlugins(ctx, sess)
	if err != nil {
		return err
	}
	shared := []string{f.key, addressKey}
	for _, pl := range plugins {
		if pl.ID != f.plugin {
			continue
		}
		for key, share := range pl.SecretShares {
			if share.Shared && key != f.key && key != addressKey {
				shared = append(shared, key)
			}
		}
	}
	return s.api.SharePluginSecrets(ctx, sess, f.plugin, shared)
}

// addressKeyFor names the address secret of a sign-in token secret:
// PLEX_TOKEN -> PLEX_URL, PLEX_TOKEN_2 -> PLEX_URL_2 (else <KEY>_URL).
func addressKeyFor(token string) string {
	if i := strings.LastIndex(token, "_TOKEN"); i >= 0 {
		if key := token[:i] + "_URL" + token[i+len("_TOKEN"):]; secretKeyPattern.MatchString(key) {
			return key
		}
	}
	return token + "_URL"
}

// handleConnectRemove disconnects one slot: deletes both secrets the
// sign-in stored (their shares go with them).
func (s *Server) handleConnectRemove(w http.ResponseWriter, r *http.Request, p Page) {
	plugin, key := r.PathValue("plugin"), r.PathValue("secret")
	if !pluginIDPattern.MatchString(plugin) || !secretKeyPattern.MatchString(key) {
		s.fail(w, r, p, &api.Error{Status: http.StatusNotFound, Key: "error.not_found"})
		return
	}
	provider, err := s.connectProvider(r, p, plugin, key)
	if err != nil || provider == "" {
		if err == nil {
			err = &api.Error{Status: http.StatusNotFound, Key: "error.not_found"}
		}
		s.fail(w, r, p, err)
		return
	}
	for _, k := range []string{key, addressKeyFor(key)} {
		if err := s.api.DeleteGlobalSecret(r.Context(), session(r), k); err != nil && api.AsError(err).Status != http.StatusNotFound {
			s.fail(w, r, p, err)
			return
		}
	}
	s.renderStoreDetail(w, r, p, plugin, "store.connect.removed", "secret", key)
}

func truncate(s string, n int) string {
	if len([]rune(s)) <= n {
		return s
	}
	return string([]rune(s)[:n])
}

// --- plex.tv calls ---

var plexHTTP = &http.Client{Timeout: 15 * time.Second}

func plexRequest(ctx context.Context, method, rawURL, clientID, token string, out any) error {
	req, err := http.NewRequestWithContext(ctx, method, rawURL, nil)
	if err != nil {
		return err
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("X-Plex-Product", plexProduct)
	req.Header.Set("X-Plex-Client-Identifier", clientID)
	if token != "" {
		req.Header.Set("X-Plex-Token", token)
	}
	res, err := plexHTTP.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	body, err := io.ReadAll(io.LimitReader(res.Body, 2<<20))
	if err != nil {
		return err
	}
	if res.StatusCode >= 300 {
		return fmt.Errorf("plex: %s %s: HTTP %d", method, req.URL.Path, res.StatusCode)
	}
	return json.Unmarshal(body, out)
}

type plexPin struct {
	ID        int64  `json:"id"`
	Code      string `json:"code"`
	AuthToken string `json:"authToken"`
}

func plexCreatePin(ctx context.Context, clientID string) (plexPin, error) {
	var pin plexPin
	err := plexRequest(ctx, http.MethodPost, plexTVURL+"/api/v2/pins?strong=true", clientID, "", &pin)
	if err == nil && (pin.ID == 0 || pin.Code == "") {
		err = errors.New("plex: empty pin")
	}
	return pin, err
}

// plexPinToken reads the token of a signed-in PIN; Plex may need a moment
// after the redirect, so it asks a few times.
func plexPinToken(ctx context.Context, clientID string, id int64) (string, error) {
	for try := 0; try < 5; try++ {
		var pin plexPin
		if err := plexRequest(ctx, http.MethodGet, fmt.Sprintf("%s/api/v2/pins/%d", plexTVURL, id), clientID, "", &pin); err != nil {
			return "", err
		}
		if pin.AuthToken != "" {
			return pin.AuthToken, nil
		}
		select {
		case <-ctx.Done():
			return "", ctx.Err()
		case <-time.After(time.Second):
		}
	}
	return "", errNoPlexToken
}

type plexResource struct {
	Name        string `json:"name"`
	Provides    string `json:"provides"`
	Owned       bool   `json:"owned"`
	Connections []struct {
		URI   string `json:"uri"`
		Local bool   `json:"local"`
		Relay bool   `json:"relay"`
	} `json:"connections"`
}

// plexServer picks the first server the account owns and its best address:
// a local direct connection, else any direct one, else the relay.
func plexServer(ctx context.Context, clientID, token string) (name, address string, err error) {
	var list []plexResource
	if err := plexRequest(ctx, http.MethodGet, plexClientsURL+"/api/v2/resources?includeHttps=1&includeRelay=1", clientID, token, &list); err != nil {
		return "", "", err
	}
	for _, res := range list {
		if !res.Owned || !strings.Contains(res.Provides, "server") {
			continue
		}
		for _, pass := range []func(local, relay bool) bool{
			func(local, relay bool) bool { return local && !relay },
			func(_, relay bool) bool { return !relay },
			func(_, _ bool) bool { return true },
		} {
			for _, c := range res.Connections {
				if pass(c.Local, c.Relay) && (strings.HasPrefix(c.URI, "https://") || strings.HasPrefix(c.URI, "http://")) && len(c.URI) <= 500 {
					return res.Name, c.URI, nil
				}
			}
		}
	}
	return "", "", errNoPlexServer
}
