package main

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"math/big"
	"net/http"
	"time"
)

// Sign-in sessions. The cookie holds 32 random bytes (hex); the gateway keys
// its sessions by the SHA-256 of the cookie, and only that hash goes to the
// database (/internal/accounts/sessions), so sessions survive restarts.
//
// "Stay signed in" gives a cookie for rememberFor; otherwise the cookie ends
// with the browser and the session after the server's session hours.
//
// Device binding: at sign-in the browser may hand in the public key of a
// non-extractable ECDSA P-256 key (WebCrypto, kept in IndexedDB). The session
// then needs a fresh signature over a server challenge every
// deviceProofWindow (the page renews it in the background). A copied cookie
// alone stops working on another device.

const (
	rememberFor         = 30 * 24 * time.Hour
	deviceProofWindow   = 15 * time.Minute
	deviceChallengeTTL  = 2 * time.Minute
	sessionPersistEvery = 5 * time.Minute
	deviceProofPrefix   = "bothub-device-proof:"
)

// sessionOpts: what the browser asked for at sign-in.
type sessionOpts struct {
	Remember  bool   `json:"remember"`
	DeviceKey string `json:"deviceKey"`
}

// sessionKey is the map and database key of a session cookie.
func sessionKey(cookie string) string {
	sum := sha256.Sum256([]byte(cookie))
	return hex.EncodeToString(sum[:])
}

// parseDeviceKey reads a base64url SPKI ECDSA P-256 public key.
func parseDeviceKey(b64 string) (*ecdsa.PublicKey, error) {
	raw, err := base64.RawURLEncoding.DecodeString(b64)
	if err != nil || len(raw) > 300 {
		return nil, errors.New("bad encoding")
	}
	pub, err := x509.ParsePKIXPublicKey(raw)
	if err != nil {
		return nil, err
	}
	k, ok := pub.(*ecdsa.PublicKey)
	if !ok || k.Curve != elliptic.P256() {
		return nil, errors.New("not a P-256 key")
	}
	return k, nil
}

// verifyDeviceProof checks a WebCrypto ECDSA signature (raw r||s, base64url)
// over deviceProofPrefix + challenge.
func verifyDeviceProof(keyB64, challenge, sigB64 string) bool {
	k, err := parseDeviceKey(keyB64)
	if err != nil {
		return false
	}
	sig, err := base64.RawURLEncoding.DecodeString(sigB64)
	if err != nil || len(sig) != 64 {
		return false
	}
	digest := sha256.Sum256([]byte(deviceProofPrefix + challenge))
	return ecdsa.Verify(k, digest[:], new(big.Int).SetBytes(sig[:32]), new(big.Int).SetBytes(sig[32:]))
}

// sessionExpiry: rememberFor for "stay signed in", else the server's session hours.
// Caller holds s.mu.
func (s *store) sessionExpiry(start time.Time, remember bool) time.Time {
	if remember {
		return start.Add(rememberFor)
	}
	hours := s.srvSettings.SessionHours
	if hours < 1 {
		hours = defaultServerSettings().SessionHours
	}
	return start.Add(time.Duration(hours) * time.Hour)
}

// touchSession records who uses a session and when; the database gets it at
// most every sessionPersistEvery. Caller holds s.mu.
func (s *store) touchSession(key string, sess *sessionData, r *http.Request) {
	sess.lastSeen = time.Now().UTC()
	sess.userAgent, sess.ip = clientAgent(r), clientIP(r)
	if sess.lastSeen.Sub(sess.savedSeen) >= sessionPersistEvery {
		s.persistSession(key, sess)
	}
}

// persistSession stores a session in the background. Caller holds s.mu.
func (s *store) persistSession(key string, sess *sessionData) {
	sess.savedSeen = sess.lastSeen
	if s.php == nil {
		return
	}
	var deviceKey *string
	if sess.deviceKey != "" {
		deviceKey = &sess.deviceKey
	}
	stamp := func(t time.Time) string { return t.UTC().Format("2006-01-02T15:04:05Z") }
	body := map[string]any{
		"id": sess.id, "userId": sess.userID, "csrf": sess.csrf, "remember": sess.remember, "deviceKey": deviceKey,
		"userAgent": sess.userAgent, "ip": sess.ip,
		"createdAt": stamp(sess.createdAt), "lastSeenAt": stamp(sess.lastSeen), "expiresAt": stamp(sess.expiresAt),
	}
	go s.phpSync(http.MethodPut, "/internal/accounts/sessions/"+key, body)
}

// dropSession ends a session here and in the database. Caller holds s.mu.
func (s *store) dropSession(key string) {
	if _, ok := s.sessions[key]; !ok {
		return
	}
	delete(s.sessions, key)
	s.phpDelete("/internal/accounts/sessions/" + key)
}

// endSessionsOf signs a user out everywhere (except keep, e.g. the admin's
// own session): after a role change, a ban, new rights of their role or a
// deleted account the next request has to sign in again. Caller holds s.mu.
func (s *store) endSessionsOf(userID int64, keep string) int {
	n := 0
	for key, sess := range s.sessions {
		if sess.userID == userID && key != keep {
			s.dropSession(key)
			n++
		}
	}
	return n
}

// needsDeviceProof: a device-bound session whose last proof is too old.
func needsDeviceProof(sess *sessionData, path string) bool {
	if sess.deviceKey == "" || time.Since(sess.provenAt) < deviceProofWindow {
		return false
	}
	switch path {
	case "/api/v1/auth/device/challenge", "/api/v1/auth/device/proof", "/api/v1/auth/logout":
		return false
	}
	return true
}

// deviceChallenge hands out a one-time challenge for the device key. The
// CSRF token comes along: the proof page cannot ask /me before the proof.
func (s *store) deviceChallenge(w http.ResponseWriter, r *http.Request, sid string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	sess := s.sessions[sid]
	if sess.deviceKey == "" {
		writeJSON(w, 200, map[string]any{"bound": false})
		return
	}
	sess.challenge, sess.challengeExp = randomHex(32), time.Now().Add(deviceChallengeTTL)
	writeJSON(w, 200, map[string]any{"bound": true, "challenge": sess.challenge, "csrfToken": sess.csrf})
}

// deviceProof checks the signature. A wrong one ends the session: the
// browser does not hold the key the session was bound to.
func (s *store) deviceProof(w http.ResponseWriter, r *http.Request, sid string) {
	var in struct{ Signature string }
	if !readJSON(w, r, &in) {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	sess := s.sessions[sid]
	if sess.deviceKey == "" {
		w.WriteHeader(204)
		return
	}
	challenge := sess.challenge
	sess.challenge = ""
	if challenge == "" || time.Now().After(sess.challengeExp) {
		apiError(w, 409, "error.auth.device_challenge_expired")
		return
	}
	if !verifyDeviceProof(sess.deviceKey, challenge, in.Signature) {
		s.dropSession(sid)
		apiError(w, 401, "error.auth.device_proof_failed")
		return
	}
	sess.provenAt = time.Now()
	w.WriteHeader(204)
}
