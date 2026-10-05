package main

import (
	"net/http/httptest"
	"testing"
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
	for i := 0; i < loginMaxPerUser; i++ {
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
