package web

import (
	"encoding/json"
	"html/template"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/Kljub/BothubV3/dashboard/internal/api"
)

// Message Builder module page: saved messages. Editing opens the message
// editor of the command builder (message-page.js); renaming, copying,
// deleting and sending are htmx forms here. Sending is a bot job.

const maxTemplates = 100

var jobID = regexp.MustCompile(`^[0-9a-f-]{36}$`)

type msgTemplateRow struct {
	ID        int64
	Name      string
	Summary   string
	V2        bool
	Embeds    int
	CreatedAt time.Time
}

// msgBuilderView is the data for the "message_builder" templates.
type msgBuilderView struct {
	BotID     int64
	BotName   string
	BotAvatar string
	Items     []msgTemplateRow
	Max       int
	Texts     template.JS
	Variables template.JS
}

type msgSendView struct {
	BotID    int64
	Template api.MessageTemplate
	Guilds   []api.Guild
}

type msgChannelsView struct {
	Channels []api.GuildChannel
}

type msgJobView struct {
	BotID int64
	Job   api.Job
	Done  bool
}

// templateSummary is the first line of text of a saved message.
func templateSummary(raw json.RawMessage) (summary string, v2 bool, embeds int) {
	var m struct {
		Mode       string `json:"mode"`
		Content    string `json:"content"`
		Embeds     []struct{ Title, Description string }
		Components []struct{ Type, Content string }
	}
	_ = json.Unmarshal(raw, &m)
	parts := []string{m.Content}
	if m.Mode == "v2" {
		parts = nil
		for _, c := range m.Components {
			if c.Type == "text" {
				parts = append(parts, c.Content)
			}
		}
	}
	for _, e := range m.Embeds {
		parts = append(parts, e.Title, e.Description)
	}
	for _, p := range parts {
		if p = strings.TrimSpace(p); p != "" {
			line, _, _ := strings.Cut(p, "\n")
			if r := []rune(line); len(r) > 90 {
				line = string(r[:90]) + "…"
			}
			return line, m.Mode == "v2", len(m.Embeds)
		}
	}
	return "", m.Mode == "v2", len(m.Embeds)
}

func (s *Server) msgBuilderView(r *http.Request, p Page, bot api.Bot) (msgBuilderView, error) {
	items, err := s.api.MessageTemplates(r.Context(), session(r), bot.ID)
	if err != nil {
		return msgBuilderView{}, err
	}
	v := msgBuilderView{BotID: bot.ID, BotName: bot.Name, Max: maxTemplates, Texts: jsonIsland(s.editorTexts(p.Locale)), Variables: jsonIsland(variableCatalog())}
	if bot.AvatarURL != nil {
		v.BotAvatar = *bot.AvatarURL
	}
	for _, t := range items {
		sum, v2, embeds := templateSummary(t.Message)
		v.Items = append(v.Items, msgTemplateRow{ID: t.ID, Name: t.Name, Summary: sum, V2: v2, Embeds: embeds, CreatedAt: t.CreatedAt})
	}
	return v, nil
}

func (s *Server) renderTemplateList(w http.ResponseWriter, r *http.Request, p Page, botID int64) {
	v, err := s.msgBuilderView(r, p, api.Bot{ID: botID})
	if err != nil {
		s.fail(w, r, p, err)
		return
	}
	s.render(w, http.StatusOK, "module_item", "message_builder_list_fragment", withData(p, v))
}

func templateID(r *http.Request) int64 {
	id, _ := strconv.ParseInt(r.PathValue("tid"), 10, 64)
	return id
}

func (s *Server) handleTemplateList(w http.ResponseWriter, r *http.Request, p Page) {
	id, ok := s.botID(w, r, p)
	if !ok {
		return
	}
	s.renderTemplateList(w, r, p, id)
}

// handleTemplateCreate saves a new message from the editor (name dialog).
func (s *Server) handleTemplateCreate(w http.ResponseWriter, r *http.Request, p Page) {
	id, ok := s.botID(w, r, p)
	if !ok {
		return
	}
	msg := json.RawMessage(r.PostFormValue("message"))
	if !json.Valid(msg) {
		s.failTo(w, r, p, &api.Error{Status: http.StatusUnprocessableEntity, Key: "error.template.invalid"}, "#msgb-name-error")
		return
	}
	if _, err := s.api.CreateMessageTemplate(r.Context(), session(r), id, strings.TrimSpace(r.PostFormValue("name")), msg); err != nil {
		s.failTo(w, r, p, err, "#msgb-name-error")
		return
	}
	w.Header().Set("HX-Trigger", "bothub:close-dialogs")
	s.renderTemplateList(w, r, p, id)
}

func (s *Server) handleTemplateRenameForm(w http.ResponseWriter, r *http.Request, p Page) {
	id, ok := s.botID(w, r, p)
	if !ok {
		return
	}
	t, err := s.api.MessageTemplate(r.Context(), session(r), id, templateID(r))
	if err != nil {
		s.failTo(w, r, p, err, "#msgb-error")
		return
	}
	s.render(w, http.StatusOK, "module_item", "message_builder_rename_fragment", withData(p, msgSendView{BotID: id, Template: t}))
}

