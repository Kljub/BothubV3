package web

import (
	"context"
	"net/http"
	"slices"
	"strconv"
	"strings"

	"github.com/Kljub/BothubV3/dashboard/internal/api"
)

// Handlers for the bot's Settings and Status tabs. Every change swaps only
// the affected card or shows a flash message; the page never reloads.

const maxUploadBytes = 10 << 20 // Discord accepts up to 10 MB for avatars and banners

// --- settings: header card ---

func (s *Server) handleBotHeader(w http.ResponseWriter, r *http.Request, p Page) {
	id, ok := s.botID(w, r, p)
	if !ok {
		return
	}
	s.renderBotHeader(w, r, p, id)
}

func (s *Server) renderBotHeader(w http.ResponseWriter, r *http.Request, p Page, id int64) {
	bot, err := s.api.GetBot(r.Context(), session(r), id)
	if err != nil {
		s.fail(w, r, p, err)
		return
	}
	s.render(w, http.StatusOK, "bot", "bot_header_fragment", withData(p, bot))
}

// handleBotPower starts, stops or restarts the bot and re-renders the header card.
func (s *Server) handleBotPower(w http.ResponseWriter, r *http.Request, p Page) {
	id, ok := s.botID(w, r, p)
	if !ok {
		return
	}
	actions := map[string]func(context.Context, api.Session, int64) (api.Job, error){
		"start": s.api.StartBot, "stop": s.api.StopBot, "restart": s.api.RestartBot,
	}
	action, ok := actions[r.PathValue("action")]
	if !ok {
		s.fail(w, r, p, &api.Error{Status: http.StatusNotFound, Key: "error.not_found"})
		return
	}
	if _, err := action(r.Context(), session(r), id); err != nil {
		s.fail(w, r, p, err)
		return
	}
	s.renderBotHeader(w, r, p, id)
}

func (s *Server) handleBotName(w http.ResponseWriter, r *http.Request, p Page) {
	id, ok := s.botID(w, r, p)
	if !ok {
		return
	}
	name := strings.TrimSpace(r.PostFormValue("name"))
	if _, err := s.api.UpdateBot(r.Context(), session(r), id, api.BotUpdate{Name: &name}); err != nil {
		s.fail(w, r, p, err)
		return
	}
	s.flash(w, p, "bot.settings.saved")
}

func (s *Server) handleBotToken(w http.ResponseWriter, r *http.Request, p Page) {
	id, ok := s.botID(w, r, p)
	if !ok {
		return
	}
	token := strings.TrimSpace(r.PostFormValue("token"))
	if token == "" {
		s.flash(w, p, "settings.token.unchanged")
		return
	}
	if _, err := s.api.UpdateBot(r.Context(), session(r), id, api.BotUpdate{Token: &token}); err != nil {
		s.fail(w, r, p, err)
		return
	}
	w.Header().Set("HX-Trigger", "bothub:reset-forms")
	s.flash(w, p, "settings.token.saved")
}

// --- settings: avatar and banner ---

type mediaView struct {
	Bot     api.Bot
	Profile api.BotProfile
}

func (s *Server) handleProfileUpload(w http.ResponseWriter, r *http.Request, p Page) {
	id, ok := s.botID(w, r, p)
	if !ok {
		return
	}
	kind := r.PathValue("kind")
	if kind != "avatar" && kind != "banner" {
		s.fail(w, r, p, &api.Error{Status: http.StatusNotFound, Key: "error.not_found"})
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, maxUploadBytes+1<<20)
	file, header, err := r.FormFile("file")
	if err != nil || header.Size > maxUploadBytes {
		s.failTo(w, r, p, &api.Error{Status: http.StatusUnprocessableEntity, Key: "error.upload.invalid"}, "#media-error")
		return
	}
	defer file.Close()

	if _, err := s.api.UploadProfileImage(r.Context(), session(r), id, kind, header.Filename, file); err != nil {
		s.failTo(w, r, p, err, "#media-error")
		return
	}
	s.renderMedia(w, r, p, id)
}

func (s *Server) handleProfileSync(w http.ResponseWriter, r *http.Request, p Page) {
	id, ok := s.botID(w, r, p)
	if !ok {
		return
	}
	if _, err := s.api.SyncProfile(r.Context(), session(r), id); err != nil {
		s.failTo(w, r, p, err, "#media-error")
		return
	}
	s.renderMedia(w, r, p, id)
}

func (s *Server) handleBotMedia(w http.ResponseWriter, r *http.Request, p Page) {
	id, ok := s.botID(w, r, p)
	if !ok {
		return
	}
	s.renderMedia(w, r, p, id)
}

func (s *Server) renderMedia(w http.ResponseWriter, r *http.Request, p Page, id int64) {
	sess := session(r)
	bot, err := s.api.GetBot(r.Context(), sess, id)
	if err != nil {
		s.fail(w, r, p, err)
		return
	}
	profile, err := s.api.Profile(r.Context(), sess, id)
	if err != nil {
		s.fail(w, r, p, err)
		return
	}
	s.render(w, http.StatusOK, "bot", "bot_media_fragment", withData(p, mediaView{Bot: bot, Profile: profile}))
}

