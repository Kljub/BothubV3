package web

import (
	"crypto/rand"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"

	"github.com/Kljub/BothubV3/dashboard/internal/api"
)

// Webhooks module page: the bot's API key, a form for new webhooks with a
// live example request, and the list of webhooks. A webhook call starts the
// custom events of type "webhook" that picked it in the builder.

type webhooksView struct {
	BotID      int64
	BaseURL    string // scheme://host the dashboard is reached at
	Key        keyView
	Items      []webhookRow
	NewEventID string // proposal for the "new webhook" form
	NewKey     string // shown once, right after the key was created
	Notice     string // i18n key of a short success note
}

type keyView struct {
	Set     bool
	Hint    string
	Created string
}

type webhookRow struct {
	api.Webhook
	FullURL    string
	LastCalled string
}

const eventIDChars = "abcdefghijklmnopqrstuvwxyz0123456789"

// newEventID returns 24 random characters for a webhook URL.
func newEventID() string {
	b := make([]byte, 24)
	_, _ = rand.Read(b)
	for i := range b {
		b[i] = eventIDChars[int(b[i])%len(eventIDChars)]
	}
	return string(b)
}

// baseURL is the origin the browser uses, so the shown URLs work as they are
// (webhook URLs, sign-in redirects, the mobile app's QR code).
// BOTHUB_PUBLIC_URL (e.g. https://bothub.example) wins. Else the scheme comes
// from TLS or what a reverse proxy tells (X-Forwarded-Proto, Forwarded,
// X-Forwarded-Ssl, Front-End-Https); the browser's own Origin / Referer of
// the same host wins over them: a proxy that ends TLS without telling (or
// says http) would otherwise turn https into http.
func baseURL(r *http.Request) string {
	if pub := strings.TrimRight(strings.TrimSpace(os.Getenv("BOTHUB_PUBLIC_URL")), "/"); strings.HasPrefix(pub, "https://") || strings.HasPrefix(pub, "http://") {
		return pub
	}
	host := r.Host
	if fh := strings.TrimSpace(strings.Split(r.Header.Get("X-Forwarded-Host"), ",")[0]); fh != "" {
		host = fh
	}
	return requestScheme(r, host) + "://" + host
}

func requestScheme(r *http.Request, host string) string {
	// The browser knows best: its own page of this host is https.
	for _, h := range []string{r.Header.Get("Origin"), r.Header.Get("Referer")} {
		if u, err := url.Parse(h); err == nil && u.Scheme == "https" && strings.EqualFold(u.Host, host) {
			return "https"
		}
	}
	first := func(v string) string { return strings.ToLower(strings.TrimSpace(strings.Split(v, ",")[0])) }
	if r.TLS != nil || first(r.Header.Get("X-Forwarded-Proto")) == "https" || first(r.Header.Get("X-Forwarded-Scheme")) == "https" ||
		strings.EqualFold(r.Header.Get("X-Forwarded-Ssl"), "on") || strings.EqualFold(r.Header.Get("Front-End-Https"), "on") ||
		strings.Contains(strings.ToLower(r.Header.Get("Forwarded")), "proto=https") {
		return "https"
	}
	return "http"
}

func (s *Server) webhooksData(r *http.Request, p Page, botID int64) (webhooksView, error) {
	list, err := s.api.Webhooks(r.Context(), session(r), botID)
	if err != nil {
		return webhooksView{}, err
	}
	v := webhooksView{BotID: botID, BaseURL: baseURL(r), NewEventID: newEventID()}
	v.Key.Set = list.APIKey.Set
	if list.APIKey.Hint != nil {
		v.Key.Hint = *list.APIKey.Hint
	}
	if list.APIKey.CreatedAt != nil {
		v.Key.Created = formatDateTime(*list.APIKey.CreatedAt, p.Locale)
	}
	for _, h := range list.Items {
		row := webhookRow{Webhook: h, FullURL: v.BaseURL + h.URL}
		if h.LastCalledAt != nil {
			row.LastCalled = formatDateTime(*h.LastCalledAt, p.Locale)
		}
		v.Items = append(v.Items, row)
	}
	return v, nil
}

