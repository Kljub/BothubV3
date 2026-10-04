package main

import (
	"net/http/httptest"
	"slices"
	"testing"
)

func TestBotAccess(t *testing.T) {
	s := &store{}
	s.seedUsers()
	owner := &mockUser{ID: 1, RoleID: 2}
	viewer := &mockUser{ID: 2, RoleID: 2}
	builder := &mockUser{ID: 3, RoleID: 2}
	stranger := &mockUser{ID: 4, RoleID: 2}
	admin := &mockUser{ID: 5, RoleID: 1}
	b := &bot{ID: 9, OwnerID: 1, Members: []botMember{{UserID: 2, Role: "viewer"}, {UserID: 3, Role: "builder"}}}
	check := func(u *mockUser, method, path string, wantFound, wantOK bool) {
		t.Helper()
		found, ok := s.allowed(u, b, httptest.NewRequest(method, path, nil))
		if found != wantFound || ok != wantOK {
			t.Errorf("user %d %s %s: found=%v ok=%v, want %v %v", u.ID, method, path, found, ok, wantFound, wantOK)
		}
	}
	check(owner, "DELETE", "/api/v1/bots/9", true, true)
	check(admin, "POST", "/api/v1/bots/9/stop", true, true)
	check(stranger, "GET", "/api/v1/bots/9", false, false)
	check(viewer, "GET", "/api/v1/bots/9/commands", true, true)
	check(viewer, "PUT", "/api/v1/bots/9/commands/4", true, false)
	check(viewer, "POST", "/api/v1/bots/9/start", true, false)
	check(builder, "PUT", "/api/v1/bots/9/commands/4", true, true)
	check(builder, "PUT", "/api/v1/bots/9/modules/economy", true, true)
	check(builder, "PATCH", "/api/v1/bots/9", true, false)
	check(builder, "DELETE", "/api/v1/bots/9", true, false)
	check(builder, "PUT", "/api/v1/bots/9/members/7", true, false)
	check(viewer, "GET", "/api/v1/bots/9/data/variables", true, false)
	_, perms, _ := s.botAccess(&mockUser{ID: 6, RoleID: 2}, &bot{OwnerID: 1, Members: []botMember{{UserID: 6, Role: "custom", Permissions: []string{"bot.control", "evil.power"}}}})
	if !slices.Equal(perms, []string{"bot.control"}) {
		t.Errorf("custom: %v", perms)
	}
}
