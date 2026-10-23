package main

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// Sign in with Discord (Admin → Security Policies, settings key
// "discord"). The admin adds an own Discord application for the sign-in
// (client ID and secret; the secret is encrypted by the PHP API like the SMTP
// password). A Discord account never creates a BotHub account: each user
// links their Discord account in the account settings first.
//
// Flow: begin hands out the Discord address (scope identify, state, PKCE),
// finish trades the code for a token, reads the Discord user ID and revokes
// the token at once. 2FA stays: an account with 2FA gets the same ticket as
// after a right password, unless "trust known addresses" is on and the
// address finished a sign-in with 2FA (or a passkey) in the last TrustDays.
// Only hashes of these addresses are kept.

type discordLoginSettings struct {
	Enabled      bool   `json:"enabled"`
	ClientID     string `json:"clientId"`
	SecretSet    bool   `json:"secretSet"`
	TrustKnownIP bool   `json:"trustKnownIp"`
	TrustDays    int    `json:"trustDays"`
	secret       string
}

// discordState: one started Discord sign-in or link, kept until finish.
type discordState struct {
	link     bool  // link the Discord account to userID instead of signing in
	userID   int64 // link only
	opts     sessionOpts
	verifier string // PKCE
	redirect string
	expires  time.Time
}

const (
	discordStateTTL    = 10 * time.Minute
	maxDiscordStates   = 500
	maxTrustedIPs      = 20
	discordAuthorize   = "https://discord.com/oauth2/authorize"
	discordCallbackEnd = "/login/discord/callback"
)

var (
	clientIDPattern      = regexp.MustCompile(`^\d{17,20}$`)
	discordUserIDPattern = regexp.MustCompile(`^\d{17,20}$`)
)

func defaultDiscordLogin() discordLoginSettings {
	return discordLoginSettings{TrustKnownIP: true, TrustDays: 30}
}

// ready: the button is shown and sign-ins work. Caller holds s.mu.
func (s *store) discordLoginReady() bool {
	c := s.discordLogin
	return c.Enabled && c.ClientID != "" && c.secret != ""
}

// --- admin settings ---

func (s *store) getDiscordLogin(w http.ResponseWriter, r *http.Request, _ string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	writeJSON(w, 200, s.discordLogin)
}

