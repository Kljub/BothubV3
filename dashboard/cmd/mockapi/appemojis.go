package main

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"regexp"
	"strings"
)

// Bot emojis (module "Emoji Manager"): emojis of the application itself, not
// of a server, so the bot can use them on every server. Discord REST:
// /applications/{application}/emojis (list, create, rename, delete).

const (
	appEmojiMax      = 2000      // per application (Discord limit)
	appEmojiMaxBytes = 256 << 10 // per picture (Discord limit)
)

var appEmojiName = regexp.MustCompile(`^[A-Za-z0-9_]{2,32}$`)

type appEmoji struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	Animated bool   `json:"animated"`
}

func (c *discordClient) appEmojis(ctx context.Context, token, app string) ([]appEmoji, error) {
	var out struct {
		Items []appEmoji `json:"items"`
	}
	err := c.do(ctx, token, http.MethodGet, "/applications/"+app+"/emojis", nil, &out)
	return out.Items, err
}

func (c *discordClient) createAppEmoji(ctx context.Context, token, app, name, image string) (appEmoji, error) {
	var out appEmoji
	err := c.do(ctx, token, http.MethodPost, "/applications/"+app+"/emojis", map[string]string{"name": name, "image": image}, &out)
	return out, err
}

func (c *discordClient) renameAppEmoji(ctx context.Context, token, app, id, name string) (appEmoji, error) {
	var out appEmoji
	err := c.do(ctx, token, http.MethodPatch, "/applications/"+app+"/emojis/"+id, map[string]string{"name": name}, &out)
	return out, err
}

func (c *discordClient) deleteAppEmoji(ctx context.Context, token, app, id string) error {
	return c.do(ctx, token, http.MethodDelete, "/applications/"+app+"/emojis/"+id, nil, nil)
}

// appEmojiJSON: what the dashboard shows and copies.
func appEmojiJSON(e appEmoji) map[string]any {
	prefix, ext := "", "png"
	if e.Animated {
		prefix, ext = "a", "gif"
	}
	return map[string]any{
		"id": e.ID, "name": e.Name, "animated": e.Animated,
		"code": "<" + prefix + ":" + e.Name + ":" + e.ID + ">",
		"url":  discordCDN + "/emojis/" + e.ID + "." + ext + "?size=96",
	}
}

// appOf: the application of the bot (its ID is the bot's user ID).
func (s *store) appOf(w http.ResponseWriter, b *bot) (string, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if b.ApplicationID == nil || *b.ApplicationID == "" || b.token == "" {
		apiError(w, 409, "error.emoji.no_application")
		return "", false
	}
	return *b.ApplicationID, true
}

func (s *store) emojiError(w http.ResponseWriter, err error) {
	de := asDiscordError(err)
	if de.Key == "error.discord.invalid_form" {
		de.Key = "error.emoji.refused"
	}
	apiError(w, de.Status, de.Key)
}

func (s *store) listAppEmojis(w http.ResponseWriter, r *http.Request, b *bot) {
	app, ok := s.appOf(w, b)
	if !ok {
		return
	}
	list, err := s.discord.appEmojis(r.Context(), s.botToken(b), app)
	if err != nil {
		s.emojiError(w, err)
		return
	}
	items := make([]map[string]any, 0, len(list))
	for _, e := range list {
		items = append(items, appEmojiJSON(e))
	}
	writeJSON(w, 200, map[string]any{"items": items, "max": appEmojiMax, "applicationId": app})
}

// imageMime: the picture types Discord takes for emojis (AVIF by its "ftyp" box).
func imageMime(data []byte) string {
	if len(data) > 12 && bytes.Equal(data[4:8], []byte("ftyp")) && (bytes.Equal(data[8:12], []byte("avif")) || bytes.Equal(data[8:12], []byte("avis"))) {
		return "image/avif"
	}
	switch m := http.DetectContentType(data); m {
	case "image/png", "image/jpeg", "image/gif", "image/webp":
		return m
	}
	return ""
}

// createAppEmoji: one picture, JSON {name, data (base64)}.
func (s *store) createAppEmoji(w http.ResponseWriter, r *http.Request, b *bot) {
	app, ok := s.appOf(w, b)
	if !ok {
		return
	}
	var in struct {
		Name string `json:"name"`
		Data string `json:"data"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, appEmojiMaxBytes*2)).Decode(&in); err != nil {
		apiError(w, 422, "error.emoji.too_big")
		return
	}
	name := strings.TrimSpace(in.Name)
	if !appEmojiName.MatchString(name) {
		apiError(w, 422, "error.emoji.bad_name")
		return
	}
	data, err := base64.StdEncoding.DecodeString(in.Data)
	if err != nil || len(data) == 0 {
		apiError(w, 422, "error.emoji.bad_image")
		return
	}
	if len(data) > appEmojiMaxBytes {
		apiError(w, 422, "error.emoji.too_big")
		return
	}
	mime := imageMime(data)
	if mime == "" {
		apiError(w, 422, "error.emoji.bad_image")
		return
	}
	e, err := s.discord.createAppEmoji(r.Context(), s.botToken(b), app, name, "data:"+mime+";base64,"+in.Data)
	if err != nil {
		s.emojiError(w, err)
		return
	}
	writeJSON(w, 201, appEmojiJSON(e))
}

func (s *store) renameAppEmoji(w http.ResponseWriter, r *http.Request, b *bot) {
	app, ok := s.appOf(w, b)
	if !ok {
		return
	}
	var in struct {
		Name string `json:"name"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4<<10)).Decode(&in); err != nil || !appEmojiName.MatchString(strings.TrimSpace(in.Name)) {
		apiError(w, 422, "error.emoji.bad_name")
		return
	}
	e, err := s.discord.renameAppEmoji(r.Context(), s.botToken(b), app, r.PathValue("emojiId"), strings.TrimSpace(in.Name))
	if err != nil {
		s.emojiError(w, err)
		return
	}
	writeJSON(w, 200, appEmojiJSON(e))
}

func (s *store) deleteAppEmoji(w http.ResponseWriter, r *http.Request, b *bot) {
	app, ok := s.appOf(w, b)
	if !ok {
		return
	}
	if err := s.discord.deleteAppEmoji(r.Context(), s.botToken(b), app, r.PathValue("emojiId")); err != nil {
		s.emojiError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
