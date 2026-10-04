package web

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"strings"
	"time"

	"github.com/Kljub/BothubV3/dashboard/internal/api"
)

// Bot settings > Backup & templates: download, save, save as template,
// load (saved entry, ready-made template or uploaded file), delete.
// Backups never contain the bot token (the API leaves it out).

const maxBackupUpload = 5 << 20

var backupID = regexp.MustCompile(`^[a-z0-9:-]{1,60}$`)

type botBackupView struct {
	BotID   int64
	BotName string
	Items   []api.BotBackup
}

func (s *Server) botBackupView(r *http.Request, bot api.Bot) (botBackupView, error) {
	items, err := s.api.BotBackups(r.Context(), session(r), bot.ID)
	return botBackupView{BotID: bot.ID, BotName: bot.Name, Items: items}, err
}

func (s *Server) renderBackupList(w http.ResponseWriter, r *http.Request, p Page, botID int64) {
	items, err := s.api.BotBackups(r.Context(), session(r), botID)
	if err != nil {
		s.failTo(w, r, p, err, "#backup-error")
		return
	}
	s.render(w, http.StatusOK, "bot", "bot_backup_list_fragment", withData(p, botBackupView{BotID: botID, Items: items}))
}

// handleBackupDownload sends the current state (no id) or a saved entry as a file.
func (s *Server) handleBackupDownload(w http.ResponseWriter, r *http.Request, p Page) {
	id, ok := s.botID(w, r, p)
	if !ok {
		return
	}
	entry := r.URL.Query().Get("id")
	if entry != "" && !backupID.MatchString(entry) {
		s.fail(w, r, p, &api.Error{Status: http.StatusNotFound, Key: "error.backup.unknown"})
		return
	}
	data, err := s.api.BotBackupData(r.Context(), session(r), id, entry)
	if err != nil {
		s.fail(w, r, p, err)
		return
	}
	name := fmt.Sprintf("bothub-bot-%d-%s.json", id, time.Now().UTC().Format("2006-01-02"))
	if entry != "" {
		name = fmt.Sprintf("bothub-%s.json", strings.ReplaceAll(entry, ":", "-"))
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Content-Disposition", `attachment; filename="`+name+`"`)
	_, _ = w.Write(data)
}

func (s *Server) handleBackupSave(w http.ResponseWriter, r *http.Request, p Page) {
	id, ok := s.botID(w, r, p)
	if !ok {
		return
	}
	kind := r.PostFormValue("kind")
	if kind != "template" {
		kind = "backup"
	}
	if err := s.api.SaveBotBackup(r.Context(), session(r), id, kind, strings.TrimSpace(r.PostFormValue("name")), strings.TrimSpace(r.PostFormValue("description"))); err != nil {
		s.failTo(w, r, p, err, "#backup-error")
		return
	}
	w.Header().Set("HX-Trigger", "bothub:reset-forms")
	s.renderBackupList(w, r, p, id)
}

func (s *Server) handleBackupDelete(w http.ResponseWriter, r *http.Request, p Page) {
	id, ok := s.botID(w, r, p)
	if !ok {
		return
	}
	entry := r.PathValue("tid")
	if !backupID.MatchString(entry) {
		s.failTo(w, r, p, &api.Error{Status: http.StatusNotFound, Key: "error.backup.unknown"}, "#backup-error")
		return
	}
	if err := s.api.DeleteBotBackup(r.Context(), session(r), id, entry); err != nil {
		s.failTo(w, r, p, err, "#backup-error")
		return
	}
	s.renderBackupList(w, r, p, id)
}

// handleBackupRestore loads a saved entry (form id) or an uploaded file.
func (s *Server) handleBackupRestore(w http.ResponseWriter, r *http.Request, p Page) {
	id, ok := s.botID(w, r, p)
	if !ok {
		return
	}
	var err error
	if entry := r.FormValue("id"); entry != "" {
		if !backupID.MatchString(entry) {
			err = &api.Error{Status: http.StatusNotFound, Key: "error.backup.unknown"}
		} else {
			err = s.api.RestoreBot(r.Context(), session(r), id, entry, nil, r.FormValue("name"))
		}
	} else {
		err = s.restoreUpload(r, id)
	}
	if err != nil {
		s.failTo(w, r, p, err, "#backup-error")
		return
	}
	w.Header().Set("HX-Trigger", "bothub:reset-forms")
	s.renderBackupList(w, r, p, id)
}

func (s *Server) restoreUpload(r *http.Request, botID int64) error {
	invalid := &api.Error{Status: http.StatusUnprocessableEntity, Key: "error.backup.format"}
	if err := r.ParseMultipartForm(maxBackupUpload); err != nil {
		return invalid
	}
	file, head, err := r.FormFile("file")
	if err != nil {
		return invalid
	}
	defer file.Close()
	raw, err := io.ReadAll(io.LimitReader(file, maxBackupUpload+1))
	if err != nil || len(raw) > maxBackupUpload || !json.Valid(raw) {
		return invalid
	}
	return s.api.RestoreBot(r.Context(), session(r), botID, "", raw, head.Filename)
}