func (s *Server) renderWebhooks(w http.ResponseWriter, r *http.Request, p Page, botID int64, change func(*webhooksView)) {
	v, err := s.webhooksData(r, p, botID)
	if err != nil {
		s.failTo(w, r, p, err, "#webhooks-error")
		return
	}
	if change != nil {
		change(&v)
	}
	s.render(w, http.StatusOK, "module_item", "webhooks_fragment", withData(p, v))
}

func webhookID(r *http.Request) int64 {
	id, _ := strconv.ParseInt(r.PathValue("wid"), 10, 64)
	return id
}

func (s *Server) handleWebhookCreate(w http.ResponseWriter, r *http.Request, p Page) {
	id, ok := s.botID(w, r, p)
	if !ok {
		return
	}
	in := api.WebhookCreate{
		EventID:    strings.ToLower(strings.TrimSpace(r.PostFormValue("event_id"))),
		Name:       strings.TrimSpace(r.PostFormValue("name")),
		RequireKey: r.PostFormValue("require_key") == "true",
	}
	if err := s.api.CreateWebhook(r.Context(), session(r), id, in); err != nil {
		s.failTo(w, r, p, err, "#webhooks-error")
		return
	}
	s.renderWebhooks(w, r, p, id, func(v *webhooksView) { v.Notice = "module_page.webhooks.created" })
}

func (s *Server) handleWebhookUpdate(w http.ResponseWriter, r *http.Request, p Page) {
	id, ok := s.botID(w, r, p)
	if !ok {
		return
	}
	name := strings.TrimSpace(r.PostFormValue("name"))
	require := r.PostFormValue("require_key") == "true"
	enabled := r.PostFormValue("enabled") == "true"
	if err := s.api.UpdateWebhook(r.Context(), session(r), id, webhookID(r), api.WebhookUpdate{Name: &name, RequireKey: &require, Enabled: &enabled}); err != nil {
		s.failTo(w, r, p, err, "#webhooks-error")
		return
	}
	s.renderWebhooks(w, r, p, id, func(v *webhooksView) { v.Notice = "module_page.webhooks.saved" })
}

func (s *Server) handleWebhookDelete(w http.ResponseWriter, r *http.Request, p Page) {
	id, ok := s.botID(w, r, p)
	if !ok {
		return
	}
	if err := s.api.DeleteWebhook(r.Context(), session(r), id, webhookID(r)); err != nil {
		s.failTo(w, r, p, err, "#webhooks-error")
		return
	}
	s.renderWebhooks(w, r, p, id, nil)
}

// handleWebhookTest sends one test call with the variable from the form.
func (s *Server) handleWebhookTest(w http.ResponseWriter, r *http.Request, p Page) {
	id, ok := s.botID(w, r, p)
	if !ok {
		return
	}
	vars := map[string]string{}
	if msg := strings.TrimSpace(r.PostFormValue("message")); msg != "" {
		vars["message"] = msg
	}
	if err := s.api.TestWebhook(r.Context(), session(r), id, webhookID(r), vars); err != nil {
		s.failTo(w, r, p, err, "#webhooks-error")
		return
	}
	s.renderWebhooks(w, r, p, id, func(v *webhooksView) { v.Notice = "module_page.webhooks.test_sent" })
}

// handleWebhookKey creates a new API key and shows it once.
func (s *Server) handleWebhookKey(w http.ResponseWriter, r *http.Request, p Page) {
	id, ok := s.botID(w, r, p)
	if !ok {
		return
	}
	key, err := s.api.CreateWebhookKey(r.Context(), session(r), id)
	if err != nil {
		s.failTo(w, r, p, err, "#webhooks-error")
		return
	}
	// The key must not be cached anywhere on its way to the browser.
	w.Header().Set("Cache-Control", "no-store")
	s.renderWebhooks(w, r, p, id, func(v *webhooksView) { v.NewKey = key })
}
