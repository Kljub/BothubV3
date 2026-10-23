package main

import (
	"crypto/rand"
	"encoding/base32"
	"net/http"
	"time"
)

// BotHub Guard (like Steam Guard): a paired phone with Guard switched on
// (Settings → Security) is a second sign-in factor.
//   - Approve: after the password the browser waits; the app lists the
//     pending sign-in (address, browser) and the user taps Approve or Deny.
//   - Code: the app shows a 6-digit code (TOTP of the device's guard secret,
//     30 s), typed in like an authenticator code; works offline.
// Approvals live 5 minutes, like the login ticket they belong to.

const approvalTTL = 5 * time.Minute

type loginApproval struct {
	ID        string `json:"id"`
	ticket    string
	userID    int64
	IP        string    `json:"ip"`
	Agent     string    `json:"userAgent"`
	CreatedAt time.Time `json:"createdAt"`
	ExpiresAt time.Time `json:"expiresAt"`
	status    string    // pending, approved, denied
}

// newGuardSecret: 20 random bytes as base32 (the app's code key).
func newGuardSecret() string {
	b := make([]byte, 20)
	_, _ = rand.Read(b)
	return base32.StdEncoding.WithPadding(base32.NoPadding).EncodeToString(b)
}

// guardDevices: the user's phones with Guard on. Caller holds s.mu.
func (s *store) guardDevices(userID int64) []*mobileDevice {
	var out []*mobileDevice
	for _, d := range s.devices {
		if d.UserID == userID && d.Guard && d.GuardSecret != "" {
			out = append(out, d)
		}
	}
	return out
}

// guardCodeValid: a code of one of the user's Guard phones. Caller holds s.mu.
func (s *store) guardCodeValid(userID int64, code string) bool {
	for _, d := range s.guardDevices(userID) {
		if totpValid(d.GuardSecret, code) {
			return true
		}
	}
	return false
}

// newApproval: a pending sign-in for the app. Caller holds s.mu.
func (s *store) newApproval(ticket string, userID int64, r *http.Request) *loginApproval {
	now := time.Now().UTC()
	for id, a := range s.approvals {
		if now.After(a.ExpiresAt) {
			delete(s.approvals, id)
		}
	}
	a := &loginApproval{ID: randomHex(8), ticket: ticket, userID: userID, IP: clientIP(r), Agent: clientAgent(r), CreatedAt: now, ExpiresAt: now.Add(approvalTTL), status: "pending"}
	s.approvals[a.ID] = a
	return a
}

// loginGuard: the browser asks whether the app approved (public; the ticket is the proof).
// 202 pending, 200 + session approved, 401 denied or expired.
func (s *store) loginGuard(w http.ResponseWriter, r *http.Request) {
	var in struct{ Ticket string }
	if !readJSON(w, r, &in) {
		return
	}
	s.mu.Lock()
	t, ok := s.tickets[in.Ticket]
	var a *loginApproval
	for _, x := range s.approvals {
		if x.ticket == in.Ticket {
			a = x
		}
	}
	if !ok || a == nil || time.Now().After(t.expires) || time.Now().After(a.ExpiresAt) {
		s.mu.Unlock()
		apiError(w, 401, "error.auth.ticket_expired")
		return
	}
	switch a.status {
	case "pending":
		s.mu.Unlock()
		writeJSON(w, 202, map[string]string{"status": "pending"})
		return
	case "denied":
		delete(s.tickets, in.Ticket)
		delete(s.approvals, a.ID)
		s.mu.Unlock()
		logins.failed(clientIP(r), "")
		apiError(w, 401, "error.auth.guard_denied")
		return
	}
	delete(s.tickets, in.Ticket)
	delete(s.approvals, a.ID)
	s.trustIP(s.userByID(t.userID), r)
	s.mu.Unlock()
	s.startSession(w, r, 200, t.userID, t.opts)
}

// mobileApprovals: the pending sign-ins of the device's user (Guard phones only).
func (s *store) mobileApprovals(w http.ResponseWriter, r *http.Request, sid string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	_, d := s.deviceOf(sid)
	items := []*loginApproval{}
	if d.Guard {
		now := time.Now()
		for _, a := range s.approvals {
			if a.userID == d.UserID && a.status == "pending" && now.Before(a.ExpiresAt) {
				items = append(items, a)
			}
		}
	}
	writeJSON(w, 200, map[string]any{"items": items})
}

// mobileDecide: the app approves or denies a pending sign-in.
func (s *store) mobileDecide(w http.ResponseWriter, r *http.Request, sid string) {
	var in struct {
		Approve bool `json:"approve"`
	}
	if !readJSON(w, r, &in) {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	_, d := s.deviceOf(sid)
	a := s.approvals[r.PathValue("aid")]
	if !d.Guard || a == nil || a.userID != d.UserID || a.status != "pending" || time.Now().After(a.ExpiresAt) {
		apiError(w, 404, "error.mobile.approval_gone")
		return
	}
	a.status = "denied"
	if in.Approve {
		a.status = "approved"
	}
	writeJSON(w, 200, map[string]string{"status": a.status})
}
