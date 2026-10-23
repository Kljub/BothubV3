package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync/atomic"
	"testing"
)

const (
	discordAlice = "100000000000000001"
	discordBob   = "100000000000000002"
)

// fakeDiscordOAuth answers token, user and revoke calls: code "c-<id>" is the Discord user <id>.
func fakeDiscordOAuth(t *testing.T, revoked *atomic.Int32) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == "POST" && r.URL.Path == "/oauth2/token":
			_ = r.ParseForm()
			code := r.PostForm.Get("code")
			if r.PostForm.Get("client_secret") != "sec" || r.PostForm.Get("code_verifier") == "" || !strings.HasPrefix(code, "c-") ||
				r.PostForm.Get("redirect_uri") != "https://hub.example/login/discord/callback" {
				w.WriteHeader(400)
				return
			}
			_ = json.NewEncoder(w).Encode(map[string]string{"access_token": "tok-" + strings.TrimPrefix(code, "c-")})
		case r.Method == "GET" && r.URL.Path == "/users/@me":
			id := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer tok-")
			_ = json.NewEncoder(w).Encode(map[string]string{"id": id, "username": "user" + id[len(id)-1:]})
		case r.Method == "POST" && r.URL.Path == "/oauth2/token/revoke":
			revoked.Add(1)
		default:
			w.WriteHeader(404)
		}
	}))
}

func TestDiscordLogin(t *testing.T) {
	var revoked atomic.Int32
	fake := fakeDiscordOAuth(t, &revoked)
	defer fake.Close()
	s := &store{tickets: map[string]loginTicket{}, sessions: map[string]*sessionData{}, discordStates: map[string]discordState{},
		devices: map[string]*mobileDevice{}, approvals: map[string]*loginApproval{}}
	s.srvSettings = defaultServerSettings()
	s.seedUsers()
	plain := &mockUser{ID: 1, Username: "plain", RoleID: 2}
	secure := &mockUser{ID: 2, Username: "secure", RoleID: 2, totpSecret: "JBSWY3DPEHPK3PXP"}
	s.users = append(s.users, plain, secure)
	s.discord = newDiscordClient(fake.URL)
	s.discordLogin = discordLoginSettings{Enabled: true, ClientID: "222222222222222222", secret: "sec", SecretSet: true, TrustKnownIP: true, TrustDays: 30}
	const redirect = "https://hub.example/login/discord/callback"

	req := func(method, body, ip string, user int64) *http.Request {
		r := httptest.NewRequest(method, "/x", strings.NewReader(body))
		r.Header.Set("Content-Type", "application/json")
		r.Header.Set("X-BotHub-Client-IP", ip)
		if user != 0 {
			r = r.WithContext(withUser(r.Context(), user))
		}
		return r
	}
	begin := func(link bool, user int64) string {
		w := httptest.NewRecorder()
		body := `{"redirectUri":"` + redirect + `"}`
		if link {
			s.discordLinkBegin(w, req("POST", body, "203.0.113.1", user), "")
		} else {
			s.discordBegin(w, req("POST", body, "203.0.113.1", 0))
		}
		var out struct{ State, URL string }
		_ = json.Unmarshal(w.Body.Bytes(), &out)
		if w.Code != 200 || out.State == "" {
			t.Fatalf("begin: %d %s", w.Code, w.Body)
		}
		u, _ := url.Parse(out.URL)
		q := u.Query()
		if q.Get("client_id") != "222222222222222222" || q.Get("code_challenge_method") != "S256" || q.Get("scope") != "identify" || q.Get("redirect_uri") != redirect {
			t.Fatalf("authorize address: %s", out.URL)
		}
		return out.State
	}
	login := func(discordID, ip string) *httptest.ResponseRecorder {
		w := httptest.NewRecorder()
		s.discordFinish(w, req("POST", `{"state":"`+begin(false, 0)+`","code":"c-`+discordID+`"}`, ip, 0))
		return w
	}
	errKey := func(w *httptest.ResponseRecorder) string {
		var e struct{ Error struct{ Key string } }
		_ = json.Unmarshal(w.Body.Bytes(), &e)
		return e.Error.Key
	}

	// Not linked yet: no account is made.
	if w := login(discordAlice, "203.0.113.10"); w.Code != 401 || errKey(w) != "error.auth.discord_unknown" {
		t.Fatalf("unknown Discord account: %d %s", w.Code, w.Body)
	}
	// Linking.
	link := func(user int64, discordID string) *httptest.ResponseRecorder {
		w := httptest.NewRecorder()
		s.discordLinkFinish(w, req("POST", `{"state":"`+begin(true, user)+`","code":"c-`+discordID+`"}`, "203.0.113.1", user), "")
		return w
	}
	if w := link(1, discordAlice); w.Code != 200 || plain.discordID != discordAlice || plain.discordName != "user1" {
		t.Fatalf("link: %d %s", w.Code, w.Body)
	}
	if w := link(2, discordAlice); w.Code != 409 {
		t.Fatalf("a Discord account linked twice: %d", w.Code)
	}
	if w := link(2, discordBob); w.Code != 200 {
		t.Fatalf("link 2: %d", w.Code)
	}
	// A state of the link flow does not sign in, a state works once.
	w := httptest.NewRecorder()
	state := begin(true, 1)
	s.discordFinish(w, req("POST", `{"state":"`+state+`","code":"c-`+discordAlice+`"}`, "203.0.113.10", 0))
	if w.Code != 401 || errKey(w) != "error.auth.discord_expired" {
		t.Fatalf("link state signed in: %d %s", w.Code, w.Body)
	}

	// Without 2FA: signed in.
	if w := login(discordAlice, "203.0.113.10"); w.Code != 200 || len(w.Result().Cookies()) == 0 {
		t.Fatalf("sign-in: %d %s", w.Code, w.Body)
	}
	// With 2FA: asked on a new address …
	if w := login(discordBob, "198.51.100.7"); w.Code != 401 || errKey(w) != "error.auth.totp_required" {
		t.Fatalf("2FA not asked: %d %s", w.Code, w.Body)
	}
	// … not on an address that finished a sign-in with 2FA.
	s.trustIP(secure, req("POST", "", "198.51.100.7", 0))
	if w := login(discordBob, "198.51.100.7"); w.Code != 200 {
		t.Fatalf("known address: %d %s", w.Code, w.Body)
	}
	if w := login(discordBob, "198.51.100.8"); w.Code != 401 || errKey(w) != "error.auth.totp_required" {
		t.Fatalf("other address: %d", w.Code)
	}
	// The admin switch makes every address ask.
	s.discordLogin.TrustKnownIP = false
	if w := login(discordBob, "198.51.100.7"); w.Code != 401 {
		t.Fatalf("trust switched off: %d", w.Code)
	}
	if revoked.Load() < 5 {
		t.Fatalf("tokens not revoked: %d", revoked.Load())
	}
	// Unlink, then the sign-in is refused; switched off, nothing starts.
	s.discordUnlink(httptest.NewRecorder(), req("DELETE", "", "203.0.113.1", 1), "")
	if w := login(discordAlice, "203.0.113.11"); w.Code != 401 || errKey(w) != "error.auth.discord_unknown" {
		t.Fatalf("after unlink: %d", w.Code)
	}
	s.discordLogin.Enabled = false
	w = httptest.NewRecorder()
	s.discordBegin(w, req("POST", `{"redirectUri":"`+redirect+`"}`, "203.0.113.1", 0))
	if w.Code != 404 {
		t.Fatalf("switched off: %d", w.Code)
	}
}

