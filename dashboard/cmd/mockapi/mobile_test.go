package main

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"
)

// phone: a keystore-like P-256 key; sign makes the request headers of the app.
type phone struct {
	key   *ecdsa.PrivateKey
	pub   string
	token string
}

func newPhone(t *testing.T) *phone {
	t.Helper()
	k, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	spki, _ := x509.MarshalPKIXPublicKey(&k.PublicKey)
	return &phone{key: k, pub: base64.RawURLEncoding.EncodeToString(spki)}
}

func (p *phone) request(method, uri, body string, at time.Time) *http.Request {
	r := httptest.NewRequest(method, uri, strings.NewReader(body))
	r.Header.Set("Content-Type", "application/json")
	stamp := strconv.FormatInt(at.Unix(), 10)
	digest := sha256.Sum256([]byte(mobileSigPrefix + stamp + ":" + method + ":" + uri))
	rr, ss, _ := ecdsa.Sign(rand.Reader, p.key, digest[:])
	raw := make([]byte, 64)
	rr.FillBytes(raw[:32])
	ss.FillBytes(raw[32:])
	r.Header.Set("Authorization", "Bearer "+p.token)
	r.Header.Set("X-BotHub-Time", stamp)
	r.Header.Set("X-BotHub-Signature", base64.RawURLEncoding.EncodeToString(raw))
	return r
}

func mobileStore() *store {
	s := &store{tickets: map[string]loginTicket{}, sessions: map[string]*sessionData{}, devices: map[string]*mobileDevice{}, pairings: map[string]*mobilePairing{},
		approvals: map[string]*loginApproval{}, pairLimit: newLoginLimiter()}
	s.srvSettings = defaultServerSettings()
	s.seedUsers()
	s.users = append(s.users, &mockUser{ID: 1, Username: "admin", RoleID: 1}, &mockUser{ID: 2, Username: "other", RoleID: 2})
	return s
}

// session: a dashboard session of a user (cookie + CSRF).
func session(t *testing.T, s *store, userID int64) func(method, path, body string, h authed, pv ...string) *httptest.ResponseRecorder {
	w := httptest.NewRecorder()
	s.startSession(w, httptest.NewRequest("POST", "/api/v1/auth/login", nil), 200, userID, sessionOpts{})
	c := w.Result().Cookies()[0]
	return func(method, path, body string, h authed, pv ...string) *httptest.ResponseRecorder {
		r := httptest.NewRequest(method, path, strings.NewReader(body))
		r.Header.Set("Content-Type", "application/json")
		r.AddCookie(c)
		r.Header.Set("X-CSRF-Token", s.sessions[sessionKey(c.Value)].csrf)
		for i := 0; i+1 < len(pv); i += 2 {
			r.SetPathValue(pv[i], pv[i+1])
		}
		w := httptest.NewRecorder()
		s.auth(h)(w, r)
		return w
	}
}

func jsonReq(method, path, body string) *http.Request {
	r := httptest.NewRequest(method, path, strings.NewReader(body))
	r.Header.Set("Content-Type", "application/json")
	return r
}

func pair(t *testing.T, s *store, dash func(string, string, string, authed, ...string) *httptest.ResponseRecorder, p *phone) map[string]any {
	t.Helper()
	w := dash("POST", "/api/v1/account/devices/pairing", "{}", s.createPairing)
	var code struct{ ID, Code, User string }
	_ = json.Unmarshal(w.Body.Bytes(), &code)
	if w.Code != 201 || len(code.Code) != 48 || code.User != "other" {
		t.Fatalf("pairing code: %d %s", w.Code, w.Body)
	}
	// Another user's name with the right key: refused.
	wrong, _ := json.Marshal(map[string]string{"code": code.Code, "user": "admin", "name": "Pixel 9", "platform": "android", "publicKey": p.pub})
	w = httptest.NewRecorder()
	s.pairDevice(w, jsonReq("POST", "/api/v1/mobile/pair", string(wrong)))
	if w.Code != 404 {
		t.Fatalf("wrong user: %d", w.Code)
	}
	body, _ := json.Marshal(map[string]string{"code": code.Code, "user": "other", "name": "Pixel 9", "platform": "android", "appVersion": "1.0.0", "publicKey": p.pub})
	w = httptest.NewRecorder()
	s.pairDevice(w, jsonReq("POST", "/api/v1/mobile/pair", string(body)))
	var out map[string]any
	_ = json.Unmarshal(w.Body.Bytes(), &out)
	if w.Code != 201 {
		t.Fatalf("pair: %d %s", w.Code, w.Body)
	}
	p.token, _ = out["token"].(string)
	// The code works once.
	w = httptest.NewRecorder()
	s.pairDevice(w, jsonReq("POST", "/api/v1/mobile/pair", string(body)))
	if w.Code != 404 {
		t.Fatalf("second use of a code: %d", w.Code)
	}
	st := dash("GET", "/", "", s.pairingStatus, "pid", code.ID)
	if !strings.Contains(st.Body.String(), `"paired":true`) {
		t.Fatalf("status: %s", st.Body)
	}
	return out
}

