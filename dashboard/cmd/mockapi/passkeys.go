package main

import (
	"bytes"
	"encoding/base64"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/go-webauthn/webauthn/protocol"
	"github.com/go-webauthn/webauthn/webauthn"
)

// Passkeys (WebAuthn), verified with go-webauthn; every user has their own
// (user handle "bothub-user-<id>"), stored through accounts.go. Relying party from ENV:
// WEBAUTHN_RP_ID (default "localhost"), WEBAUTHN_ORIGINS (comma-separated,
// default "http://localhost:8080").

type passkey struct {
	ID         string     `json:"id"` // base64url of the credential ID
	Name       string     `json:"name"`
	CreatedAt  time.Time  `json:"createdAt"`
	LastUsedAt *time.Time `json:"lastUsedAt"`
	cred       webauthn.Credential
	userID     int64
}

type passkeyStore struct {
	mu         sync.Mutex
	wa         *webauthn.WebAuthn
	keys       []*passkey
	ceremonies map[string]*ceremony // pending register/login ceremonies
	// owners: passkeys per user, behind its own lock that never waits for
	// another one, so code holding the store lock may ask has().
	ownersMu sync.Mutex
	owners   map[int64]int
}

type ceremony struct {
	data    webauthn.SessionData
	expires time.Time
}

// has: the user has at least one passkey.
func (p *passkeyStore) has(userID int64) bool {
	p.ownersMu.Lock()
	defer p.ownersMu.Unlock()
	return p.owners[userID] > 0
}

// reindex recounts owners after a change of keys; caller holds p.mu.
func (p *passkeyStore) reindex() {
	m := map[int64]int{}
	for _, k := range p.keys {
		m[k.userID]++
	}
	p.ownersMu.Lock()
	p.owners = m
	p.ownersMu.Unlock()
}

// userHandle is the WebAuthn user handle of a user (stable, not the name).
func userHandle(id int64) []byte { return []byte(fmt.Sprintf("bothub-user-%d", id)) }

type waUser struct {
	id   int64
	name string
	keys []*passkey
}

func (u waUser) WebAuthnID() []byte          { return userHandle(u.id) }
func (u waUser) WebAuthnName() string        { return u.name }
func (u waUser) WebAuthnDisplayName() string { return u.name }
func (u waUser) WebAuthnCredentials() []webauthn.Credential {
	out := make([]webauthn.Credential, len(u.keys))
	for i, k := range u.keys {
		out[i] = k.cred
	}
	return out
}

func newPasskeyStore() *passkeyStore {
	rpID := envOr("WEBAUTHN_RP_ID", "localhost")
	origins := strings.Split(envOr("WEBAUTHN_ORIGINS", "http://localhost:8080"), ",")
	wa, err := webauthn.New(&webauthn.Config{RPDisplayName: "BotHub", RPID: rpID, RPOrigins: origins})
	if err != nil {
		slog.Error("mockapi: webauthn config", "err", err)
		os.Exit(1)
	}
	return &passkeyStore{wa: wa, ceremonies: map[string]*ceremony{}}
}

func (p *passkeyStore) put(data *webauthn.SessionData) string {
	id := randomHex(16)
	p.ceremonies[id] = &ceremony{data: *data, expires: time.Now().Add(5 * time.Minute)}
	return id
}

// take returns and removes a ceremony; each may be finished once.
func (p *passkeyStore) take(id string) (webauthn.SessionData, bool) {
	c, ok := p.ceremonies[id]
	delete(p.ceremonies, id)
	if !ok || time.Now().After(c.expires) {
		return webauthn.SessionData{}, false
	}
	return c.data, true
}

// waUser: a user with their passkeys; caller holds s.passkeys.mu.
func (s *store) waUser(id int64, name string) waUser {
	u := waUser{id: id, name: name}
	for _, k := range s.passkeys.keys {
		if k.userID == id {
			u.keys = append(u.keys, k)
		}
	}
	return u
}

// sidUser: ID and name of the session's user.
func (s *store) sidUser(sid string) (int64, string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if u := s.sessUser(sid); u != nil {
		return u.ID, u.Username
	}
	return 0, ""
}

func (s *store) listPasskeys(w http.ResponseWriter, r *http.Request, sid string) {
	id, name := s.sidUser(sid)
	s.passkeys.mu.Lock()
	defer s.passkeys.mu.Unlock()
	items := s.waUser(id, name).keys
	if items == nil {
		items = []*passkey{}
	}
	writeJSON(w, 200, map[string]any{"items": items})
}

func (s *store) deletePasskey(w http.ResponseWriter, r *http.Request, sid string) {
	id := r.PathValue("id")
	uid, _ := s.sidUser(sid)
	s.passkeys.mu.Lock()
	defer s.passkeys.mu.Unlock()
	for i, k := range s.passkeys.keys {
		if k.ID == id && k.userID == uid {
			s.passkeys.keys = append(s.passkeys.keys[:i], s.passkeys.keys[i+1:]...)
			s.passkeys.reindex()
			s.phpDelete("/internal/accounts/passkeys/" + id)
			w.WriteHeader(204)
			return
		}
	}
	apiError(w, 404, "error.not_found")
}

