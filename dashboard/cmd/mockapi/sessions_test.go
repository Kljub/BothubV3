package main

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// deviceKey makes a browser-like key: SPKI public key and a WebCrypto-style signer.
func deviceKey(t *testing.T) (string, func(string) string) {
	t.Helper()
	k, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	spki, _ := x509.MarshalPKIXPublicKey(&k.PublicKey)
	sign := func(challenge string) string {
		digest := sha256.Sum256([]byte(deviceProofPrefix + challenge))
		r, s, _ := ecdsa.Sign(rand.Reader, k, digest[:])
		raw := make([]byte, 64)
		r.FillBytes(raw[:32])
		s.FillBytes(raw[32:])
		return base64.RawURLEncoding.EncodeToString(raw)
	}
	return base64.RawURLEncoding.EncodeToString(spki), sign
}

func TestDeviceProof(t *testing.T) {
	pub, sign := deviceKey(t)
	if !verifyDeviceProof(pub, "abc", sign("abc")) {
		t.Fatal("good signature refused")
	}
	if verifyDeviceProof(pub, "abc", sign("other")) {
		t.Fatal("signature over another challenge accepted")
	}
	other, _ := deviceKey(t)
	if verifyDeviceProof(other, "abc", sign("abc")) {
		t.Fatal("signature of another key accepted")
	}
	if _, err := parseDeviceKey("not-a-key"); err == nil {
		t.Fatal("bad key accepted")
	}
}

func TestSessionLifecycle(t *testing.T) {
	s := &store{tickets: map[string]loginTicket{}, sessions: map[string]*sessionData{}}
	s.srvSettings = defaultServerSettings()
	s.seedUsers()
	s.users = append(s.users, &mockUser{ID: 1, Username: "admin", RoleID: 1}, &mockUser{ID: 2, Username: "other", RoleID: 2})
	pub, sign := deviceKey(t)

	start := func(userID int64, opts sessionOpts) *http.Cookie {
		w := httptest.NewRecorder()
		s.startSession(w, httptest.NewRequest("POST", "/api/v1/auth/login", nil), 200, userID, opts)
		res := w.Result()
		if res.StatusCode != 200 {
			t.Fatalf("start: %d", res.StatusCode)
		}
		return res.Cookies()[0]
	}
	call := func(c *http.Cookie, method, path, body string, h authed) *httptest.ResponseRecorder {
		r := httptest.NewRequest(method, path, strings.NewReader(body))
		r.Header.Set("Content-Type", "application/json")
		r.AddCookie(c)
		key := sessionKey(c.Value)
		if sess := s.sessions[key]; sess != nil {
			r.Header.Set("X-CSRF-Token", sess.csrf)
		}
		w := httptest.NewRecorder()
		s.auth(h)(w, r)
		return w
	}
	ok := func(w http.ResponseWriter, r *http.Request, sid string) { w.WriteHeader(204) }

	c := start(1, sessionOpts{Remember: true, DeviceKey: pub})
	if c.MaxAge != int(rememberFor/time.Second) || len(c.Value) != 64 {
		t.Fatalf("remember cookie: max-age %d, %d chars", c.MaxAge, len(c.Value))
	}
	key := sessionKey(c.Value)
	if _, raw := s.sessions[c.Value]; raw {
		t.Fatal("sessions must be kept by hash, not by cookie")
	}
	if w := call(c, "GET", "/api/v1/auth/me", "", ok); w.Code != 204 {
		t.Fatalf("fresh session: %d", w.Code)
	}

	// The proof runs out: everything but the proof routes asks for it.
	s.sessions[key].provenAt = time.Now().Add(-deviceProofWindow - time.Second)
	if w := call(c, "GET", "/api/v1/bots", "", ok); w.Code != 401 || !strings.Contains(w.Body.String(), "error.auth.device_proof") {
		t.Fatalf("stale proof: %d %s", w.Code, w.Body)
	}
	w := call(c, "GET", "/api/v1/auth/device/challenge", "", s.deviceChallenge)
	var ch struct {
		Bound     bool
		Challenge string
		CSRFToken string
	}
	_ = json.Unmarshal(w.Body.Bytes(), &ch)
	if !ch.Bound || ch.Challenge == "" || ch.CSRFToken == "" {
		t.Fatalf("challenge: %s", w.Body)
	}
	if w := call(c, "POST", "/api/v1/auth/device/proof", `{"signature":"`+sign(ch.Challenge)+`"}`, s.deviceProof); w.Code != 204 {
		t.Fatalf("proof: %d %s", w.Code, w.Body)
	}
	if w := call(c, "GET", "/api/v1/bots", "", ok); w.Code != 204 {
		t.Fatalf("after proof: %d", w.Code)
	}
	// A challenge works once.
	if w := call(c, "POST", "/api/v1/auth/device/proof", `{"signature":"`+sign(ch.Challenge)+`"}`, s.deviceProof); w.Code != 409 {
		t.Fatalf("reused challenge: %d", w.Code)
	}

	// A copied cookie on another device: wrong signature ends the session.
	s.sessions[key].provenAt = time.Time{}
	call(c, "GET", "/api/v1/auth/device/challenge", "", s.deviceChallenge)
	_, thief := deviceKey(t)
	if w := call(c, "POST", "/api/v1/auth/device/proof", `{"signature":"`+thief(s.sessions[key].challenge)+`"}`, s.deviceProof); w.Code != 401 {
		t.Fatalf("thief proof: %d", w.Code)
	}
	if s.sessions[key] != nil {
		t.Fatal("session survived a wrong proof")
	}

	// Without "stay signed in": a browser cookie and the server's session hours.
	c = start(1, sessionOpts{})
	sess := s.sessions[sessionKey(c.Value)]
	if c.MaxAge != 0 || sess.expiresAt.Sub(sess.createdAt) != time.Duration(s.srvSettings.SessionHours)*time.Hour {
		t.Fatalf("plain session: max-age %d, %v", c.MaxAge, sess.expiresAt.Sub(sess.createdAt))
	}
	sess.expiresAt = time.Now().Add(-time.Second)
	if w := call(c, "GET", "/api/v1/auth/me", "", ok); w.Code != 401 {
		t.Fatalf("expired session: %d", w.Code)
	}

	// Each user sees and ends only their own sessions.
	mine, theirs := start(1, sessionOpts{}), start(2, sessionOpts{})
	w = call(mine, "GET", "/api/v1/auth/sessions", "", s.listSessions)
	if strings.Count(w.Body.String(), `"id"`) != 1 {
		t.Fatalf("list shows other users: %s", w.Body)
	}
	call(mine, "POST", "/api/v1/auth/sessions/revoke-others", "", s.revokeOtherSessions)
	if s.sessions[sessionKey(theirs.Value)] == nil {
		t.Fatal("revoke-others ended another user's session")
	}

	// A bad device key is refused at sign-in.
	bad := httptest.NewRecorder()
	s.startSession(bad, httptest.NewRequest("POST", "/", nil), 200, 1, sessionOpts{DeviceKey: "AAAA"})
	if bad.Code != 422 {
		t.Fatalf("bad device key: %d", bad.Code)
	}
}