func TestMobilePairingAndSignedRequests(t *testing.T) {
	s := mobileStore()
	dash := session(t, s, 2)
	p := newPhone(t)
	out := pair(t, s, dash, p)
	if !strings.HasPrefix(p.token, mobileTokenPrefix) || out["guardSecret"] == "" {
		t.Fatalf("pair answer: %v", out)
	}
	me := func(r *http.Request) *httptest.ResponseRecorder {
		w := httptest.NewRecorder()
		s.auth(s.mobileMe)(w, r)
		return w
	}
	now := time.Now()
	if w := me(p.request("GET", "/api/v1/mobile/me", "", now)); w.Code != 200 || !strings.Contains(w.Body.String(), `"username":"other"`) {
		t.Fatalf("signed me: %d %s", w.Code, w.Body)
	}
	// The same signature again (replay), an old time, a foreign key, a forbidden path.
	r := p.request("GET", "/api/v1/mobile/me", "", now.Add(time.Second))
	_ = me(r)
	if w := me(r); w.Code != 401 {
		t.Fatalf("replay: %d", w.Code)
	}
	if w := me(p.request("GET", "/api/v1/mobile/me", "", now.Add(-10*time.Minute))); w.Code != 401 || !strings.Contains(w.Body.String(), "clock") {
		t.Fatalf("old time: %d %s", w.Code, w.Body)
	}
	thief := newPhone(t)
	thief.token = p.token
	if w := me(thief.request("GET", "/api/v1/mobile/me", "", now)); w.Code != 401 || !strings.Contains(w.Body.String(), "signature") {
		t.Fatalf("stolen token: %d %s", w.Code, w.Body)
	}
	w := httptest.NewRecorder()
	s.auth(s.me)(w, p.request("POST", "/api/v1/auth/password", "{}", now))
	if w.Code != 403 || !strings.Contains(w.Body.String(), "web_only") {
		t.Fatalf("password change from the phone: %d %s", w.Code, w.Body)
	}
	w = httptest.NewRecorder()
	s.auth(s.me)(w, p.request("GET", "/api/v1/admin/users", "", now.Add(500*time.Millisecond)))
	if w.Code != 403 || !strings.Contains(w.Body.String(), "web_only") {
		t.Fatalf("admin from the phone: %d %s", w.Code, w.Body)
	}
	for _, path := range []string{"/api/v1/admin/settings", "/api/v1/account/devices", "/api/v1/auth/2fa/setup", "/api/v1/users/3"} {
		if !mobileWebOnly(path) {
			t.Fatalf("%s must be web only", path)
		}
	}
	if !mobileMayCall("PATCH", "/api/v1/bots/3/commands/12") || !mobileMayCall("GET", "/api/v1/bots/3/commands") || !mobileMayCall("POST", "/api/v1/bots/3/start") || mobileMayCall("DELETE", "/api/v1/bots/3") || mobileMayCall("GET", "/api/v1/admin/users") {
		t.Fatal("allowed paths")
	}
	// The phone is the user's: the request user is "other", never the admin.
	var seen int64
	w = httptest.NewRecorder()
	s.auth(func(w http.ResponseWriter, r *http.Request, sid string) { seen = s.requestUser(r).ID })(w, p.request("GET", "/api/v1/bots", "", now.Add(2*time.Second)))
	if seen != 2 {
		t.Fatalf("request user %d", seen)
	}
	// Unpair from the dashboard: the token stops working.
	list := dash("GET", "/api/v1/account/devices", "", s.listDevices)
	var devs struct{ Items []struct{ ID string } }
	_ = json.Unmarshal(list.Body.Bytes(), &devs)
	if len(devs.Items) != 1 {
		t.Fatalf("devices: %s", list.Body)
	}
	if w := dash("DELETE", "/", "", s.deleteDevice, "did", devs.Items[0].ID); w.Code != 204 {
		t.Fatalf("unpair: %d", w.Code)
	}
	if w := me(p.request("GET", "/api/v1/mobile/me", "", now.Add(3*time.Second))); w.Code != 401 {
		t.Fatalf("after unpair: %d", w.Code)
	}
}

