package web

import (
	"net/http"
	"strings"
)

// Security & sign-in tab of the user settings: active sessions and the
// security history of the signed-in user.

type sessionRow struct {
	ID       string
	Current  bool
	Device   string
	IP       string
	LastSeen string
	Created  string
}

type sessionsView struct {
	Items  []sessionRow
	Notice string
}

type activityRow struct {
	Type   string
	Failed bool
	Device string
	IP     string
	When   string
}

// deviceLabel turns a User-Agent into "Chrome · Windows" (best effort).
func deviceLabel(ua string) string {
	browser := ""
	for _, b := range []struct{ token, name string }{
		{"Edg/", "Edge"}, {"OPR/", "Opera"}, {"Brave", "Brave"}, {"Vivaldi", "Vivaldi"}, {"Firefox/", "Firefox"},
		{"Chrome/", "Chrome"}, {"Safari/", "Safari"}, {"curl/", "curl"},
	} {
		if strings.Contains(ua, b.token) {
			browser = b.name
			break
		}
	}
	system := ""
	for _, o := range []struct{ token, name string }{
		{"Windows", "Windows"}, {"Android", "Android"}, {"iPhone", "iOS"}, {"iPad", "iPadOS"}, {"Mac OS X", "macOS"}, {"Linux", "Linux"},
	} {
		if strings.Contains(ua, o.token) {
			system = o.name
			break
		}
	}
	switch {
	case browser != "" && system != "":
		return browser + " · " + system
	case browser != "":
		return browser
	case system != "":
		return system
	case ua != "":
		if len(ua) > 40 {
			return ua[:40] + "…"
		}
		return ua
	}
	return "?"
}

func (s *Server) renderSessions(w http.ResponseWriter, r *http.Request, p Page, notice string) {
	list, err := s.api.Sessions(r.Context(), session(r))
	if err != nil {
		s.failTo(w, r, p, err, "#account-flash")
		return
	}
	v := sessionsView{Notice: notice}
	for _, x := range list {
		v.Items = append(v.Items, sessionRow{
			ID: x.ID, Current: x.Current, Device: deviceLabel(x.UserAgent), IP: x.IP,
			LastSeen: formatDateTime(x.LastSeenAt, p.Locale), Created: formatDateTime(x.CreatedAt, p.Locale),
		})
	}
	s.render(w, http.StatusOK, "error", "sessions_fragment", withData(p, v))
}

func (s *Server) handleSessions(w http.ResponseWriter, r *http.Request, p Page) {
	s.renderSessions(w, r, p, "")
}

func (s *Server) handleRevokeSession(w http.ResponseWriter, r *http.Request, p Page) {
	if err := s.api.RevokeSession(r.Context(), session(r), r.PathValue("sid")); err != nil {
		s.failTo(w, r, p, err, "#account-flash")
		return
	}
	s.renderSessions(w, r, p, "settings.security.signed_out")
}

func (s *Server) handleRevokeOtherSessions(w http.ResponseWriter, r *http.Request, p Page) {
	if _, err := s.api.RevokeOtherSessions(r.Context(), session(r)); err != nil {
		s.failTo(w, r, p, err, "#account-flash")
		return
	}
	s.renderSessions(w, r, p, "settings.security.signed_out_others")
}

// failedEvents are shown with a warning sign.
var failedEvents = map[string]bool{"login_failed": true}

func (s *Server) handleSecurityActivity(w http.ResponseWriter, r *http.Request, p Page) {
	events, err := s.api.SecurityActivity(r.Context(), session(r))
	if err != nil {
		s.failTo(w, r, p, err, "#account-flash")
		return
	}
	rows := make([]activityRow, 0, len(events))
	for _, e := range events {
		rows = append(rows, activityRow{Type: e.Type, Failed: failedEvents[e.Type], Device: deviceLabel(e.UserAgent), IP: e.IP, When: formatDateTime(e.Time, p.Locale)})
	}
	s.render(w, http.StatusOK, "error", "activity_fragment", withData(p, rows))
}
