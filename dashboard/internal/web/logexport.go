package web

import (
	"encoding/json"
	"fmt"
	"net/http"
	"slices"
	"strings"
	"time"

	"github.com/Kljub/BothubV3/dashboard/internal/api"
)

// Log export (bot logs and server logs) as TXT or JSON download, and the
// server log tab of the admin settings.

// logLine renders one entry as a translated text line, the same text the
// console shows.
func (s *Server) logLine(e api.LogEntry, locale string) string {
	var b strings.Builder
	b.WriteString(e.Time.Local().Format("2006-01-02 15:04:05"))
	fmt.Fprintf(&b, " [%s]", strings.ToUpper(e.Level))
	if e.Source != "" {
		fmt.Fprintf(&b, " [%s]", e.Source)
	}
	if e.Code != nil {
		fmt.Fprintf(&b, " [%s]", *e.Code)
	}
	b.WriteString(" " + s.i18n.T(locale, e.Key, flatten(e.Params)...))
	if e.Change != nil && (e.Change.Old != nil || e.Change.New != nil) {
		fmt.Fprintf(&b, " (%s → %s)", orDash(e.Change.Old), orDash(e.Change.New))
	}
	if e.Actor != "" {
		fmt.Fprintf(&b, " — %s", e.Actor)
	}
	return b.String()
}

// writeLogExport sends entries as a file download. format: txt or json.
func (s *Server) writeLogExport(w http.ResponseWriter, entries []api.LogEntry, format, name, locale string) {
	stamp := time.Now().Format("20060102-1504")
	if format == "json" {
		type exported struct {
			api.LogEntry
			Message string `json:"message"`
		}
		out := make([]exported, len(entries))
		for i, e := range entries {
			out[i] = exported{LogEntry: e, Message: s.logLine(e, locale)}
		}
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		w.Header().Set("Content-Disposition", fmt.Sprintf(`attachment; filename="%s-%s.json"`, name, stamp))
		enc := json.NewEncoder(w)
		enc.SetIndent("", "  ")
		_ = enc.Encode(out)
		return
	}
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.Header().Set("Content-Disposition", fmt.Sprintf(`attachment; filename="%s-%s.txt"`, name, stamp))
	for _, e := range entries {
		fmt.Fprintln(w, s.logLine(e, locale))
	}
}

func exportFormat(r *http.Request) string {
	if r.URL.Query().Get("format") == "json" {
		return "json"
	}
	return "txt"
}

func levelParam(r *http.Request) string {
	level := r.URL.Query().Get("level")
	if !slices.Contains(api.LogLevels, level) {
		return ""
	}
	return level
}

// safeFileName keeps letters, digits and dashes for download names.
func safeFileName(v string) string {
	var b strings.Builder
	for _, r := range strings.ToLower(v) {
		switch {
		case r >= 'a' && r <= 'z', r >= '0' && r <= '9':
			b.WriteRune(r)
		case r == ' ' || r == '-' || r == '_':
			b.WriteRune('-')
		}
	}
	if b.Len() == 0 {
		return "bot"
	}
	return b.String()
}

func (s *Server) handleBotLogsExport(w http.ResponseWriter, r *http.Request, p Page) {
	id, ok := s.botID(w, r, p)
	if !ok {
		return
	}
	sess := session(r)
	bot, err := s.api.GetBot(r.Context(), sess, id)
	if err != nil {
		s.fail(w, r, p, err)
		return
	}
	entries, err := s.api.Logs(r.Context(), sess, id, levelParam(r))
	if err != nil {
		s.fail(w, r, p, err)
		return
	}
	s.writeLogExport(w, entries, exportFormat(r), "bothub-"+safeFileName(bot.Name)+"-logs", p.Locale)
}

// --- server logs (admin) ---

func (s *Server) serverLogs(r *http.Request, p Page) (logsView, error) {
	level := levelParam(r)
	entries, err := s.api.ServerLogs(r.Context(), session(r), level)
	if err != nil {
		return logsView{}, err
	}
	v := logsView{Level: level, Levels: api.LogLevels, Rows: s.logRows(entries, p.Locale)}
	return v, nil
}

// handleServerLogs refreshes the server log console (filter, refresh, polling).
func (s *Server) handleServerLogs(w http.ResponseWriter, r *http.Request, p Page) {
	v, err := s.serverLogs(r, p)
	if err != nil {
		s.fail(w, r, p, err)
		return
	}
	s.render(w, http.StatusOK, "admin", "server_logs_fragment", withData(p, v))
}

func (s *Server) handleServerLogsExport(w http.ResponseWriter, r *http.Request, p Page) {
	entries, err := s.api.ServerLogs(r.Context(), session(r), levelParam(r))
	if err != nil {
		s.fail(w, r, p, err)
		return
	}
	s.writeLogExport(w, entries, exportFormat(r), "bothub-server-logs", p.Locale)
}
