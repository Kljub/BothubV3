package main

import (
	"net/http"
	"slices"
)

// Bot limits per role (Users & Roles): how many bots a user may own, how
// many of them may run at the same time, and after how many hours without
// use a running bot is stopped (the NodeCore does the stopping). nil = no
// limit; instance admins (admin.access) never have limits.
type roleLimits struct {
	MaxBots       *int `json:"maxBots,omitempty"`
	MaxRunning    *int `json:"maxRunning,omitempty"`
	IdleStopHours *int `json:"idleStopHours,omitempty"`
}

// clean keeps values 0..10000 (anything else: no limit).
func (l roleLimits) clean() roleLimits {
	ok := func(p *int) *int {
		if p == nil || *p < 0 || *p > 10000 {
			return nil
		}
		v := *p
		return &v
	}
	return roleLimits{MaxBots: ok(l.MaxBots), MaxRunning: ok(l.MaxRunning), IdleStopHours: ok(l.IdleStopHours)}
}

// limitsOf: the limits of a user's role (none for admins and unknown users); caller holds s.mu.
func (s *store) limitsOf(userID int64) roleLimits {
	u := s.userByID(userID)
	if u == nil || slices.Contains(s.permissionsOf(u), "admin.access") {
		return roleLimits{}
	}
	if ro := s.roleByID(u.RoleID); ro != nil {
		return ro.Limits
	}
	return roleLimits{}
}

// canCreateBot answers 409 when the user owns as many bots as the role allows; caller holds s.mu.
func (s *store) canCreateBot(w http.ResponseWriter, userID int64) bool {
	l := s.limitsOf(userID)
	if l.MaxBots == nil {
		return true
	}
	n := 0
	for _, b := range s.bots {
		if b.OwnerID == userID {
			n++
		}
	}
	if n >= *l.MaxBots {
		apiErrorParams(w, 409, "error.limit.bots", map[string]any{"max": *l.MaxBots})
		return false
	}
	return true
}

// canRunBot answers 409 when the owner of b already has as many bots online
// as the role allows (b itself not counted); caller holds s.mu.
func (s *store) canRunBot(w http.ResponseWriter, b *bot) bool {
	if b.Status == "running" || b.Status == "starting" {
		return true // a restart does not add a bot
	}
	l := s.limitsOf(b.OwnerID)
	if l.MaxRunning == nil {
		return true
	}
	n := 0
	for _, o := range s.bots {
		if o.ID != b.ID && o.OwnerID == b.OwnerID && (o.Status == "running" || o.Status == "starting") {
			n++
		}
	}
	if n >= *l.MaxRunning {
		apiErrorParams(w, 409, "error.limit.running", map[string]any{"max": *l.MaxRunning})
		return false
	}
	return true
}