func (s *store) putDiscordLogin(w http.ResponseWriter, r *http.Request, _ string) {
	var in struct {
		discordLoginSettings
		Secret *string `json:"secret"`
	}
	if !readJSON(w, r, &in) {
		return
	}
	in.ClientID = strings.TrimSpace(in.ClientID)
	if in.ClientID != "" && !clientIDPattern.MatchString(in.ClientID) {
		apiError(w, 422, "error.discord_login.client_id")
		return
	}
	if in.TrustDays < 1 || in.TrustDays > 365 {
		in.TrustDays = defaultDiscordLogin().TrustDays
	}
	if in.Secret != nil {
		*in.Secret = strings.TrimSpace(*in.Secret)
		if len(*in.Secret) > 200 {
			apiError(w, 422, "error.validation.failed")
			return
		}
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	secret := s.discordLogin.secret
	if in.Secret != nil {
		secret = *in.Secret
	}
	if in.Enabled && (in.ClientID == "" || secret == "") {
		apiError(w, 422, "error.discord_login.incomplete")
		return
	}
	next := in.discordLoginSettings
	next.secret, next.SecretSet = secret, secret != ""
	s.discordLogin = next
	s.persistDiscordLogin(in.Secret)
	writeJSON(w, 200, s.discordLogin)
}

// persistDiscordLogin stores the settings; the secret only when it changed. Caller holds s.mu.
func (s *store) persistDiscordLogin(secret *string) {
	if s.php == nil {
		return
	}
	c := s.discordLogin
	body := map[string]any{"enabled": c.Enabled, "clientId": c.ClientID, "trustKnownIp": c.TrustKnownIP, "trustDays": c.TrustDays}
	if secret != nil {
		body["password"] = *secret
	}
	go s.phpSync(http.MethodPut, "/internal/settings/discord", body)
}

func (s *store) loadDiscordLogin() {
	s.discordLogin = defaultDiscordLogin()
	if s.php == nil {
		return
	}
	var out struct {
		Value *struct {
			discordLoginSettings
			Password string `json:"password"`
		}
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := s.php.do(ctx, http.MethodGet, "/internal/settings/discord", nil, &out); err != nil {
		slog.Error("mockapi: discord login settings not loaded", "err", err)
		return
	}
	if out.Value == nil || out.Value.TrustDays == 0 {
		return // never saved: the defaults stay
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.discordLogin = out.Value.discordLoginSettings
	s.discordLogin.secret, s.discordLogin.SecretSet = out.Value.Password, out.Value.Password != ""
}

// --- known addresses ---

// ipHash: what is kept of an address that finished a sign-in with 2FA.
func ipHash(userID int64, ip string) string {
	sum := sha256.Sum256([]byte("bothub-trusted-ip:" + strconv.FormatInt(userID, 10) + ":" + strings.TrimSpace(ip)))
	return hex.EncodeToString(sum[:16])
}

// trustIP remembers the request's address after a sign-in with a second
// factor or a passkey. Caller holds s.mu.
func (s *store) trustIP(u *mockUser, r *http.Request) {
	if u == nil {
		return
	}
	now := time.Now().UTC()
	if u.trustedIPs == nil {
		u.trustedIPs = map[string]time.Time{}
	}
	u.trustedIPs[ipHash(u.ID, clientIP(r))] = now
	// Drop expired entries, then the oldest beyond the limit.
	for h, at := range u.trustedIPs {
		if now.Sub(at) > 365*24*time.Hour {
			delete(u.trustedIPs, h)
		}
	}
	for len(u.trustedIPs) > maxTrustedIPs {
		oldest, at := "", now
		for h, t := range u.trustedIPs {
			if t.Before(at) {
				oldest, at = h, t
			}
		}
		delete(u.trustedIPs, oldest)
	}
	s.persistUser(u)
}

// knownIP: the address finished a sign-in with 2FA within the trust days. Caller holds s.mu.
func (s *store) knownIP(u *mockUser, ip string) bool {
	at, ok := u.trustedIPs[ipHash(u.ID, ip)]
	days := s.discordLogin.TrustDays
	if days < 1 {
		days = defaultDiscordLogin().TrustDays
	}
	return ok && time.Since(at) <= time.Duration(days)*24*time.Hour
}

// --- sign-in and linking ---

// discordLoginStatus: public, the login page asks whether to show the button.
func (s *store) discordLoginStatus(w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	defer s.mu.Unlock()
	writeJSON(w, 200, map[string]bool{"enabled": s.discordLoginReady()})
}

func validRedirect(v string) bool {
	u, err := url.Parse(v)
	return err == nil && (u.Scheme == "https" || u.Scheme == "http") && u.Host != "" && u.Path == discordCallbackEnd && u.RawQuery == "" && len(v) <= 300
}

// newDiscordState stores a started flow and returns the Discord address. Caller holds s.mu.
func (s *store) newDiscordState(st discordState) (string, string) {
	now := time.Now()
	for k, v := range s.discordStates {
		if now.After(v.expires) {
			delete(s.discordStates, k)
		}
	}
	if len(s.discordStates) >= maxDiscordStates {
		for k := range s.discordStates {
			delete(s.discordStates, k)
			break
		}
	}
	state := randomHex(24)
	st.verifier = randomHex(32)
	st.expires = now.Add(discordStateTTL)
	s.discordStates[state] = st
	challenge := sha256.Sum256([]byte(st.verifier))
	q := url.Values{
		"response_type":         {"code"},
		"client_id":             {s.discordLogin.ClientID},
		"scope":                 {"identify"},
		"state":                 {state},
		"redirect_uri":          {st.redirect},
		"prompt":                {"none"},
		"code_challenge":        {base64.RawURLEncoding.EncodeToString(challenge[:])},
		"code_challenge_method": {"S256"},
	}
	return state, discordAuthorize + "?" + q.Encode()
}

// takeDiscordState hands out a started flow once; the code is traded with
// the redirect address of the start (Discord wants the same). Caller holds s.mu.
func (s *store) takeDiscordState(state string) (discordState, bool) {
	st, ok := s.discordStates[state]
	delete(s.discordStates, state)
	if !ok || time.Now().After(st.expires) {
		return discordState{}, false
	}
	return st, true
}

func (s *store) discordBegin(w http.ResponseWriter, r *http.Request) {
	var in struct {
		RedirectURI string `json:"redirectUri"`
		sessionOpts
	}
	if !readJSON(w, r, &in) {
		return
	}
	if !validRedirect(in.RedirectURI) {
		apiError(w, 422, "error.validation.failed")
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if !s.discordLoginReady() {
		apiError(w, 404, "error.discord_login.off")
		return
	}
	state, link := s.newDiscordState(discordState{opts: in.sessionOpts, redirect: in.RedirectURI})
	writeJSON(w, 200, map[string]string{"state": state, "url": link})
}

func (s *store) discordLinkBegin(w http.ResponseWriter, r *http.Request, _ string) {
	var in struct {
		RedirectURI string `json:"redirectUri"`
	}
	if !readJSON(w, r, &in) {
		return
	}
	if !validRedirect(in.RedirectURI) {
		apiError(w, 422, "error.validation.failed")
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if !s.discordLoginReady() {
		apiError(w, 404, "error.discord_login.off")
		return
	}
	state, link := s.newDiscordState(discordState{link: true, userID: userFrom(r.Context()), redirect: in.RedirectURI})
	writeJSON(w, 200, map[string]string{"state": state, "url": link})
}

type discordFinishIn struct {
	State string `json:"state"`
	Code  string `json:"code"`
}

// discordFinish signs in with a linked Discord account.
func (s *store) discordFinish(w http.ResponseWriter, r *http.Request) {
	var in discordFinishIn
	if !readJSON(w, r, &in) {
		return
	}
	ip := clientIP(r)
	if wait := logins.blocked(ip, ""); wait > 0 {
		apiErrorParams(w, 429, "error.auth.too_many_attempts", map[string]any{"minutes": wait})
		return
	}
	s.mu.Lock()
	st, ok := s.takeDiscordState(in.State)
	cfg := s.discordLogin
	ready := s.discordLoginReady()
	s.mu.Unlock()
	if !ok || st.link || !ready {
		apiError(w, 401, "error.auth.discord_expired")
		return
	}
	who, err := s.discordIdentify(r.Context(), cfg, in.Code, st)
	if err != nil {
		slog.Warn("mockapi: discord sign-in failed", "err", err)
		apiError(w, 502, "error.auth.discord_failed")
		return
	}
	s.mu.Lock()
	var u *mockUser
	for _, x := range s.users {
		if x.discordID != "" && x.discordID == who.ID {
			u = x
		}
	}
	if u == nil || s.roleKey(u.RoleID) == "banned" {
		s.mu.Unlock()
		logins.failed(ip, "")
		apiError(w, 401, "error.auth.discord_unknown")
		return
	}
	if u.discordName != who.Name {
		u.discordName = who.Name
		s.persistUser(u)
	}
	// 2FA stays, except on an address that finished a sign-in with 2FA lately (setting).
	if (u.totpSecret != "" || len(s.guardDevices(u.ID)) > 0) && !(cfg.TrustKnownIP && s.knownIP(u, ip)) {
		ticket := s.newTicket(u.ID, st.opts)
		params := map[string]any{"ticket": ticket, "totp": u.totpSecret != ""}
		if len(s.guardDevices(u.ID)) > 0 {
			params["guard"] = true
			params["approval"] = s.newApproval(ticket, u.ID, r).ID
		}
		s.mu.Unlock()
		apiErrorParams(w, 401, "error.auth.totp_required", params)
		return
	}
	s.mu.Unlock()
	logins.succeeded(ip, u.Username)
	s.startSession(w, r, 200, u.ID, st.opts)
}

// discordLinkFinish links the Discord account to the signed-in user.
func (s *store) discordLinkFinish(w http.ResponseWriter, r *http.Request, _ string) {
	var in discordFinishIn
	if !readJSON(w, r, &in) {
		return
	}
	me := userFrom(r.Context())
	s.mu.Lock()
	st, ok := s.takeDiscordState(in.State)
	cfg := s.discordLogin
	s.mu.Unlock()
	if !ok || !st.link || st.userID != me {
		apiError(w, 401, "error.auth.discord_expired")
		return
	}
	who, err := s.discordIdentify(r.Context(), cfg, in.Code, st)
	if err != nil {
		slog.Warn("mockapi: discord link failed", "err", err)
		apiError(w, 502, "error.auth.discord_failed")
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, x := range s.users {
		if x.ID != me && x.discordID == who.ID {
			apiError(w, 409, "error.auth.discord_taken")
			return
		}
	}
	u := s.userByID(me)
	if u == nil {
		apiError(w, 401, "error.auth.required")
		return
	}
	u.discordID, u.discordName = who.ID, who.Name
	s.persistUser(u)
	writeJSON(w, 200, map[string]string{"discordId": who.ID, "discordName": who.Name})
}

func (s *store) discordUnlink(w http.ResponseWriter, r *http.Request, _ string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if u := s.userByID(userFrom(r.Context())); u != nil && u.discordID != "" {
		u.discordID, u.discordName = "", ""
		s.persistUser(u)
	}
	w.WriteHeader(204)
}

type discordIdentity struct {
	ID   string
	Name string
}

// discordIdentify trades the code for a token, reads the user and revokes the token.
func (s *store) discordIdentify(ctx context.Context, cfg discordLoginSettings, code string, st discordState) (discordIdentity, error) {
	if code == "" || len(code) > 200 {
		return discordIdentity{}, fmt.Errorf("no code")
	}
	base := discordAPI
	if s.discord != nil {
		base = s.discord.base
	}
	client := &http.Client{Timeout: 10 * time.Second}
	form := func(path string, v url.Values, out any) error {
		req, err := http.NewRequestWithContext(ctx, http.MethodPost, base+path, strings.NewReader(v.Encode()))
		if err != nil {
			return err
		}
		req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
		res, err := client.Do(req)
		if err != nil {
			return err
		}
		defer res.Body.Close()
		body, _ := io.ReadAll(io.LimitReader(res.Body, 64<<10))
		if res.StatusCode != 200 {
			return fmt.Errorf("%s: status %d", path, res.StatusCode)
		}
		if out != nil {
			return json.Unmarshal(body, out)
		}
		return nil
	}
	var tok struct {
		AccessToken string `json:"access_token"`
	}
	err := form("/oauth2/token", url.Values{
		"client_id": {cfg.ClientID}, "client_secret": {cfg.secret}, "grant_type": {"authorization_code"},
		"code": {code}, "redirect_uri": {st.redirect}, "code_verifier": {st.verifier},
	}, &tok)
	if err != nil || tok.AccessToken == "" {
		return discordIdentity{}, fmt.Errorf("token: %v", err)
	}
	// The token is only needed for this one call.
	defer func() {
		_ = form("/oauth2/token/revoke", url.Values{"client_id": {cfg.ClientID}, "client_secret": {cfg.secret}, "token": {tok.AccessToken}}, nil)
	}()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, base+"/users/@me", nil)
	if err != nil {
		return discordIdentity{}, err
	}
	req.Header.Set("Authorization", "Bearer "+tok.AccessToken)
	res, err := client.Do(req)
	if err != nil {
		return discordIdentity{}, err
	}
	defer res.Body.Close()
	var user struct {
		ID         string  `json:"id"`
		Username   string  `json:"username"`
		GlobalName *string `json:"global_name"`
	}
	if res.StatusCode != 200 {
		return discordIdentity{}, fmt.Errorf("users/@me: status %d", res.StatusCode)
	}
	if err := json.NewDecoder(io.LimitReader(res.Body, 64<<10)).Decode(&user); err != nil || !discordUserIDPattern.MatchString(user.ID) {
		return discordIdentity{}, fmt.Errorf("users/@me: bad answer")
	}
	return discordIdentity{ID: user.ID, Name: truncate(user.Username, 40)}, nil
}