// registerBegin: logged-in user adds a passkey. Answer: {ceremony, options}.
func (s *store) registerPasskeyBegin(w http.ResponseWriter, r *http.Request, sid string) {
	uid, name := s.sidUser(sid)
	s.passkeys.mu.Lock()
	defer s.passkeys.mu.Unlock()
	user := s.waUser(uid, name)
	exclude := make([]protocol.CredentialDescriptor, len(user.keys))
	for i, k := range user.keys {
		exclude[i] = k.cred.Descriptor()
	}
	options, data, err := s.passkeys.wa.BeginRegistration(user,
		webauthn.WithResidentKeyRequirement(protocol.ResidentKeyRequirementRequired),
		webauthn.WithExclusions(exclude),
	)
	if err != nil {
		apiError(w, 500, "error.passkey.failed")
		return
	}
	writeJSON(w, 200, map[string]any{"ceremony": s.passkeys.put(data), "options": options})
}

// registerFinish: body = the credential JSON from the browser;
// ?ceremony=<id>&name=<label>.
func (s *store) registerPasskeyFinish(w http.ResponseWriter, r *http.Request, sid string) {
	uid, uname := s.sidUser(sid)
	name := strings.TrimSpace(r.URL.Query().Get("name"))
	if name == "" || len([]rune(name)) > 50 {
		apiError(w, 422, "error.passkey.name")
		return
	}
	s.passkeys.mu.Lock()
	defer s.passkeys.mu.Unlock()
	data, ok := s.passkeys.take(r.URL.Query().Get("ceremony"))
	if !ok {
		apiError(w, 409, "error.passkey.expired")
		return
	}
	cred, err := s.passkeys.wa.FinishRegistration(s.waUser(uid, uname), data, r)
	if err != nil {
		slog.Warn("mockapi: passkey registration failed", "err", err)
		apiError(w, 422, "error.passkey.failed")
		return
	}
	pk := &passkey{ID: base64.RawURLEncoding.EncodeToString(cred.ID), Name: name, CreatedAt: time.Now().UTC(), cred: *cred, userID: uid}
	s.passkeys.keys = append(s.passkeys.keys, pk)
	s.passkeys.reindex()
	s.persistPasskey(pk)
	writeJSON(w, 201, pk)
}

// loginBegin: no session; discoverable credentials (the browser picks the passkey).
func (s *store) loginPasskeyBegin(w http.ResponseWriter, r *http.Request) {
	s.passkeys.mu.Lock()
	defer s.passkeys.mu.Unlock()
	options, data, err := s.passkeys.wa.BeginDiscoverableLogin(webauthn.WithUserVerification(protocol.VerificationRequired))
	if err != nil {
		apiError(w, 500, "error.passkey.failed")
		return
	}
	writeJSON(w, 200, map[string]any{"ceremony": s.passkeys.put(data), "options": options})
}

// loginFinish verifies the assertion and starts a session (a passkey with user
// verification counts as two factors, so 2FA is not asked again).
func (s *store) loginPasskeyFinish(w http.ResponseWriter, r *http.Request) {
	s.passkeys.mu.Lock()
	data, ok := s.passkeys.take(r.URL.Query().Get("ceremony"))
	if !ok {
		s.passkeys.mu.Unlock()
		apiError(w, 409, "error.passkey.expired")
		return
	}
	var who int64
	handler := func(rawID, handle []byte) (webauthn.User, error) {
		id, err := strconv.ParseInt(strings.TrimPrefix(string(handle), "bothub-user-"), 10, 64)
		if err != nil || !bytes.Equal(handle, userHandle(id)) {
			return nil, protocol.ErrBadRequest.WithDetails("unknown user")
		}
		s.mu.Lock()
		u := s.userByID(id)
		banned := u != nil && s.roleKey(u.RoleID) == "banned"
		s.mu.Unlock()
		if u == nil || banned {
			return nil, protocol.ErrBadRequest.WithDetails("unknown user")
		}
		who = id
		return s.waUser(u.ID, u.Username), nil
	}
	_, cred, err := s.passkeys.wa.FinishPasskeyLogin(handler, data, r)
	if err == nil {
		now := time.Now().UTC()
		for _, k := range s.passkeys.keys {
			if bytes.Equal(k.cred.ID, cred.ID) {
				k.cred.Authenticator.UpdateCounter(cred.Authenticator.SignCount)
				k.LastUsedAt = &now
				s.persistPasskey(k)
			}
		}
	}
	s.passkeys.mu.Unlock()
	if err != nil {
		slog.Warn("mockapi: passkey login failed", "err", err)
		apiError(w, 401, "error.passkey.failed")
		return
	}
	q := r.URL.Query()
	s.startSession(w, r, 200, who, sessionOpts{Remember: q.Get("remember") == "1", DeviceKey: q.Get("deviceKey")})
}
