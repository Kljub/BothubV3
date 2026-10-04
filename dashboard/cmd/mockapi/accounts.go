package main

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/go-webauthn/webauthn/webauthn"
	"golang.org/x/crypto/argon2"
)

// Accounts: several dashboard users, each with password (Argon2id), email,
// TOTP 2FA, recovery codes, language, theme and passkeys. The sign-in logic
// lives here; with the PHP API they are stored in its database
// (/internal/accounts) and loaded at start, so they survive restarts.
// Without it (tests, mock profile) they stay in memory.

// --- passwords (PHC string, readable by PHP's password_verify) ---

const (
	argonTime    = 3
	argonMemory  = 64 * 1024
	argonThreads = 1
	argonKeyLen  = 32
)

func hashPassword(pw string) string {
	salt := make([]byte, 16)
	_, _ = rand.Read(salt)
	key := argon2.IDKey([]byte(pw), salt, argonTime, argonMemory, argonThreads, argonKeyLen)
	b64 := base64.RawStdEncoding
	return fmt.Sprintf("$argon2id$v=19$m=%d,t=%d,p=%d$%s$%s", argonMemory, argonTime, argonThreads, b64.EncodeToString(salt), b64.EncodeToString(key))
}

// checkPassword verifies an Argon2id PHC hash in constant time.
func checkPassword(hash, pw string) bool {
	parts := strings.Split(hash, "$")
	if len(parts) != 6 || parts[1] != "argon2id" {
		return false
	}
	var m, t uint32
	var p uint8
	if _, err := fmt.Sscanf(parts[3], "m=%d,t=%d,p=%d", &m, &t, &p); err != nil || m == 0 || m > 1<<20 || t == 0 || t > 20 || p == 0 {
		return false
	}
	b64 := base64.RawStdEncoding
	salt, err1 := b64.DecodeString(parts[4])
	want, err2 := b64.DecodeString(parts[5])
	if err1 != nil || err2 != nil || len(want) == 0 {
		return false
	}
	got := argon2.IDKey([]byte(pw), salt, t, m, p, uint32(len(want)))
	return subtle.ConstantTimeCompare(got, want) == 1
}

// recoveryHash: recovery codes are kept as hashes only.
func recoveryHash(code string) string {
	sum := sha256.Sum256([]byte(strings.ToLower(strings.TrimSpace(code))))
	return hex.EncodeToString(sum[:])
}

// --- lookups (caller holds s.mu) ---

func (s *store) userByID(id int64) *mockUser {
	for _, u := range s.users {
		if u.ID == id {
			return u
		}
	}
	return nil
}

func (s *store) userByName(name string) *mockUser {
	for _, u := range s.users {
		if strings.EqualFold(u.Username, name) {
			return u
		}
	}
	return nil
}

// sessUser is the user of a session (by sessionKey; nil when unknown).
func (s *store) sessUser(sid string) *mockUser {
	if sess := s.sessions[sid]; sess != nil {
		return s.userByID(sess.userID)
	}
	return nil
}

// sessUserFromRequest is requestUser for callers that hold s.mu.
func (s *store) sessUserFromRequest(r *http.Request) *mockUser {
	c, err := r.Cookie("bothub_session")
	if err != nil {
		return nil
	}
	return s.sessUser(sessionKey(c.Value))
}

