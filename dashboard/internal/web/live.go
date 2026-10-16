package web

import (
	"encoding/json"
	"fmt"
	"net/http"
	"time"

	"github.com/Kljub/BothubV3/dashboard/internal/api"
)

// livePing keeps the stream open through proxies; liveRecheck ends it when
// the session ran out.
const (
	livePing    = 25 * time.Second
	liveRecheck = 5 * time.Minute
)

// liveBot is one "bot" event of /live: the new status with the texts of the
// sidebar, so the page shows it without a request; tiles and the bot header
// reload themselves.
type liveBot struct {
	ID     int64  `json:"id"`
	Status string `json:"status"`
	Label  string `json:"label"`
	Light  string `json:"light"`
	Tip    string `json:"tip"`
}

// freshRead: a reload after a live update (header X-BotHub-Fresh from the
// page) reads the bot without the gateway's one-second cache.
func freshRead(r *http.Request) *http.Request {
	if r.Header.Get("X-BotHub-Fresh") == "1" {
		return r.WithContext(api.Fresh(r.Context()))
	}
	return r
}

// handleLive streams live updates (Server-Sent Events) to an open tab: the
// notes of the bot (Redis bothub:live), each only for bots this account may
// see. Without Redis the answer is 204, which stops the browser from
// reconnecting; the pages poll instead.
func (s *Server) handleLive(w http.ResponseWriter, r *http.Request, p Page) {
	if s.live == nil {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	rc := http.NewResponseController(w)
	_ = rc.SetWriteDeadline(time.Time{}) // the server's write timeout would end the stream
	h := w.Header()
	h.Set("Content-Type", "text/event-stream")
	h.Set("Cache-Control", "no-cache")
	h.Set("X-Accel-Buffering", "no") // nginx in front: do not buffer
	notes, cancel := s.live.Subscribe()
	defer cancel()
	// hello: the boot id of this dashboard. A page of an older start (before
	// an update) reloads itself when its stream reconnects.
	if _, err := fmt.Fprintf(w, "retry: 5000\n\nevent: hello\ndata: {\"boot\":%q}\n\n", s.bootID); err != nil {
		return
	}
	_ = rc.Flush()

	sess := session(r)
	ping := time.NewTicker(livePing)
	defer ping.Stop()
	recheck := time.NewTicker(liveRecheck)
	defer recheck.Stop()
	for {
		select {
		case <-r.Context().Done():
			return
		case <-ping.C:
			if _, err := fmt.Fprint(w, ": ping\n\n"); err != nil {
				return
			}
		case <-recheck.C:
			if _, err := s.api.Me(r.Context(), sess); api.IsStatus(err, http.StatusUnauthorized) {
				return
			}
			continue
		case note := <-notes:
			var n struct {
				Type  string `json:"type"`
				BotID int64  `json:"botId"`
			}
			if json.Unmarshal(note, &n) != nil || (n.Type != "bot.status" && n.Type != "plugin.tasks") || n.BotID <= 0 {
				continue
			}
			// GetBot answers only for bots of this account: that is the access check.
			bot, err := s.api.GetBot(api.Fresh(r.Context()), sess, n.BotID)
			if err != nil {
				if api.IsStatus(err, http.StatusUnauthorized) {
					return
				}
				continue
			}
			if n.Type == "plugin.tasks" {
				// A plugin process changed state: the task manager reloads.
				if _, err := fmt.Fprintf(w, "event: tasks\ndata: {\"id\":%d}\n\n", bot.ID); err != nil {
					return
				}
				break
			}
			light := s.botLight(bot, p.Locale)
			data, _ := json.Marshal(liveBot{bot.ID, bot.Status, s.i18n.T(p.Locale, "bot.status."+bot.Status), light.Class, light.Tip})
			if _, err := fmt.Fprintf(w, "event: bot\ndata: %s\n\n", data); err != nil {
				return
			}
		}
		if rc.Flush() != nil {
			return
		}
	}
}
