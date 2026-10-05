package main

import (
	"context"
	"log/slog"
	"net/http"
	"net/netip"
	"slices"
	"strings"
	"time"
)

// Security policies (Admin → Security Policies, settings key "security"):
//   - IP blocklist: addresses or CIDR ranges that get no answer at all
//     (sign-in included). Loopback is never blocked, and an admin cannot
//     block the address they are using.
//   - 2FA required for admins / for everyone: without 2FA (or a passkey) the
//     account can still read and set up 2FA, but changes nothing else.
//   - Sign-in lock: failures per IP before the lock, and its minutes.

type securityPolicy struct {
	IPBlocklist      []string `json:"ipBlocklist"`
	Require2FAAdmins bool     `json:"require2faAdmins"`
	Require2FAAll    bool     `json:"require2faAll"`
	LoginMaxFailures int      `json:"loginMaxFailures"`
	LoginLockMinutes int      `json:"loginLockMinutes"`
}

const maxBlocklist = 500

// normalize: limits in range, blocklist entries as clean prefixes; bad
// entries are returned for the error message.
func (p securityPolicy) normalize() (securityPolicy, []string) {
	if p.LoginMaxFailures < 3 || p.LoginMaxFailures > 100 {
		p.LoginMaxFailures = loginMaxPerIP
	}
	if p.LoginLockMinutes < 1 || p.LoginLockMinutes > 1440 {
		p.LoginLockMinutes = int(loginWindow / time.Minute)
	}
	var clean, bad []string
	for _, e := range p.IPBlocklist {
		e = strings.TrimSpace(e)
		if e == "" {
			continue
		}
		if pr, ok := parsePrefix(e); ok {
			if !slices.Contains(clean, pr.String()) {
				clean = append(clean, pr.String())
			}
		} else {
			bad = append(bad, e)
		}
	}
	if len(clean) > maxBlocklist {
		clean = clean[:maxBlocklist]
	}
	p.IPBlocklist = clean
	if p.IPBlocklist == nil {
		p.IPBlocklist = []string{}
	}
	return p, bad
}

// parsePrefix: "1.2.3.4", "2001:db8::1" or a CIDR range.
func parsePrefix(s string) (netip.Prefix, bool) {
	if strings.Contains(s, "/") {
		pr, err := netip.ParsePrefix(s)
		return pr.Masked(), err == nil
	}
	a, err := netip.ParseAddr(s)
	if err != nil {
		return netip.Prefix{}, false
	}
	return netip.PrefixFrom(a.Unmap(), a.Unmap().BitLen()), true
}

// ipBlocked: the address is in the blocklist (loopback never is).
func ipBlocked(list []string, ip string) bool {
	a, err := netip.ParseAddr(strings.TrimSpace(ip))
	if err != nil || a.IsLoopback() {
		return false
	}
	a = a.Unmap()
	for _, e := range list {
		if pr, ok := parsePrefix(e); ok && pr.Contains(a) {
			return true
		}
	}
	return false
}

// blocklistMiddleware answers 403 to blocked addresses before any route.
func (s *store) blocklistMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		s.mu.Lock()
		list := s.security.IPBlocklist
		s.mu.Unlock()
		if len(list) > 0 && ipBlocked(list, clientIP(r)) {
			apiError(w, 403, "error.security.ip_blocked")
			return
		}
		next.ServeHTTP(w, r)
	})
}

// needs2FA: the policy asks this user for 2FA and they have neither TOTP nor a passkey; caller holds s.mu.
func (s *store) needs2FA(u *mockUser) bool {
	if u == nil || (!s.security.Require2FAAll && !s.security.Require2FAAdmins) {
		return false
	}
	if !s.security.Require2FAAll && !slices.Contains(s.permissionsOf(u), "admin.access") {
		return false
	}
	if u.totpSecret != "" {
		return false
	}
	return s.passkeys == nil || !s.passkeys.has(u.ID)
}

// allowedWithout2FA: what an account that still has to set up 2FA may do:
// read (except the admin area) and everything of its own sign-in.
func allowedWithout2FA(r *http.Request) bool {
	if strings.HasPrefix(r.URL.Path, "/api/v1/auth/") || r.URL.Path == "/api/v1/settings" {
		return true
	}
	return r.Method == http.MethodGet && !strings.HasPrefix(r.URL.Path, "/api/v1/admin/")
}

func (s *store) loadSecurity() {
	p, _ := securityPolicy{}.normalize()
	if s.php != nil {
		var out struct{ Value *securityPolicy }
		in := securityPolicy{}
		out.Value = &in
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if err := s.php.do(ctx, http.MethodGet, "/internal/settings/security", nil, &out); err != nil {
			slog.Error("mockapi: security policies not loaded", "err", err)
		} else {
			p, _ = in.normalize()
		}
	}
	s.mu.Lock()
	s.security = p
	s.mu.Unlock()
	logins.configure(p.LoginMaxFailures, time.Duration(p.LoginLockMinutes)*time.Minute)
}

func (s *store) getSecurity(w http.ResponseWriter, r *http.Request, _ string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	writeJSON(w, 200, map[string]any{"policy": s.security, "yourIp": clientIP(r)})
}

func (s *store) putSecurity(w http.ResponseWriter, r *http.Request, sid string) {
	var in securityPolicy
	if !readJSON(w, r, &in) {
		return
	}
	p, bad := in.normalize()
	if len(bad) > 0 {
		apiErrorParams(w, 422, "error.security.bad_ip", map[string]any{"value": bad[0]})
		return
	}
	if ipBlocked(p.IPBlocklist, clientIP(r)) {
		apiErrorParams(w, 422, "error.security.self_block", map[string]any{"value": clientIP(r)})
		return
	}
	s.mu.Lock()
	// An admin cannot lock themself out: 2FA for admins needs 2FA on this account first.
	if (p.Require2FAAdmins || p.Require2FAAll) && !(s.security.Require2FAAdmins || s.security.Require2FAAll) {
		old := s.security
		s.security = p
		self := s.needs2FA(s.sessUser(sid))
		s.security = old
		if self {
			s.mu.Unlock()
			apiError(w, 422, "error.security.self_2fa")
			return
		}
	}
	s.security = p
	if s.php != nil {
		go s.phpSync(http.MethodPut, "/internal/settings/security", p)
	}
	s.addServerLog(time.Now(), "change", "", "log.server.security_changed", "api", s.nameOfLocked(sid), nil, nil)
	s.mu.Unlock()
	logins.configure(p.LoginMaxFailures, time.Duration(p.LoginLockMinutes)*time.Minute)
	writeJSON(w, 200, p)
}
