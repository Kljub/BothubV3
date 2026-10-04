package main

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"slices"
	"sort"
	"strings"
	"time"
)

// Account security for the user settings: active sessions (sign out one or
// all others) and the security history (sign-ins, failed sign-ins, password,
// email, 2FA and passkey changes). The dashboard passes the browser's
// User-Agent and IP in X-BotHub-Client-Agent / X-BotHub-Client-IP, because it
// calls this API itself.

const maxSecurityEvents = 200

type securityEvent struct {
	userID    int64 // whose history (0: unknown user, shown to nobody)
	ID        string    `json:"id"`
	Type      string    `json:"type"`
	Time      time.Time `json:"time"`
	IP        string    `json:"ip"`
	UserAgent string    `json:"userAgent"`
}

func clientAgent(r *http.Request) string {
	if v := r.Header.Get("X-BotHub-Client-Agent"); v != "" {
		return truncate(v, 300)
	}
	return truncate(r.UserAgent(), 300)
}

func clientIP(r *http.Request) string {
	if v := r.Header.Get("X-BotHub-Client-IP"); v != "" {
		return truncate(v, 64)
	}
	host := r.RemoteAddr
	if i := strings.LastIndexByte(host, ':'); i > 0 {
		host = host[:i]
	}
	return host
}

// addSecurityEvent keeps the newest events. Caller holds s.mu.
func (s *store) addSecurityEvent(r *http.Request, userID int64, typ string) {
	s.secEvents = append(s.secEvents, securityEvent{userID: userID, ID: randomHex(8), Type: typ, Time: time.Now().UTC(), IP: clientIP(r), UserAgent: clientAgent(r)})
	if n := len(s.secEvents); n > maxSecurityEvents {
		s.secEvents = s.secEvents[n-maxSecurityEvents:]
	}
}

// statusRecorder keeps the status and the start of the body of an answer.
type statusRecorder struct {
	http.ResponseWriter
	status int
	head   bytes.Buffer
}

func (w *statusRecorder) WriteHeader(code int) {
	w.status = code
	w.ResponseWriter.WriteHeader(code)
}

func (w *statusRecorder) Write(b []byte) (int, error) {
	if w.status == 0 {
		w.status = 200
	}
	if w.head.Len() < 512 {
		w.head.Write(b[:min(len(b), 512-w.head.Len())])
	}
	return w.ResponseWriter.Write(b)
}

// audited records ok on a 2xx answer and failed (if set) on the listed
// error keys, e.g. a wrong password at sign-in. The event belongs to the
// signed-in user, the user of a new session, or the user named in the
// sign-in request (username or 2FA ticket).
func (s *store) audited(ok, failed string, failKeys []string, next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var named struct{ Username, Ticket string }
		if r.Body != nil && r.Method == http.MethodPost {
			raw, _ := io.ReadAll(io.LimitReader(r.Body, 1<<20))
			_ = json.Unmarshal(raw, &named)
			r.Body = io.NopCloser(bytes.NewReader(raw))
		}
		s.mu.Lock()
		var userID int64
		if u := s.sessUserFromRequest(r); u != nil {
			userID = u.ID
		} else if u := s.userByName(named.Username); named.Username != "" && u != nil {
			userID = u.ID
		} else if t, ok := s.tickets[named.Ticket]; ok {
			userID = t.userID
		}
		s.mu.Unlock()
		rec := &statusRecorder{ResponseWriter: w}
		next(rec, r)
		typ := ""
		switch {
		case rec.status >= 200 && rec.status < 300:
			typ = ok
		case failed != "":
			var e struct {
				Error struct {
					Key string `json:"key"`
				} `json:"error"`
			}
			_ = json.Unmarshal(rec.head.Bytes(), &e)
			if slices.Contains(failKeys, e.Error.Key) {
				typ = failed
			}
		}
		if typ != "" {
			s.mu.Lock()
			// A new session (sign-in) names its user.
			for _, c := range (&http.Response{Header: rec.Header()}).Cookies() {
				if c.Name == "bothub_session" && c.Value != "" {
					if sess := s.sessions[sessionKey(c.Value)]; sess != nil {
						userID = sess.userID
					}
				}
			}
			s.addSecurityEvent(r, userID, typ)
			s.mu.Unlock()
		}
	}
}

// auditedAuth is audited for routes behind s.auth.
func (s *store) auditedAuth(typ string, next authed) authed {
	return func(w http.ResponseWriter, r *http.Request, sid string) {
		s.audited(typ, "", nil, func(w http.ResponseWriter, r *http.Request) { next(w, r, sid) })(w, r)
	}
}

func (s *store) listSessions(w http.ResponseWriter, r *http.Request, sid string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	items := []map[string]any{}
	me := s.sessions[sid].userID
	for key, sess := range s.sessions {
		if sess.userID != me || time.Now().After(sess.expiresAt) {
			continue
		}
		items = append(items, map[string]any{
			"id": sess.id, "current": key == sid, "createdAt": sess.createdAt, "lastSeenAt": sess.lastSeen,
			"userAgent": sess.userAgent, "ip": sess.ip, "remember": sess.remember, "deviceBound": sess.deviceKey != "",
			"expiresAt": sess.expiresAt,
		})
	}
	sort.Slice(items, func(i, j int) bool {
		if items[i]["current"].(bool) != items[j]["current"].(bool) {
			return items[i]["current"].(bool)
		}
		return items[i]["lastSeenAt"].(time.Time).After(items[j]["lastSeenAt"].(time.Time))
	})
	writeJSON(w, 200, map[string]any{"items": items})
}

// revokeSession signs one other session out.
func (s *store) revokeSession(w http.ResponseWriter, r *http.Request, sid string) {
	id := r.PathValue("sessionId")
	s.mu.Lock()
	defer s.mu.Unlock()
	me := s.sessions[sid].userID
	for key, sess := range s.sessions {
		if sess.id == id && sess.userID == me {
			if key == sid {
				apiError(w, 422, "error.session.current")
				return
			}
			s.dropSession(key)
			w.WriteHeader(204)
			return
		}
	}
	apiError(w, 404, "error.session.unknown")
}

// revokeOtherSessions signs out everywhere except here.
func (s *store) revokeOtherSessions(w http.ResponseWriter, r *http.Request, sid string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	n := 0
	me := s.sessions[sid].userID
	for key, sess := range s.sessions {
		if key != sid && sess.userID == me {
			s.dropSession(key)
			n++
		}
	}
	writeJSON(w, 200, map[string]any{"revoked": n})
}

func (s *store) securityActivity(w http.ResponseWriter, r *http.Request, sid string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	items := make([]securityEvent, 0, len(s.secEvents))
	me := s.sessions[sid].userID
	for i := len(s.secEvents) - 1; i >= 0; i-- {
		if s.secEvents[i].userID == me {
			items = append(items, s.secEvents[i])
		}
	}
	writeJSON(w, 200, map[string]any{"items": items})
}
