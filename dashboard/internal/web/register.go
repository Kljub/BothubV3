package web

import (
	"net/http"
	"strconv"
	"strings"

	"github.com/Kljub/BothubV3/dashboard/internal/api"
)

// Self-registration: /register when an admin turned it on (Invite Policies).

type registerForm struct {
	Username string
	Email    string
	Remember bool
	Error    string
}

func (s *Server) handleRegisterPage(w http.ResponseWriter, r *http.Request) {
	if !s.api.RegistrationOpen(r.Context()) {
		http.Redirect(w, r, "/login", http.StatusSeeOther)
		return
	}
	s.render(w, http.StatusOK, "register", "auth_layout", withData(s.pageFor(r, nil), registerForm{}))
}

func (s *Server) handleRegister(w http.ResponseWriter, r *http.Request) {
	p := s.pageFor(r, nil)
	form := registerForm{Username: strings.TrimSpace(r.PostFormValue("username")), Email: strings.TrimSpace(r.PostFormValue("email")), Remember: r.PostFormValue("remember") == "1"}
	if r.PostFormValue("password") != r.PostFormValue("password_confirm") {
		form.Error = s.i18n.T(p.Locale, "register.mismatch")
		s.render(w, http.StatusUnprocessableEntity, "register", "auth_layout", withData(p, form))
		return
	}
	opts := api.LoginOptions{Remember: form.Remember, DeviceKey: r.PostFormValue("device_key")}
	resp, err := s.api.Register(r.Context(), form.Username, r.PostFormValue("password"), form.Email, opts)
	if err != nil {
		form.Error = s.apiErrorText(p, err)
		s.render(w, api.AsError(err).Status, "register", "auth_layout", withData(p, form))
		return
	}
	relayCookies(w, resp)
	http.Redirect(w, r, "/", http.StatusSeeOther)
}

// registrationView: the registration form in Admin → Invite Policies.
type registrationView struct {
	api.Registration
	URL string
}

func (s *Server) handleRegistrationSettings(w http.ResponseWriter, r *http.Request, p Page) {
	roleID, _ := strconv.ParseInt(r.PostFormValue("role_id"), 10, 64)
	in := api.Registration{Enabled: r.PostFormValue("enabled") == "true", RoleID: roleID}
	if err := s.api.SaveRegistration(r.Context(), session(r), in); err != nil {
		s.failTo(w, r, p, err, "#registration-flash")
		return
	}
	s.flashTo(w, p, "registration.saved", "#registration-flash")
}
