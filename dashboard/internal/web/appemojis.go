package web

import (
	"io"
	"net/http"
	"path/filepath"
	"regexp"
	"strings"

	"github.com/Kljub/BothubV3/dashboard/internal/api"
)

// Emoji Manager (module "emoji-manager"): the bot's own emojis (Discord
// application emojis), usable on every server the bot is on. Upload several
// pictures at once (names from the file names), rename in place, copy the
// code, delete with a confirmation in place, search by name or ID.

const (
	appEmojiMaxBytes = 256 << 10 // per picture (Discord limit)
	appEmojiMaxFiles = 50        // per upload
)

type emojiView struct {
	BotID     int64
	Items     []api.AppEmoji
	Max       int
	PortalURL string // the emoji page of the application in the Discord Developer Portal
	LoadError string
	Notice    string   // i18n key
	Added     int      // pictures uploaded by the last upload
	Problems  []string // files the last upload skipped, with the reason
}

func (v emojiView) Count() int { return len(v.Items) }
func (v emojiView) Full() bool { return v.Max > 0 && len(v.Items) >= v.Max }

// portalEmojis: the emoji page of an application in the Discord Developer Portal.
func portalEmojis(appID string) string {
	if appID == "" {
		return ""
	}
	return "https://discord.com/developers/applications/" + appID + "/emojis"
}

func (s *Server) emojiData(r *http.Request, p Page, botID int64) emojiView {
	v := emojiView{BotID: botID, Max: 2000}
	// The portal link also when Discord cannot be asked (e.g. a bad token).
	if b, err := s.api.GetBot(r.Context(), session(r), botID); err == nil && b.ApplicationID != nil {
		v.PortalURL = portalEmojis(*b.ApplicationID)
	}
	list, err := s.api.AppEmojis(r.Context(), session(r), botID)
	if err != nil {
		v.LoadError = s.apiErrorText(p, err)
		return v
	}
	v.Items, v.Max = list.Items, list.Max
	if list.ApplicationID != "" {
		v.PortalURL = portalEmojis(list.ApplicationID)
	}
	return v
}

func (s *Server) renderEmojis(w http.ResponseWriter, r *http.Request, p Page, botID int64, change func(*emojiView)) {
	v := s.emojiData(r, p, botID)
	if change != nil {
		change(&v)
	}
	s.render(w, http.StatusOK, "module_item", "emoji_manager_fragment", withData(p, v))
}

var emojiNameJunk = regexp.MustCompile(`[^A-Za-z0-9_]+`)

// emojiName makes an emoji name (2-32 of A-Z, a-z, 0-9, _) from a file name.
func emojiName(file string) string {
	base := strings.TrimSuffix(filepath.Base(file), filepath.Ext(file))
	name := strings.Trim(emojiNameJunk.ReplaceAllString(base, "_"), "_")
	if len(name) > 32 {
		name = name[:32]
	}
	for len(name) < 2 {
		name += "_"
	}
	return name
}

func (s *Server) handleEmojiUpload(w http.ResponseWriter, r *http.Request, p Page) {
	id, ok := s.botID(w, r, p)
	if !ok {
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, appEmojiMaxFiles*(appEmojiMaxBytes+8<<10)+1<<20)
	if err := r.ParseMultipartForm(4 << 20); err != nil {
		s.failTo(w, r, p, &api.Error{Status: http.StatusUnprocessableEntity, Key: "error.emoji.upload_too_big"}, "#emoji-error")
		return
	}
	files := r.MultipartForm.File["files"]
	if len(files) == 0 {
		s.failTo(w, r, p, &api.Error{Status: http.StatusUnprocessableEntity, Key: "error.emoji.no_files"}, "#emoji-error")
		return
	}
	added, problems := 0, []string{}
	for i, fh := range files {
		label := filepath.Base(fh.Filename)
		if i >= appEmojiMaxFiles {
			problems = append(problems, label+": "+s.i18n.T(p.Locale, "error.emoji.too_many_files"))
			continue
		}
		if fh.Size > appEmojiMaxBytes {
			problems = append(problems, label+": "+s.i18n.T(p.Locale, "error.emoji.too_big"))
			continue
		}
		f, err := fh.Open()
		if err != nil {
			problems = append(problems, label+": "+s.i18n.T(p.Locale, "error.emoji.bad_image"))
			continue
		}
		data, err := io.ReadAll(io.LimitReader(f, appEmojiMaxBytes+1))
		f.Close()
		if err != nil {
			problems = append(problems, label+": "+s.i18n.T(p.Locale, "error.emoji.bad_image"))
			continue
		}
		if _, err := s.api.CreateAppEmoji(r.Context(), session(r), id, emojiName(fh.Filename), data); err != nil {
			problems = append(problems, label+": "+s.apiErrorText(p, err))
			continue
		}
		added++
	}
	s.renderEmojis(w, r, p, id, func(v *emojiView) {
		v.Added, v.Problems = added, problems
		if added > 0 {
			v.Notice = "emoji.uploaded"
		}
	})
}

func (s *Server) handleEmojiRename(w http.ResponseWriter, r *http.Request, p Page) {
	id, ok := s.botID(w, r, p)
	if !ok {
		return
	}
	name := strings.TrimSpace(r.PostFormValue("name"))
	if err := s.api.RenameAppEmoji(r.Context(), session(r), id, r.PathValue("emojiId"), name); err != nil {
		s.failTo(w, r, p, err, "#emoji-error")
		return
	}
	s.renderEmojis(w, r, p, id, func(v *emojiView) { v.Notice = "emoji.renamed" })
}

func (s *Server) handleEmojiDelete(w http.ResponseWriter, r *http.Request, p Page) {
	id, ok := s.botID(w, r, p)
	if !ok {
		return
	}
	if err := s.api.DeleteAppEmoji(r.Context(), session(r), id, r.PathValue("emojiId")); err != nil {
		s.failTo(w, r, p, err, "#emoji-error")
		return
	}
	s.renderEmojis(w, r, p, id, func(v *emojiView) { v.Notice = "emoji.deleted" })
}
