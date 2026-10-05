package main

import (
	"strings"
	"sync"
	"time"
)

// Brute-force guard of the sign-in: failed passwords and 2FA codes are
// counted per client IP and per account name in a sliding window. Too many
// failures block further tries for the rest of the window (429), also with
// the right password, so guessing stays slow. A success clears the counts of
// that IP and account.
const (
	loginWindow     = 15 * time.Minute
	loginMaxPerIP   = 10 // failures per IP and window
	loginMaxPerUser = 20 // failures per account and window (several IPs)
	ticketMaxTries  = 5  // wrong 2FA codes per login ticket
)

type loginLimiter struct {
	mu   sync.Mutex
	fail map[string][]time.Time
}

func newLoginLimiter() *loginLimiter { return &loginLimiter{fail: map[string][]time.Time{}} }

// logins: the one limiter of the process (password and 2FA step share it).
var logins = newLoginLimiter()

func limitKeys(ip, user string) []string {
	return []string{"ip:" + ip, "user:" + strings.ToLower(strings.TrimSpace(user))}
}

// recent: the failures of a key inside the window; caller holds l.mu.
func (l *loginLimiter) recent(key string, now time.Time) []time.Time {
	list := l.fail[key]
	i := 0
	for i < len(list) && now.Sub(list[i]) >= loginWindow {
		i++
	}
	list = list[i:]
	if len(list) == 0 {
		delete(l.fail, key)
	} else {
		l.fail[key] = list
	}
	return list
}

// blocked: minutes until the next try is allowed (0: allowed).
func (l *loginLimiter) blocked(ip, user string) int {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := time.Now()
	wait := time.Duration(0)
	for i, key := range limitKeys(ip, user) {
		max := loginMaxPerIP
		if i == 1 {
			max = loginMaxPerUser
		}
		if list := l.recent(key, now); len(list) >= max {
			wait = max64(wait, loginWindow-now.Sub(list[len(list)-max]))
		}
	}
	if wait <= 0 {
		return 0
	}
	return int(wait/time.Minute) + 1
}

func (l *loginLimiter) failed(ip, user string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := time.Now()
	for _, key := range limitKeys(ip, user) {
		l.fail[key] = append(l.recent(key, now), now)
		if len(l.fail[key]) > 100 {
			l.fail[key] = l.fail[key][len(l.fail[key])-100:]
		}
	}
	// keep the map small: forget idle keys now and then
	if len(l.fail) > 10000 {
		for k := range l.fail {
			l.recent(k, now)
		}
	}
}

func (l *loginLimiter) succeeded(ip, user string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	for _, key := range limitKeys(ip, user) {
		delete(l.fail, key)
	}
}

func max64(a, b time.Duration) time.Duration {
	if a > b {
		return a
	}
	return b
}
