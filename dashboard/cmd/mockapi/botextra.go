package main

import (
	"context"
	"encoding/base64"
	"io"
	"log"
	"net/http"
	"time"
)

// Profile, presence, restart and per-bot stats of the mock API.

const (
	profileWindow = 5 * time.Minute
	// profileLoadTimeout bounds the first Discord read of avatar and banner.
	profileLoadTimeout = 4 * time.Second
	profileLimit       = 2
)

type rateWindow struct {
	used    int
	resetAt time.Time
}

func (w *rateWindow) state(now time.Time) map[string]any {
	if !w.resetAt.IsZero() && now.After(w.resetAt) {
		*w = rateWindow{}
	}
	out := map[string]any{"remaining": profileLimit - w.used, "limit": profileLimit, "resetAt": nil}
	if !w.resetAt.IsZero() {
		out["resetAt"] = w.resetAt
	}
	return out
}

func (w *rateWindow) take(now time.Time) bool {
	w.state(now)
	if w.used >= profileLimit {
		return false
	}
	if w.used == 0 {
		w.resetAt = now.Add(profileWindow)
	}
	w.used++
	return true
}

type profileData struct {
	avatar, banner  *string
	pronouns, bio   string
	avatarRL, banRL rateWindow
	synced          bool      // avatar, banner and bio were read from Discord
	syncTried       time.Time // last automatic attempt (retried after a minute)
}

type activity struct {
	Type string `json:"type"`
	Name string `json:"name"`
	URL  string `json:"url,omitempty"`
}

type presenceData struct {
	Status       string   `json:"status"`
	Activity     activity `json:"activity"`
	CustomStatus string   `json:"customStatus"`
	Show         string   `json:"show"`
	Rotation     struct {
		Enabled         bool       `json:"enabled"`
		IntervalSeconds int        `json:"intervalSeconds"`
		Entries         []activity `json:"entries"`
	} `json:"rotation"`
}

func (s *store) profileOf(id int64) *profileData {
	if s.profiles == nil {
		s.profiles = map[int64]*profileData{}
	}
	p, ok := s.profiles[id]
	if !ok {
		p = &profileData{}
		s.profiles[id] = p
	}
	return p
}

func (s *store) presenceOf(id int64) *presenceData {
	if s.presences == nil {
		s.presences = map[int64]*presenceData{}
	}
	p, ok := s.presences[id]
	if !ok {
		p = &presenceData{Status: "online", Activity: activity{Type: "none"}}
		p.Rotation.IntervalSeconds = 300
		p.Rotation.Entries = []activity{}
		s.presences[id] = p
	}
	return p
}

func (s *store) profileJSON(id int64) map[string]any {
	p := s.profileOf(id)
	now := time.Now()
	return map[string]any{
		"avatarUrl": p.avatar, "bannerUrl": p.banner,
		"pronouns": p.pronouns, "bio": p.bio,
		"windowSeconds": int(profileWindow.Seconds()),
		"limits":        map[string]any{"avatar": p.avatarRL.state(now), "banner": p.banRL.state(now)},
	}
}