// requestUser is the signed-in user of a request (by its session cookie).
func (s *store) requestUser(r *http.Request) *mockUser {
	c, err := r.Cookie("bothub_session")
	if err != nil {
		return nil
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.sessUser(sessionKey(c.Value))
}

// nameOfLocked: the session's user name; caller holds s.mu.
func (s *store) nameOfLocked(sid string) string {
	if u := s.sessUser(sid); u != nil {
		return u.Username
	}
	return ""
}

func (s *store) requestUserName(r *http.Request) string {
	if u := s.requestUser(r); u != nil {
		return u.Username
	}
	return ""
}

// permissions of a user by role; a banned role has none.
func (s *store) permissionsOf(u *mockUser) []string {
	if u == nil {
		return nil
	}
	if ro := s.roleByID(u.RoleID); ro != nil {
		return ro.Permissions
	}
	return nil
}

// newUser adds a user (caller holds s.mu) and stores it.
func (s *store) newUser(name, password string, roleID int64, email *string) *mockUser {
	s.userSeq++
	u := &mockUser{ID: s.userSeq, Username: name, RoleID: roleID, CreatedAt: time.Now().UTC(), passwordHash: hashPassword(password), Email: email, locale: s.defaultLocale, theme: "system"}
	s.users = append(s.users, u)
	s.persistUser(u)
	return u
}

// --- persistence (PHP API) ---

type userContextKey struct{}

// withUser puts the signed-in user's ID on a context for the PHP API (X-BotHub-User).
func withUser(ctx context.Context, id int64) context.Context {
	return context.WithValue(ctx, userContextKey{}, id)
}

func userFrom(ctx context.Context) int64 {
	if id, ok := ctx.Value(userContextKey{}).(int64); ok {
		return id
	}
	return 0
}

// persistUser stores a user in the background (caller holds s.mu: the data is copied first).
func (s *store) persistUser(u *mockUser) {
	if s.php == nil || u == nil {
		return
	}
	body := map[string]any{
		"username": u.Username, "email": u.Email, "roleId": u.RoleID, "passwordHash": u.passwordHash,
		"locale": u.locale, "theme": u.theme, "totpSecret": u.totpSecret, "totpPending": u.pendingSecret,
		"recoveryCodes": append([]string{}, u.recovery...), "lastLoginAt": u.LastLoginAt,
	}
	id := u.ID
	go s.phpSync(http.MethodPut, "/internal/accounts/users/"+strconv.FormatInt(id, 10), body)
}

func (s *store) persistRole(ro *role) {
	if s.php == nil || ro == nil {
		return
	}
	body := map[string]any{"key": ro.Key, "name": ro.Name, "builtin": ro.Builtin, "permissions": append([]string{}, ro.Permissions...)}
	go s.phpSync(http.MethodPut, "/internal/accounts/roles/"+strconv.FormatInt(ro.ID, 10), body)
}

func (s *store) persistPasskey(k *passkey) {
	if s.php == nil || k == nil {
		return
	}
	body := map[string]any{"userId": k.userID, "name": k.Name, "credential": k.cred, "createdAt": k.CreatedAt, "lastUsedAt": k.LastUsedAt}
	go s.phpSync(http.MethodPut, "/internal/accounts/passkeys/"+k.ID, body)
}

func (s *store) phpDelete(path string) {
	if s.php != nil {
		go s.phpSync(http.MethodDelete, path, nil)
	}
}

func (s *store) phpSync(method, path string, body any) {
	// One at a time and in order: a user before its passkeys, a role before its users.
	s.syncMu.Lock()
	defer s.syncMu.Unlock()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := s.php.do(ctx, method, path, body, nil); err != nil {
		slog.Error("mockapi: storing account data failed", "path", path, "err", err)
	}
}

// loadAccounts reads users, roles and passkeys from the PHP API at start.
func (s *store) loadAccounts() {
	if s.php == nil {
		return
	}
	var in struct {
		Users []struct {
			ID            int64      `json:"id"`
			Username      string     `json:"username"`
			Email         *string    `json:"email"`
			RoleID        int64      `json:"roleId"`
			PasswordHash  string     `json:"passwordHash"`
			Locale        string     `json:"locale"`
			Theme         string     `json:"theme"`
			TotpSecret    string     `json:"totpSecret"`
			TotpPending   string     `json:"totpPending"`
			RecoveryCodes []string   `json:"recoveryCodes"`
			CreatedAt     string     `json:"createdAt"`
			LastLoginAt   *time.Time `json:"lastLoginAt"`
		} `json:"users"`
		Roles    []*role `json:"roles"`
		Passkeys []struct {
			ID         string          `json:"id"`
			UserID     int64           `json:"userId"`
			Name       string          `json:"name"`
			Credential json.RawMessage `json:"credential"`
			CreatedAt  string          `json:"createdAt"`
			LastUsedAt *string         `json:"lastUsedAt"`
		} `json:"passkeys"`
		Sessions []struct {
			KeyHash    string    `json:"keyHash"`
			ID         string    `json:"id"`
			UserID     int64     `json:"userId"`
			CSRF       string    `json:"csrf"`
			Remember   bool      `json:"remember"`
			DeviceKey  *string   `json:"deviceKey"`
			UserAgent  string    `json:"userAgent"`
			IP         string    `json:"ip"`
			CreatedAt  time.Time `json:"createdAt"`
			LastSeenAt time.Time `json:"lastSeenAt"`
			ExpiresAt  time.Time `json:"expiresAt"`
		} `json:"sessions"`
	}
	var err error
	for try := 0; try < 30; try++ {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		err = s.php.do(ctx, http.MethodGet, "/internal/accounts", nil, &in)
		cancel()
		if err == nil {
			break
		}
		time.Sleep(2 * time.Second) // the API may still be starting
	}
	if err != nil {
		slog.Error("mockapi: accounts not loaded, staying in memory", "err", err)
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	// Roles: the stored ones; the built-in ones of the gateway fill the gaps.
	for _, seed := range s.roles {
		found := false
		for _, r := range in.Roles {
			if r.ID == seed.ID {
				found = true
			}
		}
		if !found {
			s.persistRole(seed)
		}
	}
	for _, r := range in.Roles {
		if r.Permissions == nil {
			r.Permissions = []string{}
		}
		if cur := s.roleByID(r.ID); cur != nil {
			*cur = *r
		} else {
			s.roles = append(s.roles, r)
		}
		s.roleSeq = max(s.roleSeq, r.ID)
	}
	if len(in.Users) > 0 {
		s.users = nil
	}
	for _, u := range in.Users {
		created, _ := time.Parse(time.RFC3339Nano, u.CreatedAt)
		s.users = append(s.users, &mockUser{ID: u.ID, Username: u.Username, Email: u.Email, RoleID: u.RoleID, CreatedAt: created, LastLoginAt: u.LastLoginAt,
			passwordHash: u.PasswordHash, locale: u.Locale, theme: u.Theme, totpSecret: u.TotpSecret, pendingSecret: u.TotpPending, recovery: u.RecoveryCodes})
		s.userSeq = max(s.userSeq, u.ID)
	}
	s.passkeys.mu.Lock()
	for _, k := range in.Passkeys {
		var cred webauthn.Credential
		if json.Unmarshal(k.Credential, &cred) != nil {
			continue
		}
		created, _ := time.Parse(time.RFC3339Nano, k.CreatedAt)
		pk := &passkey{ID: k.ID, Name: k.Name, CreatedAt: created, cred: cred, userID: k.UserID}
		if k.LastUsedAt != nil {
			if t, err := time.Parse(time.RFC3339Nano, *k.LastUsedAt); err == nil {
				pk.LastUsedAt = &t
			}
		}
		s.passkeys.keys = append(s.passkeys.keys, pk)
	}
	s.passkeys.mu.Unlock()
	// Sessions: device-bound ones need a fresh proof first (provenAt is zero).
	for _, x := range in.Sessions {
		if s.userByID(x.UserID) == nil || time.Now().After(x.ExpiresAt) {
			continue
		}
		sess := &sessionData{id: x.ID, csrf: x.CSRF, userID: x.UserID, remember: x.Remember, userAgent: x.UserAgent, ip: x.IP,
			createdAt: x.CreatedAt, lastSeen: x.LastSeenAt, savedSeen: x.LastSeenAt, expiresAt: x.ExpiresAt}
		if x.DeviceKey != nil {
			sess.deviceKey = *x.DeviceKey
		}
		s.sessions[x.KeyHash] = sess
	}
	slog.Info("mockapi: accounts loaded", "users", len(s.users), "roles", len(s.roles), "sessions", len(in.Sessions))
}
