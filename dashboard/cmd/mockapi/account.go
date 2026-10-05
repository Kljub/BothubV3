package main

import (
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha1"
	"crypto/subtle"
	"encoding/base32"
	"encoding/binary"
	"fmt"
	"log/slog"
	"net/http"
	"net/mail"
	"net/url"
	"strings"
	"time"
)

// Account security of the signed-in user (password, email, TOTP 2FA,
// recovery codes) and the SMTP settings. Accounts are stored through
// accounts.go.

// dummyHash: checked for unknown user names, so they cost the same time.
var dummyHash = hashPassword(randomHex(16))

type smtpData struct {
	Enabled     bool   `json:"enabled"`
	Host        string `json:"host"`
	Port        int    `json:"port"`
	Security    string `json:"security"`
	Username    string `json:"username"`
	PasswordSet bool   `json:"passwordSet"`
	FromAddress string `json:"fromAddress"`
	FromName    string `json:"fromName"`
	password    string
}

const minPassword = 12

var b32 = base32.StdEncoding.WithPadding(base32.NoPadding)

// totpCode computes the RFC 6238 code (SHA-1, 30 s, 6 digits) for a step.
func totpCode(secret string, step int64) string {
	key, err := b32.DecodeString(secret)
	if err != nil {
		return ""
	}
	var msg [8]byte
	binary.BigEndian.PutUint64(msg[:], uint64(step))
	mac := hmac.New(sha1.New, key)
	mac.Write(msg[:])
	sum := mac.Sum(nil)
	off := sum[len(sum)-1] & 0x0f
	v := binary.BigEndian.Uint32(sum[off:off+4]) & 0x7fffffff
	return fmt.Sprintf("%06d", v%1_000_000)
}

// totpValid accepts the current code and one step before/after (clock skew).
func totpValid(secret, code string) bool {
	step := time.Now().Unix() / 30
	for d := int64(-1); d <= 1; d++ {
		if subtle.ConstantTimeCompare([]byte(totpCode(secret, step+d)), []byte(code)) == 1 {
			return true
		}
	}
	return false
}

// totpSkew finds a code that fits another time (up to ±10 minutes): then the
// code is right but the server clock is off. Answers the offset in seconds
// (positive: the server is behind).
func totpSkew(secret, code string) (int, bool) {
	step := time.Now().Unix() / 30
	for d := int64(2); d <= 20; d++ {
		for _, s := range []int64{d, -d} {
			if subtle.ConstantTimeCompare([]byte(totpCode(secret, step+s)), []byte(code)) == 1 {
				return int(s * 30), true
			}
		}
	}
	return 0, false
}

// totpError answers a refused code; with a clock offset it says so.
func totpError(w http.ResponseWriter, status int, secret, code string) {
	if secret != "" {
		if skew, ok := totpSkew(secret, strings.TrimSpace(code)); ok {
			slog.Warn("mockapi: 2FA code fits another time, check the server clock (NTP)", "offsetSeconds", skew)
			apiErrorParams(w, status, "error.auth.totp_clock", map[string]any{"seconds": skew})
			return
		}
	}
	apiError(w, status, "error.auth.totp_invalid")
}

// checkSecondFactor accepts a TOTP code or an unused recovery code; caller holds s.mu.
func (s *store) checkSecondFactor(u *mockUser, code string) bool {
	code = strings.TrimSpace(code)
	if u.totpSecret != "" && totpValid(u.totpSecret, code) {
		return true
	}
	h := recoveryHash(code)
	for i, rc := range u.recovery {
		if subtle.ConstantTimeCompare([]byte(h), []byte(rc)) == 1 {
			u.recovery = append(u.recovery[:i], u.recovery[i+1:]...)
			s.persistUser(u)
			return true
		}
	}
	return false
}

func passwordOK(u *mockUser, pw string) bool {
	return u != nil && checkPassword(u.passwordHash, pw)
}

// loginTOTP finishes a login that needed a second factor.
func (s *store) loginTOTP(w http.ResponseWriter, r *http.Request) {
	var in struct{ Ticket, Code string }
	if !readJSON(w, r, &in) {
		return
	}
	s.mu.Lock()
	t, ok := s.tickets[in.Ticket]
	u := s.userByID(t.userID)
	if !ok || u == nil || time.Now().After(t.expires) {
		delete(s.tickets, in.Ticket)
		s.mu.Unlock()
		apiError(w, 401, "error.auth.ticket_expired")
		return
	}
	if !s.checkSecondFactor(u, in.Code) {
		secret := u.totpSecret
		s.mu.Unlock()
		totpError(w, 401, secret, in.Code)
		return
	}
	delete(s.tickets, in.Ticket)
	s.mu.Unlock()
	s.startSession(w, r, 200, u.ID, t.opts)
}

// newTicket is handed out when the password was right but 2FA is on; caller holds s.mu.
func (s *store) newTicket(userID int64, opts sessionOpts) string {
	t := randomHex(24)
	s.tickets[t] = loginTicket{userID: userID, expires: time.Now().Add(5 * time.Minute), opts: opts}
	return t
}