func TestDiscordLoginSettings(t *testing.T) {
	s := &store{}
	s.discordLogin = defaultDiscordLogin()
	put := func(body string) *httptest.ResponseRecorder {
		w := httptest.NewRecorder()
		r := httptest.NewRequest("PUT", "/x", strings.NewReader(body))
		r.Header.Set("Content-Type", "application/json")
		s.putDiscordLogin(w, r, "")
		return w
	}
	if w := put(`{"enabled":true,"clientId":"222222222222222222","trustDays":30}`); w.Code != 422 {
		t.Fatalf("on without secret: %d", w.Code)
	}
	if w := put(`{"enabled":true,"clientId":"abc","secret":"x","trustDays":30}`); w.Code != 422 {
		t.Fatalf("bad client ID: %d", w.Code)
	}
	w := put(`{"enabled":true,"clientId":"222222222222222222","secret":"sec","trustKnownIp":true,"trustDays":0}`)
	if w.Code != 200 || strings.Contains(w.Body.String(), "sec\"") || !s.discordLogin.SecretSet || s.discordLogin.TrustDays != 30 {
		t.Fatalf("save: %d %s", w.Code, w.Body)
	}
	// No secret field: the saved one stays.
	if w := put(`{"enabled":true,"clientId":"222222222222222222","trustDays":7}`); w.Code != 200 || s.discordLogin.secret != "sec" || s.discordLogin.TrustDays != 7 {
		t.Fatalf("keep secret: %d", w.Code)
	}
	if !validRedirect("https://hub.example/login/discord/callback") || validRedirect("https://evil.example/other") || validRedirect("javascript:alert(1)") {
		t.Fatal("redirect check")
	}
}