func TestGuardApprovalAndCode(t *testing.T) {
	s := mobileStore()
	dash := session(t, s, 2)
	p := newPhone(t)
	out := pair(t, s, dash, p)
	secret, _ := out["guardSecret"].(string)
	id := out["device"].(map[string]any)["id"].(string)
	if len(s.guardDevices(2)) != 0 {
		t.Fatal("Guard is off until switched on")
	}
	if w := dash("PATCH", "/", `{"guard":true}`, s.patchDevice, "did", id); w.Code != 200 {
		t.Fatalf("guard on: %d", w.Code)
	}
	// A sign-in waits for the phone.
	s.mu.Lock()
	ticket := s.newTicket(2, sessionOpts{})
	a := s.newApproval(ticket, 2, httptest.NewRequest("POST", "/api/v1/auth/login", nil))
	s.mu.Unlock()
	guard := func() *httptest.ResponseRecorder {
		w := httptest.NewRecorder()
		s.loginGuard(w, jsonReq("POST", "/api/v1/auth/login/guard", `{"ticket":"`+ticket+`"}`))
		return w
	}
	if w := guard(); w.Code != 202 {
		t.Fatalf("pending: %d", w.Code)
	}
	now := time.Now()
	w := httptest.NewRecorder()
	s.auth(s.mobileApprovals)(w, p.request("GET", "/api/v1/mobile/approvals", "", now))
	if !strings.Contains(w.Body.String(), a.ID) {
		t.Fatalf("approvals: %s", w.Body)
	}
	r := p.request("POST", "/api/v1/mobile/approvals/"+a.ID, `{"approve":true}`, now.Add(time.Second))
	r.SetPathValue("aid", a.ID)
	w = httptest.NewRecorder()
	s.auth(s.mobileDecide)(w, r)
	if w.Code != 200 {
		t.Fatalf("approve: %d %s", w.Code, w.Body)
	}
	if w := guard(); w.Code != 200 || len(w.Result().Cookies()) == 0 {
		t.Fatalf("approved sign-in gets a session: %d", w.Code)
	}
	if w := guard(); w.Code != 401 {
		t.Fatalf("the ticket is used: %d", w.Code)
	}
	// The app's code works as second factor; a wrong one does not.
	s.mu.Lock()
	ok := s.checkSecondFactor(s.userByID(2), totpCode(secret, time.Now().Unix()/30))
	bad := s.checkSecondFactor(s.userByID(2), "000000")
	s.mu.Unlock()
	if !ok || bad {
		t.Fatalf("guard code %v, wrong code %v", ok, bad)
	}
	// A denied sign-in ends.
	s.mu.Lock()
	ticket = s.newTicket(2, sessionOpts{})
	a = s.newApproval(ticket, 2, httptest.NewRequest("POST", "/", nil))
	a.status = "denied"
	s.mu.Unlock()
	if w := guard(); w.Code != 401 || !strings.Contains(w.Body.String(), "guard_denied") {
		t.Fatalf("denied: %d %s", w.Code, w.Body)
	}
}

func TestPairingKeyRotates(t *testing.T) {
	s := mobileStore()
	dash := session(t, s, 2)
	w := dash("POST", "/api/v1/account/devices/pairing", "{}", s.createPairing)
	var first struct{ ID, Code, KeyID string }
	_ = json.Unmarshal(w.Body.Bytes(), &first)
	// 31 s later the dashboard's poll turns the key over.
	s.mu.Lock()
	p := s.pairings[first.ID]
	p.rotatesAt = time.Now().Add(-time.Second)
	s.mu.Unlock()
	st := dash("GET", "/", "", s.pairingStatus, "pid", first.ID)
	var next struct{ Code, KeyID string }
	_ = json.Unmarshal(st.Body.Bytes(), &next)
	if next.Code == first.Code || next.KeyID == first.KeyID || len(next.Code) != 48 {
		t.Fatalf("no new key: %s", st.Body)
	}
	now := time.Now()
	s.mu.Lock()
	oldOK := p.accepts(first.Code, now)                       // grace
	oldLate := p.accepts(first.Code, now.Add(11*time.Second)) // after the grace
	newOK := p.accepts(next.Code, now)
	s.mu.Unlock()
	if !oldOK || oldLate || !newOK {
		t.Fatalf("old %v, old late %v, new %v", oldOK, oldLate, newOK)
	}
}

func TestMobileCommandPatchOnlyEnabled(t *testing.T) {
	req := func(body string) *http.Request {
		r := jsonReq("PATCH", "/api/v1/bots/3/commands/12", body)
		return r
	}
	if !mobileBodyAllowed(req(`{"enabled":false}`)) {
		t.Fatal("enabled refused")
	}
	for _, b := range []string{`{"enabled":true,"name":"x"}`, `{"graph":{}}`, `{"enabled":"yes"}`, `nope`} {
		if mobileBodyAllowed(req(b)) {
			t.Fatalf("%s allowed", b)
		}
	}
	r := req(`{"enabled":true}`)
	_ = mobileBodyAllowed(r)
	if b, _ := io.ReadAll(r.Body); string(b) != `{"enabled":true}` {
		t.Fatalf("body not put back: %q", b)
	}
}
