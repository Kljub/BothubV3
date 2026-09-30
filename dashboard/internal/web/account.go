package web

import (
	"encoding/base64"
	"fmt"
	"html/template"
	"net/http"
	"net/mail"
	"slices"
	"strconv"
	"strings"

	"rsc.io/qr"

	"github.com/Kljub/BothubV3/dashboard/internal/api"
)

// Security tab of the user settings (password, email, 2FA), the 2FA login
// step and the Email (SMTP) tab of the admin settings. Passwords and secrets
// are only passed through to the API, never stored or logged here.

const minPasswordLength = 12

// --- login with 2FA ---

type totpForm struct {
	Ticket string
	Error  string
}

func (s *Server) handleLoginTOTP(w http.ResponseWriter, r *http.Request) {
	p := s.pageFor(r, nil)
	ticket := r.PostFormValue("ticket")
	code := strings.ReplaceAll(strings.TrimSpace(r.PostFormValue("code")), " ", "")
	_, resp, err := s.api.LoginTOTP(r.Context(), ticket, code)
	if err != nil {
		apiErr := api.AsError(err)
		// An expired ticket means starting over with username and password.
		if apiErr.Key == "error.auth.ticket_expired" {
			s.render(w, http.StatusUnauthorized, "login", "auth_layout", withData(p, authForm{Error: s.apiErrorText(p, err)}))
			return
		}
		s.render(w, apiErr.Status, "login_totp", "auth_layout", withData(p, totpForm{Ticket: ticket, Error: s.apiErrorText(p, err)}))
		return
	}
	relayCookies(w, resp)
	http.Redirect(w, r, "/", http.StatusSeeOther)
}

// --- password and email ---

func (s *Server) handleChangePassword(w http.ResponseWriter, r *http.Request, p Page) {
	next := r.PostFormValue("new_password")
	switch {
	case next != r.PostFormValue("new_password_confirm"):
		s.failTo(w, r, p, &api.Error{Status: http.StatusUnprocessableEntity, Key: "error.setup.password_mismatch"}, "#account-flash")
		return
	case len([]rune(next)) < minPasswordLength:
		s.failTo(w, r, p, &api.Error{Status: http.StatusUnprocessableEntity, Key: "error.password.too_short", Params: map[string]any{"min": minPasswordLength}}, "#account-flash")
		return
	}
	if err := s.api.ChangePassword(r.Context(), session(r), r.PostFormValue("current_password"), next); err != nil {
		s.failTo(w, r, p, err, "#account-flash")
		return
	}
	w.Header().Set("HX-Trigger", "bothub:reset-forms")
	s.flashTo(w, p, "security.password.saved", "#account-flash")
}

func (s *Server) handleChangeEmail(w http.ResponseWriter, r *http.Request, p Page) {
	email := strings.TrimSpace(r.PostFormValue("email"))
	if _, err := mail.ParseAddress(email); err != nil || strings.ContainsAny(email, "<> ") {
		s.failTo(w, r, p, &api.Error{Status: http.StatusUnprocessableEntity, Key: "error.email.invalid"}, "#account-flash")
		return
	}
	if _, err := s.api.ChangeEmail(r.Context(), session(r), email, r.PostFormValue("current_password")); err != nil {
		s.failTo(w, r, p, err, "#account-flash")
		return
	}
	w.Header().Set("HX-Trigger", "bothub:reset-forms")
	s.flashTo(w, p, "security.email.saved", "#account-flash")
}

// --- 2FA ---

type twoFactorView struct {
	Enabled       bool
	Setup         *api.TwoFactorSetup
	QRDataURL     template.URL // generated here from the API secret, safe for src
	RecoveryCodes []string
}

func (s *Server) handleTwoFactorSetup(w http.ResponseWriter, r *http.Request, p Page) {
	setup, err := s.api.SetupTwoFactor(r.Context(), session(r))
	if err != nil {
		s.failTo(w, r, p, err, "#account-flash")
		return
	}
	code, err := qr.Encode(setup.OtpauthURI, qr.M)
	if err != nil {
		s.failTo(w, r, p, fmt.Errorf("qr: %w", err), "#account-flash")
		return
	}
	v := twoFactorView{Setup: &setup, QRDataURL: template.URL("data:image/png;base64," + base64.StdEncoding.EncodeToString(code.PNG()))}
	s.render(w, http.StatusOK, "error", "twofa_fragment", withData(p, v))
}