// getProfile reads the profile once from Discord on first use: the mock
// keeps it in memory only, so after a restart avatar and banner would stay
// empty until the user clicks "from Discord".
func (s *store) getProfile(w http.ResponseWriter, r *http.Request, b *bot) {
	s.mu.Lock()
	p := s.profileOf(b.ID)
	load := !p.synced && time.Since(p.syncTried) > time.Minute
	if load {
		p.syncTried = time.Now()
	}
	s.mu.Unlock()
	if load {
		// Short: the page waits for this answer, and a slow Discord must not
		// make the dashboard give up ("API not reachable"). Tried again after a minute.
		ctx, cancel := context.WithTimeout(r.Context(), profileLoadTimeout)
		if err := s.loadProfile(ctx, b); err != nil {
			log.Printf("profile of bot %d: %v", b.ID, err)
		}
		cancel()
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	writeJSON(w, 200, s.profileJSON(b.ID))
}

// loadProfile reads avatar, banner and "About me" from Discord.
func (s *store) loadProfile(ctx context.Context, b *bot) error {
	token := s.botToken(b)
	user, err := s.discord.me(ctx, token)
	if err != nil {
		return err
	}
	app, err := s.discord.application(ctx, token)
	if err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	p := s.profileOf(b.ID)
	avatar := avatarURL(user)
	p.avatar, p.banner, p.bio, b.AvatarURL, p.synced = &avatar, bannerURL(user), app.Description, &avatar, true
	return nil
}

func (s *store) patchProfile(w http.ResponseWriter, r *http.Request, b *bot) {
	var in struct {
		Pronouns *string `json:"pronouns"`
		Bio      *string `json:"bio"`
	}
	if !readJSON(w, r, &in) {
		return
	}
	if (in.Pronouns != nil && len([]rune(*in.Pronouns)) > 40) || (in.Bio != nil && len([]rune(*in.Bio)) > 190) {
		apiError(w, 422, "error.field.too_long")
		return
	}
	// "About me" of a bot is its application description. Discord has no
	// API for bot pronouns, so they stay in BotHub only.
	if in.Bio != nil {
		if err := s.discord.updateDescription(r.Context(), s.botToken(b), *in.Bio); err != nil {
			de := asDiscordError(err)
			apiError(w, de.Status, de.Key)
			return
		}
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	p := s.profileOf(b.ID)
	if in.Pronouns != nil {
		p.pronouns = *in.Pronouns
	}
	if in.Bio != nil {
		p.bio = *in.Bio
	}
	writeJSON(w, 200, s.profileJSON(b.ID))
}

// uploadProfile sends a new avatar or banner to Discord (PATCH /users/@me).
func (s *store) uploadProfile(w http.ResponseWriter, r *http.Request, b *bot) {
	kind := r.PathValue("kind")
	if kind != "avatar" && kind != "banner" {
		apiError(w, 404, "error.not_found")
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, 11<<20)
	file, _, err := r.FormFile("file")
	if err != nil {
		apiError(w, 422, "error.upload.invalid")
		return
	}
	defer file.Close()
	data, err := io.ReadAll(file)
	if err != nil || len(data) == 0 {
		apiError(w, 422, "error.upload.invalid")
		return
	}
	mime := http.DetectContentType(data)
	if mime != "image/png" && mime != "image/jpeg" && mime != "image/gif" && mime != "image/webp" {
		apiError(w, 422, "error.upload.invalid")
		return
	}
	s.mu.Lock()
	p := s.profileOf(b.ID)
	rl := &p.avatarRL
	if kind == "banner" {
		rl = &p.banRL
	}
	allowed := rl.take(time.Now())
	s.mu.Unlock()
	if !allowed {
		apiError(w, 429, "error.profile.rate_limited")
		return
	}
	user, err := s.discord.updateUser(r.Context(), s.botToken(b), map[string]any{kind: "data:" + mime + ";base64," + base64.StdEncoding.EncodeToString(data)})
	if err != nil {
		de := asDiscordError(err)
		if de.Status == 429 {
			de.Key = "error.profile.rate_limited"
		}
		apiError(w, de.Status, de.Key)
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	avatar := avatarURL(user)
	p.avatar, p.banner, b.AvatarURL, p.synced = &avatar, bannerURL(user), &avatar, true
	writeJSON(w, 200, s.profileJSON(b.ID))
}

// syncProfile reads avatar, banner and "About me" from Discord.
func (s *store) syncProfile(w http.ResponseWriter, r *http.Request, b *bot) {
	if err := s.loadProfile(r.Context(), b); err != nil {
		de := asDiscordError(err)
		apiError(w, de.Status, de.Key)
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	writeJSON(w, 200, s.profileJSON(b.ID))
}

func (s *store) getPresence(w http.ResponseWriter, r *http.Request, b *bot) {
	s.mu.Lock()
	defer s.mu.Unlock()
	writeJSON(w, 200, s.presenceOf(b.ID))
}

func (s *store) patchPresence(w http.ResponseWriter, r *http.Request, b *bot) {
	var in struct {
		Status       *string   `json:"status"`
		Activity     *activity `json:"activity"`
		CustomStatus *string   `json:"customStatus"`
		Show         *string   `json:"show"`
		Rotation     *struct {
			Enabled         bool       `json:"enabled"`
			IntervalSeconds int        `json:"intervalSeconds"`
			Entries         []activity `json:"entries"`
		} `json:"rotation"`
	}
	if !readJSON(w, r, &in) {
		return
	}
	if in.Status != nil && !oneOf(*in.Status, "online", "idle", "dnd", "invisible") {
		apiError(w, 422, "error.validation.failed")
		return
	}
	if in.Show != nil && !oneOf(*in.Show, "activity", "custom") {
		apiError(w, 422, "error.validation.failed")
		return
	}
	if in.Rotation != nil && (in.Rotation.IntervalSeconds < 30 || in.Rotation.IntervalSeconds > 3600) {
		apiError(w, 422, "error.validation.failed")
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	p := s.presenceOf(b.ID)
	if in.Status != nil {
		p.Status = *in.Status
	}
	if in.Activity != nil {
		p.Activity = *in.Activity
	}
	if in.CustomStatus != nil {
		p.CustomStatus = *in.CustomStatus
	}
	if in.Show != nil {
		p.Show = *in.Show
	}
	if in.Rotation != nil {
		p.Rotation.Enabled, p.Rotation.IntervalSeconds, p.Rotation.Entries = in.Rotation.Enabled, in.Rotation.IntervalSeconds, in.Rotation.Entries
	}
	writeJSON(w, 200, p)
}

func (s *store) restartBot(w http.ResponseWriter, r *http.Request, b *bot) {
	s.mu.Lock()
	allowed := s.canRunBot(w, b)
	s.mu.Unlock()
	if !allowed {
		return
	}
	if s.storedJob(w, r, b, "restart") {
		return
	}
	s.transition(w, b, "bot.restart", "starting", "running")
}

// --- per-bot stats ---

var botMetrics = []string{"newMembers", "activeUsers", "messages", "voiceMinutes", "moderation", "commands", "pluginUsages"}

// botStats fakes hourly activity with a daily rhythm; stable per bot and hour.
func (s *store) botStats(w http.ResponseWriter, r *http.Request, b *bot) {
	q := r.URL.Query()
	rng := q.Get("range")
	window := map[string]time.Duration{"24h": 24 * time.Hour, "7d": 7 * 24 * time.Hour, "30d": 30 * 24 * time.Hour}[rng]
	step := map[string]time.Duration{"24h": time.Hour, "7d": 2 * time.Hour, "30d": 6 * time.Hour}[rng]
	end := time.Now().UTC()
	if rng == "custom" {
		from, err1 := time.Parse(time.RFC3339, q.Get("from"))
		to, err2 := time.Parse(time.RFC3339, q.Get("to"))
		switch {
		case err1 != nil || err2 != nil || !from.Before(to):
			apiError(w, 422, "error.range.invalid")
			return
		case to.Sub(from) < 5*time.Minute:
			apiError(w, 422, "error.range.too_short_stats")
			return
		}
		window, end = to.Sub(from), to.UTC()
		// Hourly buckets, at most about 120 points.
		step = max(time.Hour, (window / 120).Truncate(time.Hour))
	}
	if window == 0 {
		rng, window, step = "7d", 7*24*time.Hour, 2*time.Hour
	}

	// No usage numbers yet: the bot does not report them. Every point is 0.
	value := func(string, time.Time) int64 { return 0 }

	now := end.Truncate(step)
	totals, previous := map[string]int64{}, map[string]int64{}
	series := map[string][]map[string]any{}
	for _, m := range botMetrics {
		pts := []map[string]any{}
		for t := now.Add(-window + step); !t.After(now); t = t.Add(step) {
			v := value(m, t)
			totals[m] += v
			previous[m] += value(m, t.Add(-window)) * 9 / 10
			pts = append(pts, map[string]any{"t": t, "v": v})
		}
		series[m] = pts
	}
	writeJSON(w, 200, map[string]any{
		"range": rng, "totals": totals, "previous": previous, "series": series,
		"top": map[string]any{"commands": []any{}, "plugins": []any{}, "modActions": []any{}},
	})
}

func oneOf(v string, allowed ...string) bool {
	for _, a := range allowed {
		if v == a {
			return true
		}
	}
	return false
}
