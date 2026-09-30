package main

import (
	"bytes"
	"io"
	"net/http"
	"strings"
)

// Commands, custom events, groups, versions and module switches live in the
// PHP API (internal endpoints under /internal/bots/{id}/…, same paths and
// JSON as /api/v1/bots/{id}/…). With BOTHUB_INTERNAL_KEY set the mock
// forwards those requests 1:1, so graphs are stored in SQLite and reach the
// NodeCore. Checks the API does not have yet (built-in command names) run
// here first. Without the key the in-memory handlers answer as before.

// viaPHP forwards the request when the API stores bots, else runs local.
func (s *store) viaPHP(local botHandler) botHandler {
	return func(w http.ResponseWriter, r *http.Request, b *bot) {
		if s.php == nil {
			local(w, r, b)
			return
		}
		body, err := io.ReadAll(io.LimitReader(r.Body, 4<<20))
		if err != nil {
			apiError(w, 400, "error.request.invalid")
			return
		}
		// No built-in-name check here: module commands exist only as their
		// copies in the database (the presets), so nothing can clash.
		s.forward(w, r, body)
	}
}

// internalPath maps /api/v1/bots/… to /internal/bots/… (query kept).
func internalPath(r *http.Request) string {
	p := "/internal" + strings.TrimPrefix(r.URL.Path, "/api/v1")
	if r.URL.RawQuery != "" {
		p += "?" + r.URL.RawQuery
	}
	return p
}

// forward sends the request to the API and copies status and JSON back.
func (s *store) forward(w http.ResponseWriter, r *http.Request, body []byte) {
	req, err := http.NewRequestWithContext(r.Context(), r.Method, s.php.base+internalPath(r), bytes.NewReader(body))
	if err != nil {
		apiError(w, 500, "error.internal")
		return
	}
	req.Header.Set("X-BotHub-Internal", s.php.key)
	if ct := r.Header.Get("Content-Type"); ct != "" {
		req.Header.Set("Content-Type", ct)
	}
	resp, err := s.php.http.Do(req)
	if err != nil {
		apiError(w, 502, "error.api.unreachable")
		return
	}
	defer resp.Body.Close()
	if ct := resp.Header.Get("Content-Type"); ct != "" {
		w.Header().Set("Content-Type", ct)
	}
	w.WriteHeader(resp.StatusCode)
	_, _ = io.Copy(w, resp.Body)
}

// hookToPHP passes a public webhook call unchanged to the PHP API: same
// path, body, Content-Type and Authorization, and its status back. There is
// no session here; the API checks the webhook's key itself. Without the PHP
// API the in-memory receiver answers.
func (s *store) hookToPHP(w http.ResponseWriter, r *http.Request) {
	if s.php == nil {
		s.receiveWebhook(w, r)
		return
	}
	body, err := io.ReadAll(io.LimitReader(r.Body, webhookBodyLimit+1))
	if err != nil {
		apiError(w, 400, "error.request.invalid")
		return
	}
	req, err := http.NewRequestWithContext(r.Context(), http.MethodPost, s.php.base+r.URL.Path, bytes.NewReader(body))
	if err != nil {
		apiError(w, 500, "error.internal")
		return
	}
	for _, h := range []string{"Content-Type", "Authorization"} {
		if v := r.Header.Get(h); v != "" {
			req.Header.Set(h, v)
		}
	}
	resp, err := s.php.http.Do(req)
	if err != nil {
		apiError(w, 502, "error.api.unreachable")
		return
	}
	defer resp.Body.Close()
	if ct := resp.Header.Get("Content-Type"); ct != "" {
		w.Header().Set("Content-Type", ct)
	}
	w.WriteHeader(resp.StatusCode)
	_, _ = io.Copy(w, resp.Body)
}

// phpRequired answers routes that exist only in the PHP API when it is off.
func phpRequired(w http.ResponseWriter, _ *http.Request, _ *bot) {
	apiError(w, 503, "error.api.unreachable")
}

// modulesFromPHP lists every module: stored switches from the API, missing
// ones are on (that is how the NodeCore reads them too).
func (s *store) modulesFromPHP(local botHandler) botHandler {
	return func(w http.ResponseWriter, r *http.Request, b *bot) {
		if s.php == nil {
			local(w, r, b)
			return
		}
		var stored struct {
			Items []struct {
				Key     string `json:"key"`
				Enabled bool   `json:"enabled"`
			} `json:"items"`
		}
		if err := s.php.do(r.Context(), http.MethodGet, internalPath(r), nil, &stored); err != nil {
			pe := asPHPError(err)
			apiError(w, pe.Status, pe.Key)
			return
		}
		on := map[string]bool{}
		for _, m := range stored.Items {
			on[m.Key] = m.Enabled
		}
		s.mu.Lock()
		items := []map[string]any{}
		for key := range s.known {
			enabled, ok := on[key]
			items = append(items, map[string]any{"key": key, "enabled": !ok || enabled})
		}
		s.mu.Unlock()
		writeJSON(w, 200, map[string]any{"items": items})
	}
}

// jobStatus asks the PHP API for a queued job (e.g. message.send).
func (s *store) jobStatus(w http.ResponseWriter, r *http.Request, _ string) {
	if s.php == nil {
		apiError(w, 404, "error.job.not_found")
		return
	}
	s.forward(w, r, nil)
}
