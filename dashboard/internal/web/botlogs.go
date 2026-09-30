package web

import (
	"fmt"
	"net/http"
	"slices"

	"github.com/Kljub/BothubV3/dashboard/internal/api"
)

// logsView is the data for the "bot_logs" template.
type logsView struct {
	BotID  int64
	Level  string // "" = all
	Levels []string
	Rows   []logRow
}

type logRow struct {
	Time   string
	Icon   string
	Level  string
	Code   string // ERR-1xxx / WAR-2xxx, empty for changes and updates
	Text   string
	Change string // "old → new", only for changes
	Source string // server logs: api, botcore, plugin_manager, discord_api, redis
	Actor  string // server logs: user who caused it
}

var logIcons = map[string]string{"error": "❌", "warning": "⚠️", "change": "🔧", "update": "🔄"}

// handleBotLogs re-renders the log console (refresh button, filter, polling).
func (s *Server) handleBotLogs(w http.ResponseWriter, r *http.Request, p Page) {
	id, ok := s.botID(w, r, p)
	if !ok {
		return
	}
	v, err := s.botLogs(r, p, id)
	if err != nil {
		s.fail(w, r, p, err)
		return
	}
	s.render(w, http.StatusOK, "bot", "bot_logs_fragment", withData(p, v))
}

func (s *Server) handleClearLogs(w http.ResponseWriter, r *http.Request, p Page) {
	id, ok := s.botID(w, r, p)
	if !ok {
		return
	}
	if err := s.api.ClearLogs(r.Context(), session(r), id); err != nil {
		s.fail(w, r, p, err)
		return
	}
	s.handleBotLogs(w, r, p)
}

func (s *Server) botLogs(r *http.Request, p Page, botID int64) (logsView, error) {
	level := r.URL.Query().Get("level")
	if !slices.Contains(api.LogLevels, level) {
		level = ""
	}
	entries, err := s.api.Logs(r.Context(), session(r), botID, level)
	if err != nil {
		return logsView{}, err
	}
	return logsView{BotID: botID, Level: level, Levels: api.LogLevels, Rows: s.logRows(entries, p.Locale)}, nil
}

// logRows turns API entries into console rows (bot and server logs).
func (s *Server) logRows(entries []api.LogEntry, locale string) []logRow {
	rows := make([]logRow, 0, len(entries))
	for _, e := range entries {
		row := logRow{
			Time:   e.Time.Local().Format("15:04:05"),
			Icon:   logIcons[e.Level],
			Level:  e.Level,
			Source: e.Source,
			Actor:  e.Actor,
			Text:   s.i18n.T(locale, e.Key, flatten(e.Params)...),
		}
		if e.Code != nil {
			row.Code = *e.Code
		}
		// Secret changes (token) come without values; show only the message then.
		if e.Change != nil && (e.Change.Old != nil || e.Change.New != nil) {
			row.Change = fmt.Sprintf("%s → %s", orDash(e.Change.Old), orDash(e.Change.New))
		}
		rows = append(rows, row)
	}
	return rows
}

func orDash(s *string) string {
	if s == nil || *s == "" {
		return "–"
	}
	return *s
}
