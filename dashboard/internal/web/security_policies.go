package web

import (
	"net/http"
	"strconv"
	"strings"

	"github.com/Kljub/BothubV3/dashboard/internal/api"
)

// Admin → Security Policies: IP blocklist, 2FA requirement, sign-in lock.

func (s *Server) handleSecuritySettings(w http.ResponseWriter, r *http.Request, p Page) {
	num := func(name string) int {
		v, _ := strconv.Atoi(strings.TrimSpace(r.PostFormValue(name)))
		return v
	}
	var list []string
	for _, line := range strings.FieldsFunc(r.PostFormValue("ip_blocklist"), func(c rune) bool { return c == '\n' || c == ',' || c == ';' }) {
		if line = strings.TrimSpace(line); line != "" {
			list = append(list, line)
		}
	}
	in := api.SecurityPolicy{
		IPBlocklist:      list,
		Require2FAAdmins: r.PostFormValue("require_2fa_admins") == "true",
		Require2FAAll:    r.PostFormValue("require_2fa_all") == "true",
		LoginMaxFailures: num("login_max_failures"),
		LoginLockMinutes: num("login_lock_minutes"),
	}
	if err := s.api.SaveSecurity(r.Context(), session(r), in); err != nil {
		s.failTo(w, r, p, err, "#security-flash")
		return
	}
	s.flashTo(w, p, "security_policies.saved", "#security-flash")
}