// --- status tab ---

func (s *Server) handlePresenceStatus(w http.ResponseWriter, r *http.Request, p Page) {
	id, ok := s.botID(w, r, p)
	if !ok {
		return
	}
	status := r.PostFormValue("status")
	presence, err := s.api.UpdatePresence(r.Context(), session(r), id, api.PresenceUpdate{Status: &status})
	if err != nil {
		s.fail(w, r, p, err)
		return
	}
	s.render(w, http.StatusOK, "bot", "presence_status_fragment", withData(p, presenceView{BotID: id, Presence: presence}))
}

func (s *Server) handlePresenceActivity(w http.ResponseWriter, r *http.Request, p Page) {
	id, ok := s.botID(w, r, p)
	if !ok {
		return
	}
	act := activityFrom(r.PostFormValue("type"), r.PostFormValue("name"), r.PostFormValue("url"))
	if _, err := s.api.UpdatePresence(r.Context(), session(r), id, api.PresenceUpdate{Activity: &act}); err != nil {
		s.fail(w, r, p, err)
		return
	}
	s.flash(w, p, "status.saved")
}

// handleCustomStatus saves the custom status; DELETE removes it.
func (s *Server) handleCustomStatus(w http.ResponseWriter, r *http.Request, p Page) {
	id, ok := s.botID(w, r, p)
	if !ok {
		return
	}
	text := ""
	if r.Method == http.MethodPost {
		text = strings.TrimSpace(r.PostFormValue("text"))
	}
	presence, err := s.api.UpdatePresence(r.Context(), session(r), id, api.PresenceUpdate{CustomStatus: &text})
	if err != nil {
		s.fail(w, r, p, err)
		return
	}
	if r.Method == http.MethodDelete {
		s.render(w, http.StatusOK, "bot", "custom_status_fragment", withData(p, presenceView{BotID: id, Presence: presence}))
		return
	}
	s.flash(w, p, "status.saved")
}

func (s *Server) handleRotation(w http.ResponseWriter, r *http.Request, p Page) {
	id, ok := s.botID(w, r, p)
	if !ok {
		return
	}
	if err := r.ParseForm(); err != nil {
		s.fail(w, r, p, &api.Error{Status: http.StatusUnprocessableEntity, Key: "error.validation.failed"})
		return
	}
	interval, _ := strconv.Atoi(r.PostFormValue("interval"))
	rot := api.Rotation{Enabled: r.PostFormValue("enabled") == "true", IntervalSeconds: interval, Entries: []api.Activity{}}
	types, names := r.PostForm["entry_type"], r.PostForm["entry_name"]
	for i := range min(len(types), len(names)) {
		if strings.TrimSpace(names[i]) == "" {
			continue
		}
		rot.Entries = append(rot.Entries, activityFrom(types[i], names[i], ""))
	}
	if _, err := s.api.UpdatePresence(r.Context(), session(r), id, api.PresenceUpdate{Rotation: &rot}); err != nil {
		s.fail(w, r, p, err)
		return
	}
	s.flash(w, p, "status.saved")
}

func (s *Server) handleBotProfile(w http.ResponseWriter, r *http.Request, p Page) {
	id, ok := s.botID(w, r, p)
	if !ok {
		return
	}
	pronouns := strings.TrimSpace(r.PostFormValue("pronouns"))
	bio := strings.TrimSpace(r.PostFormValue("bio"))
	if _, err := s.api.UpdateProfile(r.Context(), session(r), id, api.ProfileUpdate{Pronouns: &pronouns, Bio: &bio}); err != nil {
		s.fail(w, r, p, err)
		return
	}
	s.flash(w, p, "status.saved")
}

type presenceView struct {
	BotID    int64
	Presence api.Presence
	Profile  api.BotProfile
}

// PresenceStatuses and ActivityTypes give the templates the option lists.
func (presenceView) PresenceStatuses() []string { return api.PresenceStatuses }
func (presenceView) ActivityTypes() []string    { return api.ActivityTypes }

func activityFrom(typ, name, link string) api.Activity {
	if !slices.Contains(api.ActivityTypes, typ) || typ == "none" {
		return api.Activity{Type: "none"}
	}
	a := api.Activity{Type: typ, Name: strings.TrimSpace(name)}
	if typ == "streaming" {
		a.URL = strings.TrimSpace(link)
	}
	return a
}

// handlePresenceShow picks what Discord shows: the activity (or rotation)
// or the custom status. Discord shows only one activity of a bot.
func (s *Server) handlePresenceShow(w http.ResponseWriter, r *http.Request, p Page) {
	id, ok := s.botID(w, r, p)
	if !ok {
		return
	}
	show := r.PostFormValue("show")
	if show != "custom" {
		show = "activity"
	}
	if _, err := s.api.UpdatePresence(r.Context(), session(r), id, api.PresenceUpdate{Show: &show}); err != nil {
		s.fail(w, r, p, err)
		return
	}
	s.flash(w, p, "status.saved")
}
