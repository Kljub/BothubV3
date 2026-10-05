package main

import (
	"context"
	"net/http/httptest"
	"testing"
	"time"
)

func TestLoginLimiter(t *testing.T) {
	l := newLoginLimiter()
	for i := 0; i < loginMaxPerIP-1; i++ {
		l.failed("1.2.3.4", "ann")
	}
	if l.blocked("1.2.3.4", "ann") != 0 {
		t.Fatal("blocked too early")
	}
	l.failed("1.2.3.4", "ann")
	if l.blocked("1.2.3.4", "bob") == 0 {
		t.Fatal("the IP must be blocked for every name")
	}
	if l.blocked("5.6.7.8", "bob") != 0 {
		t.Fatal("another IP and name stay free")
	}
	l.succeeded("1.2.3.4", "ann")
	if l.blocked("1.2.3.4", "ann") != 0 {
		t.Fatal("a success clears the counts")
	}
	for i := 0; i < 2*loginMaxPerIP; i++ {
		l.failed("10.0.0."+string(rune('a'+i)), "carl")
	}
	if l.blocked("9.9.9.9", "carl") == 0 {
		t.Fatal("an account guessed from many IPs is blocked")
	}
}

func TestRoleLimits(t *testing.T) {
	two, one := 2, 1
	s := &store{bots: map[int64]*bot{}}
	s.seedUsers()
	s.roles[1].Limits = roleLimits{MaxBots: &two, MaxRunning: &one}
	ann := &mockUser{ID: 7, Username: "ann", RoleID: 2}
	adm := &mockUser{ID: 8, Username: "root", RoleID: 1}
	s.users = []*mockUser{ann, adm}
	s.bots[1] = &bot{ID: 1, OwnerID: 7, Status: "running"}
	s.bots[2] = &bot{ID: 2, OwnerID: 7, Status: "stopped"}
	if s.canCreateBot(httptest.NewRecorder(), 7) {
		t.Fatal("ann owns 2 of 2 bots")
	}
	if !s.canCreateBot(httptest.NewRecorder(), 8) {
		t.Fatal("admins have no limit")
	}
	w := httptest.NewRecorder()
	if s.canRunBot(w, s.bots[2]) || w.Code != 409 {
		t.Fatal("only one of ann's bots may run")
	}
	if !s.canRunBot(httptest.NewRecorder(), s.bots[1]) {
		t.Fatal("a restart of a running bot is fine")
	}
	bad := -1
	if (roleLimits{MaxBots: &bad}).clean().MaxBots != nil {
		t.Fatal("negative limits mean no limit")
	}
}

func TestSecurityPolicy(t *testing.T) {
	p, bad := securityPolicy{IPBlocklist: []string{" 203.0.113.7 ", "198.51.100.9/24", "nope", "203.0.113.7"}}.normalize()
	if len(bad) != 1 || bad[0] != "nope" || len(p.IPBlocklist) != 2 || p.IPBlocklist[1] != "198.51.100.0/24" {
		t.Fatalf("normalize: %v %v", p.IPBlocklist, bad)
	}
	if p.LoginMaxFailures != loginMaxPerIP || p.LoginLockMinutes != 15 {
		t.Fatal("defaults for the sign-in lock")
	}
	if !ipBlocked(p.IPBlocklist, "198.51.100.200") || ipBlocked(p.IPBlocklist, "198.51.101.1") || ipBlocked([]string{"127.0.0.0/8"}, "127.0.0.1") {
		t.Fatal("blocklist matching")
	}
	s := &store{bots: map[int64]*bot{}}
	s.seedUsers()
	adm := &mockUser{ID: 1, Username: "root", RoleID: 1}
	usr := &mockUser{ID: 2, Username: "ann", RoleID: 2}
	s.users = []*mockUser{adm, usr}
	s.security = securityPolicy{Require2FAAdmins: true}
	if !s.needs2FA(adm) || s.needs2FA(usr) {
		t.Fatal("2FA for admins only")
	}
	adm.totpSecret = "X"
	if s.needs2FA(adm) {
		t.Fatal("an admin with 2FA is fine")
	}
	s.security.Require2FAAll = true
	if !s.needs2FA(usr) {
		t.Fatal("2FA for everyone")
	}
	get := httptest.NewRequest("GET", "/api/v1/bots", nil)
	post := httptest.NewRequest("POST", "/api/v1/bots/1/start", nil)
	setup := httptest.NewRequest("POST", "/api/v1/auth/2fa/setup", nil)
	admin := httptest.NewRequest("GET", "/api/v1/admin/users", nil)
	if !allowedWithout2FA(get) || allowedWithout2FA(post) || !allowedWithout2FA(setup) || allowedWithout2FA(admin) {
		t.Fatal("without 2FA: read and set up only")
	}
}

func TestMemorySampler(t *testing.T) {
	s := &store{}
	now := time.Now().UTC()
	s.mem.add(memSample{t: now.Add(-8 * 24 * time.Hour), app: 1})
	s.mem.add(memSample{t: now.Add(-2 * time.Hour), app: 100, bot: 50})
	s.mem.add(memSample{t: now.Add(-time.Minute), app: 200, bot: 50})
	if len(s.mem.samples) != 2 {
		t.Fatalf("samples older than 7 days are dropped: %d", len(s.mem.samples))
	}
	if got := s.mem.between(now.Add(-time.Hour), now); len(got) != 1 || got[0].app != 200 {
		t.Fatalf("between: %v", got)
	}
	st := s.memoryStats(context.Background(), "24h", now.Add(-24*time.Hour), now)
	if st["averageBytes"].(int64) != 200 || st["peakBytes"].(int64) < 250 {
		t.Fatalf("stats: %v", st)
	}
}
