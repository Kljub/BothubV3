package web

import (
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"sync"

	"github.com/Kljub/BothubV3/dashboard/internal/api"
)

// Errors page (/bots/errors): failed runs of the bot's commands and custom
// events from the last 7 days, each with the block, the reason in plain
// words and how to fix it (shared/run-errors.json, the same texts the bot
// sends), who ran it and where. Dismiss hides one, Mute hides the same
// error of the same block for good (no alerts, no fix tips), Show in
// builder opens the run's playback.

type runText struct {
	Text string `json:"text"`
	Fix  string `json:"fix"`
}

var (
	runTextsOnce sync.Once
	runTexts     map[string]map[string]runText
)

// loadRunTexts reads SHARED_DIR/run-errors.json once ({key: {en, de}}).
func loadRunTexts() map[string]map[string]runText {
	runTextsOnce.Do(func() {
		dir := os.Getenv("SHARED_DIR")
		if dir == "" {
			dir = "/shared"
		}
		raw, err := os.ReadFile(filepath.Join(dir, "run-errors.json"))
		if err != nil {
			return
		}
		all := map[string]json.RawMessage{}
		if json.Unmarshal(raw, &all) != nil {
			return
		}
		runTexts = map[string]map[string]runText{}
		for k, v := range all {
			var e map[string]runText
			if json.Unmarshal(v, &e) == nil {
				runTexts[k] = e
			}
		}
	})
	return runTexts
}

var hintParam = regexp.MustCompile(`\{([a-z]+)\}`)

// localHint is the reason and fix of a run in the page's language; the
// English text the bot stored when there is no translation.
func localHint(h *api.RunHint, locale string) (string, string) {
	if h == nil {
		return "", ""
	}
	if t, ok := loadRunTexts()[h.Key][locale]; ok && t.Text != "" {
		fill := func(s string) string {
			return hintParam.ReplaceAllStringFunc(s, func(m string) string {
				if v, ok := h.Params[m[1:len(m)-1]]; ok {
					return v
				}
				return m
			})
		}
		return fill(t.Text), fill(t.Fix)
	}
	return h.Text, h.Fix
}

type errorRow struct {
	api.Run
	When       string
	Reason     string
	Fix        string
	Discord    string // Discord's own message, when the reason is ours
	BuilderURL string
}

type errorsView struct {
	BotID     int64
	WithMuted bool
	Rows      []errorRow
}

func (s *Server) errorsView(r *http.Request, p Page, botID int64) (errorsView, error) {
	withMuted := r.URL.Query().Get("muted") == "1"
	runs, err := s.api.RunErrors(r.Context(), session(r), botID, withMuted)
	if err != nil {
		return errorsView{}, err
	}
	v := errorsView{BotID: botID, WithMuted: withMuted}
	for _, run := range runs {
		row := errorRow{Run: run, When: run.Time.Local().Format("02.01. 15:04")}
		row.Reason, row.Fix = localHint(run.ErrorHint, p.Locale)
		msg := derefOr(run.ErrorText)
		if row.Reason == "" {
			row.Reason = msg
			if row.Reason == "" {
				row.Reason = s.i18n.T(p.Locale, "errors.unknown")
			}
		} else if msg != "" && msg != row.Reason {
			row.Discord = msg
		}
		builder := "/bots/builder/"
		if run.CommandKind == "event" {
			builder = "/bots/events/builder/"
		}
		row.BuilderURL = fmt.Sprintf("%s%d?run=%d", builder, run.CommandID, run.ID)
		v.Rows = append(v.Rows, row)
	}
	return v, nil
}

func derefOr(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}

// handleBotErrors re-renders the list (refresh, muted filter, polling).
func (s *Server) handleBotErrors(w http.ResponseWriter, r *http.Request, p Page) {
	id, ok := s.botID(w, r, p)
	if !ok {
		return
	}
	v, err := s.errorsView(r, p, id)
	if err != nil {
		s.fail(w, r, p, err)
		return
	}
	s.render(w, http.StatusOK, "bot", "bot_errors_fragment", withData(p, v))
}

// handleRunAction: dismiss, mute or unmute one error, or dismiss all.
func (s *Server) handleRunAction(w http.ResponseWriter, r *http.Request, p Page) {
	id, ok := s.botID(w, r, p)
	if !ok {
		return
	}
	var err error
	ctx, sess := r.Context(), session(r)
	if r.PathValue("rid") == "" {
		err = s.api.DismissAllRuns(ctx, sess, id)
	} else {
		rid, perr := strconv.ParseInt(r.PathValue("rid"), 10, 64)
		if perr != nil {
			s.fail(w, r, p, &api.Error{Status: http.StatusNotFound, Key: "error.not_found"})
			return
		}
		switch r.PathValue("action") {
		case "dismiss":
			err = s.api.DismissRun(ctx, sess, id, rid)
		case "mute":
			err = s.api.MuteRun(ctx, sess, id, rid, true)
		case "unmute":
			err = s.api.MuteRun(ctx, sess, id, rid, false)
		default:
			err = &api.Error{Status: http.StatusNotFound, Key: "error.not_found"}
		}
	}
	if err != nil {
		s.fail(w, r, p, err)
		return
	}
	s.handleBotErrors(w, r, p)
}

// localRunTexts are the reasons and fixes in one language, for the builder's Playbacks.
func localRunTexts(locale string) map[string]runText {
	out := map[string]runText{}
	for k, v := range loadRunTexts() {
		if t, ok := v[locale]; ok {
			out[k] = t
		} else if t, ok := v["en"]; ok {
			out[k] = t
		}
	}
	return out
}

// openRunID is ?run=… of the builder (Show in builder on the Errors page), 0 without.
func openRunID(r *http.Request) int64 {
	id, err := strconv.ParseInt(r.URL.Query().Get("run"), 10, 64)
	if err != nil || id < 1 {
		return 0
	}
	return id
}