func (s *Server) handleTwoFactorEnable(w http.ResponseWriter, r *http.Request, p Page) {
	codes, err := s.api.EnableTwoFactor(r.Context(), session(r), strings.ReplaceAll(r.PostFormValue("code"), " ", ""))
	if err != nil {
		s.failTo(w, r, p, err, "#twofa-error")
		return
	}
	s.render(w, http.StatusOK, "error", "twofa_fragment", withData(p, twoFactorView{Enabled: true, RecoveryCodes: codes}))
}

func (s *Server) handleTwoFactorDisable(w http.ResponseWriter, r *http.Request, p Page) {
	err := s.api.DisableTwoFactor(r.Context(), session(r), r.PostFormValue("current_password"), strings.ReplaceAll(r.PostFormValue("code"), " ", ""))
	if err != nil {
		s.failTo(w, r, p, err, "#twofa-error")
		return
	}
	s.render(w, http.StatusOK, "error", "twofa_fragment", withData(p, twoFactorView{}))
}

// --- admin: email (SMTP) ---

func (s *Server) handleSMTPSettings(w http.ResponseWriter, r *http.Request, p Page) {
	port, _ := strconv.Atoi(strings.TrimSpace(r.PostFormValue("port")))
	in := api.SMTPUpdate{
		Enabled:     r.PostFormValue("enabled") == "true",
		Host:        strings.TrimSpace(r.PostFormValue("host")),
		Port:        port,
		Security:    r.PostFormValue("security"),
		Username:    strings.TrimSpace(r.PostFormValue("username")),
		FromAddress: strings.TrimSpace(r.PostFormValue("from_address")),
		FromName:    strings.TrimSpace(r.PostFormValue("from_name")),
	}
	if !slices.Contains(api.SMTPSecurityModes, in.Security) {
		in.Security = "starttls"
	}
	// An empty password field keeps the stored password.
	if pw := r.PostFormValue("password"); pw != "" {
		in.Password = &pw
	}
	if _, err := s.api.UpdateSMTPSettings(r.Context(), session(r), in); err != nil {
		s.failTo(w, r, p, err, "#admin-flash")
		return
	}
	w.Header().Set("HX-Trigger", "bothub:reset-forms")
	s.flashTo(w, p, "email_settings.saved", "#admin-flash")
}

func (s *Server) handleSMTPTest(w http.ResponseWriter, r *http.Request, p Page) {
	to := strings.TrimSpace(r.PostFormValue("to"))
	if _, err := mail.ParseAddress(to); err != nil || strings.ContainsAny(to, "<> ") {
		s.failTo(w, r, p, &api.Error{Status: http.StatusUnprocessableEntity, Key: "error.email.invalid"}, "#admin-flash")
		return
	}
	if err := s.api.SendTestEmail(r.Context(), session(r), to); err != nil {
		s.failTo(w, r, p, err, "#admin-flash")
		return
	}
	s.flashTo(w, p, "email_settings.test_sent", "#admin-flash")
}

// --- passkeys ---

// handlePasskeys renders the passkey list of the security tab. It loads when
// the tab becomes visible and after every registration.
func (s *Server) handlePasskeys(w http.ResponseWriter, r *http.Request, p Page) {
	keys, err := s.api.Passkeys(r.Context(), session(r))
	if err != nil {
		s.failTo(w, r, p, err, "#passkey-error")
		return
	}
	s.render(w, http.StatusOK, "error", "passkeys_fragment", withData(p, keys))
}

func (s *Server) handleDeletePasskey(w http.ResponseWriter, r *http.Request, p Page) {
	if err := s.api.DeletePasskey(r.Context(), session(r), r.PathValue("id")); err != nil {
		s.failTo(w, r, p, err, "#passkey-error")
		return
	}
	s.handlePasskeys(w, r, p)
}