func (s *Server) handleTemplateRename(w http.ResponseWriter, r *http.Request, p Page) {
	id, ok := s.botID(w, r, p)
	if !ok {
		return
	}
	if err := s.api.RenameMessageTemplate(r.Context(), session(r), id, templateID(r), strings.TrimSpace(r.PostFormValue("name"))); err != nil {
		s.failTo(w, r, p, err, "#msgb-dialog-error")
		return
	}
	w.Header().Set("HX-Trigger", "bothub:close-dialogs")
	s.renderTemplateList(w, r, p, id)
}

// handleTemplateCopy saves a copy named "<name> (copy)".
func (s *Server) handleTemplateCopy(w http.ResponseWriter, r *http.Request, p Page) {
	id, ok := s.botID(w, r, p)
	if !ok {
		return
	}
	t, err := s.api.MessageTemplate(r.Context(), session(r), id, templateID(r))
	if err == nil {
		name := s.i18n.T(p.Locale, "msgb.copy_name", "name", t.Name)
		if r := []rune(name); len(r) > 60 {
			name = string(r[:60])
		}
		_, err = s.api.CreateMessageTemplate(r.Context(), session(r), id, name, t.Message)
	}
	if err != nil {
		s.failTo(w, r, p, err, "#msgb-error")
		return
	}
	s.renderTemplateList(w, r, p, id)
}

func (s *Server) handleTemplateDelete(w http.ResponseWriter, r *http.Request, p Page) {
	id, ok := s.botID(w, r, p)
	if !ok {
		return
	}
	if err := s.api.DeleteMessageTemplate(r.Context(), session(r), id, templateID(r)); err != nil {
		s.failTo(w, r, p, err, "#msgb-error")
		return
	}
	s.renderTemplateList(w, r, p, id)
}

// handleTemplateSendForm renders the send dialog: server + channel, or a webhook.
func (s *Server) handleTemplateSendForm(w http.ResponseWriter, r *http.Request, p Page) {
	id, ok := s.botID(w, r, p)
	if !ok {
		return
	}
	t, err := s.api.MessageTemplate(r.Context(), session(r), id, templateID(r))
	if err != nil {
		s.failTo(w, r, p, err, "#msgb-error")
		return
	}
	guilds, err := s.api.ListGuilds(r.Context(), session(r), id)
	if err != nil {
		guilds = nil // the webhook target still works
	}
	s.render(w, http.StatusOK, "module_item", "message_builder_send_fragment", withData(p, msgSendView{BotID: id, Template: t, Guilds: guilds}))
}

// handleTemplateChannels lists the text channels of the chosen server.
func (s *Server) handleTemplateChannels(w http.ResponseWriter, r *http.Request, p Page) {
	id, ok := s.botID(w, r, p)
	if !ok {
		return
	}
	var out msgChannelsView
	if guild := r.URL.Query().Get("guild"); guild != "" {
		channels, err := s.api.GuildChannels(r.Context(), session(r), id, guild)
		if err != nil {
			s.failTo(w, r, p, err, "#msgb-dialog-error")
			return
		}
		for _, c := range channels {
			if c.Type == "text" || c.Type == "announcement" {
				out.Channels = append(out.Channels, c)
			}
		}
	}
	s.render(w, http.StatusOK, "module_item", "message_builder_channels_fragment", withData(p, out))
}

func (s *Server) handleTemplateSend(w http.ResponseWriter, r *http.Request, p Page) {
	id, ok := s.botID(w, r, p)
	if !ok {
		return
	}
	channel, webhook := strings.TrimSpace(r.PostFormValue("channel_id")), ""
	if r.PostFormValue("target") == "webhook" {
		channel, webhook = "", strings.TrimSpace(r.PostFormValue("webhook_url"))
	}
	job, err := s.api.SendMessageTemplate(r.Context(), session(r), id, templateID(r), channel, webhook)
	if err != nil {
		s.failTo(w, r, p, err, "#msgb-dialog-error")
		return
	}
	s.render(w, http.StatusOK, "module_item", "message_builder_job_fragment", withData(p, msgJobView{BotID: id, Job: api.Job{ID: job, Status: "queued"}}))
}

// handleTemplateJob polls the send job until it is done or failed.
func (s *Server) handleTemplateJob(w http.ResponseWriter, r *http.Request, p Page) {
	id, ok := s.botID(w, r, p)
	if !ok {
		return
	}
	jid := r.PathValue("jid")
	if !jobID.MatchString(jid) {
		s.failTo(w, r, p, &api.Error{Status: http.StatusNotFound, Key: "error.job.not_found"}, "#msgb-dialog-error")
		return
	}
	job, err := s.api.Job(r.Context(), session(r), jid)
	if err != nil {
		s.failTo(w, r, p, err, "#msgb-dialog-error")
		return
	}
	done := job.Status == "done" || job.Status == "failed"
	s.render(w, http.StatusOK, "module_item", "message_builder_job_fragment", withData(p, msgJobView{BotID: id, Job: job, Done: done}))
}