func (s *store) changePassword(w http.ResponseWriter, r *http.Request, sid string) {
	var in struct{ CurrentPassword, NewPassword string }
	if !readJSON(w, r, &in) {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	u := s.sessUser(sid)
	switch {
	case !passwordOK(u, in.CurrentPassword):
		apiError(w, 403, "error.auth.wrong_password")
	case len([]rune(in.NewPassword)) < minPassword:
		apiErrorParams(w, 422, "error.password.too_short", map[string]any{"min": minPassword})
	default:
		u.passwordHash = hashPassword(in.NewPassword)
		s.persistUser(u)
		w.WriteHeader(204)
	}
}

func (s *store) changeEmail(w http.ResponseWriter, r *http.Request, sid string) {
	var in struct{ Email, CurrentPassword string }
	if !readJSON(w, r, &in) {
		return
	}
	if _, err := mail.ParseAddress(in.Email); err != nil || len(in.Email) > 254 {
		apiError(w, 422, "error.email.invalid")
		return
	}
	s.mu.Lock()
	u := s.sessUser(sid)
	if !passwordOK(u, in.CurrentPassword) {
		s.mu.Unlock()
		apiError(w, 403, "error.auth.wrong_password")
		return
	}
	email := in.Email
	u.Email = &email
	s.persistUser(u)
	sess := s.sessions[sid]
	s.mu.Unlock()
	writeJSON(w, 200, s.meFor(sess.userID, sess.csrf))
}

func (s *store) setupTwoFactor(w http.ResponseWriter, r *http.Request, sid string) {
	raw := make([]byte, 20)
	_, _ = rand.Read(raw)
	secret := b32.EncodeToString(raw)
	s.mu.Lock()
	u := s.sessUser(sid)
	// A started set-up keeps its secret until it is finished: a second click
	// or a reload must not make the code in the authenticator app invalid.
	if u.pendingSecret != "" {
		secret = u.pendingSecret
	} else {
		u.pendingSecret = secret
		s.persistUser(u)
	}
	user := u.Username
	s.mu.Unlock()
	uri := "otpauth://totp/" + url.PathEscape("BotHub:"+user) + "?" + url.Values{
		"secret": {secret}, "issuer": {"BotHub"}, "algorithm": {"SHA1"}, "digits": {"6"}, "period": {"30"},
	}.Encode()
	writeJSON(w, 200, map[string]string{"secret": secret, "otpauthUri": uri})
}

func (s *store) enableTwoFactor(w http.ResponseWriter, r *http.Request, sid string) {
	var in struct{ Code string }
	if !readJSON(w, r, &in) {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	u := s.sessUser(sid)
	if u.pendingSecret == "" || !totpValid(u.pendingSecret, strings.TrimSpace(in.Code)) {
		totpError(w, 422, u.pendingSecret, in.Code)
		return
	}
	u.totpSecret, u.pendingSecret = u.pendingSecret, ""
	// The codes are shown once; only their hashes are kept.
	codes := make([]string, 0, 8)
	u.recovery = nil
	for range 8 {
		c := randomHex(5)
		codes = append(codes, c[:5]+"-"+c[5:])
		u.recovery = append(u.recovery, recoveryHash(c[:5]+"-"+c[5:]))
	}
	s.persistUser(u)
	writeJSON(w, 200, map[string]any{"recoveryCodes": codes})
}

func (s *store) disableTwoFactor(w http.ResponseWriter, r *http.Request, sid string) {
	var in struct{ CurrentPassword, Code string }
	if !readJSON(w, r, &in) {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	u := s.sessUser(sid)
	if !passwordOK(u, in.CurrentPassword) {
		apiError(w, 403, "error.auth.wrong_password")
		return
	}
	if !s.checkSecondFactor(u, in.Code) {
		totpError(w, 422, u.totpSecret, in.Code)
		return
	}
	u.totpSecret, u.recovery = "", nil
	s.persistUser(u)
	w.WriteHeader(204)
}

// --- SMTP ---

func (s *store) getSMTP(w http.ResponseWriter, r *http.Request, _ string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	writeJSON(w, 200, s.smtp)
}

func (s *store) putSMTP(w http.ResponseWriter, r *http.Request, _ string) {
	var in struct {
		smtpData
		Password *string `json:"password"`
	}
	if !readJSON(w, r, &in) {
		return
	}
	switch {
	case in.Port < 1 || in.Port > 65535:
		apiError(w, 422, "error.server_settings.port")
		return
	case !oneOf(in.Security, "starttls", "tls", "none"):
		apiError(w, 422, "error.validation.failed")
		return
	case in.FromAddress != "":
		if _, err := mail.ParseAddress(in.FromAddress); err != nil {
			apiError(w, 422, "error.email.invalid")
			return
		}
	}
	if in.Enabled && (in.Host == "" || in.FromAddress == "") {
		apiError(w, 422, "error.smtp.incomplete")
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	pw := s.smtp.password
	if in.Password != nil {
		pw = *in.Password
	}
	s.smtp = in.smtpData
	s.smtp.password, s.smtp.PasswordSet = pw, pw != ""
	s.persistSMTP(in.Password)
	writeJSON(w, 200, s.smtp)
}

// testSMTP sends a test mail with the saved settings.
func (s *store) testSMTP(w http.ResponseWriter, r *http.Request, _ string) {
	var in struct{ To string }
	if !readJSON(w, r, &in) {
		return
	}
	s.mu.Lock()
	cfg := s.smtp
	s.mu.Unlock()
	if !cfg.Enabled || cfg.Host == "" {
		apiError(w, 409, "error.smtp.not_configured")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), smtpTimeout)
	defer cancel()
	body := "This is a test mail from BotHub.\n\nIf you can read it, the mail server settings work."
	if err := sendMail(ctx, cfg, strings.TrimSpace(in.To), "BotHub test mail", body); err != nil {
		apiErrorParams(w, 502, "error.smtp.failed", map[string]any{"reason": truncate(err.Error(), 200)})
		return
	}
	w.WriteHeader(204)
}

func apiErrorParams(w http.ResponseWriter, status int, key string, params map[string]any) {
	writeJSON(w, status, map[string]any{"error": map[string]any{"key": key, "params": params}})
}