func TestTOTPSkew(t *testing.T) {
	secret := "JBSWY3DPEHPK3PXP"
	now := time.Now().Unix() / 30
	if !totpValid(secret, totpCode(secret, now)) {
		t.Fatal("current code refused")
	}
	if skew, ok := totpSkew(secret, totpCode(secret, now+4)); !ok || skew != 120 {
		t.Fatalf("2 minutes ahead: %d %v", skew, ok)
	}
	if _, ok := totpSkew(secret, "000000"); ok && totpCode(secret, now) != "000000" {
		t.Log("000000 happened to fit; ignore")
	}
	w := httptest.NewRecorder()
	totpError(w, 422, secret, totpCode(secret, now-6))
	if !strings.Contains(w.Body.String(), "error.auth.totp_clock") {
		t.Fatalf("clock hint missing: %s", w.Body)
	}
}

func TestCleanDomain(t *testing.T) {
	for in, want := range map[string]string{
		"gitkljub.com":                   "gitkljub.com",
		" https://GitKljub.com/ ":        "gitkljub.com",
		"http://bot.example.org/admin?x": "bot.example.org",
		"example.com.":                   "example.com",
		"":                               "",
	} {
		if got := cleanDomain(in); got != want {
			t.Errorf("cleanDomain(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestRegistration(t *testing.T) {
	s := &store{tickets: map[string]loginTicket{}, sessions: map[string]*sessionData{}}
	s.srvSettings = defaultServerSettings()
	s.seedUsers()
	s.users = append(s.users, &mockUser{ID: 1, Username: "admin", RoleID: 1})
	s.userSeq = 1
	reg := func(name, ip string) int {
		r := httptest.NewRequest("POST", "/api/v1/auth/register", strings.NewReader(`{"username":"`+name+`","password":"a long password 1"}`))
		r.Header.Set("Content-Type", "application/json")
		r.Header.Set("X-BotHub-Client-IP", ip)
		w := httptest.NewRecorder()
		s.register(w, r)
		return w.Code
	}
	if c := reg("alice", "1.1.1.1"); c != 403 {
		t.Fatalf("closed registration: %d", c)
	}
	s.registration = registration{Enabled: true}
	if c := reg("bad name!", "1.1.1.1"); c != 422 {
		t.Fatalf("bad name: %d", c)
	}
	if c := reg("alice", "1.1.1.1"); c != 201 {
		t.Fatalf("register: %d", c)
	}
	if u := s.userByName("alice"); u == nil || u.RoleID != 4 {
		t.Fatalf("new account should be a guest: %+v", u)
	}
	if c := reg("ALICE", "2.2.2.2"); c != 409 {
		t.Fatalf("name taken: %d", c)
	}
	reg("bob", "1.1.1.1")
	reg("carl", "1.1.1.1")
	if c := reg("dave", "1.1.1.1"); c != 429 {
		t.Fatalf("4th account from one IP: %d", c)
	}
	if s.registerableRole(1) {
		t.Fatal("admin role must not be registerable")
	}
}
