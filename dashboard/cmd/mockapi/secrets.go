package main

import (
	"net/http"
	"regexp"
	"sort"
	"strings"
	"time"
)

// Global secrets (admin settings, "API / Secrets": name, value, description).
// They apply to every bot: builder blocks, modules and plugins pick a secret
// by name (an address is a secret too). Secret values are write-only:
// no answer ever contains them, not even partly. (In-memory stand-in for the
// PHP API, same contract; the API stores values encrypted.)

type globalSecret struct {
	Key         string    `json:"key"`
	Description string    `json:"description"`
	CreatedAt   time.Time `json:"createdAt"`
	UpdatedAt   time.Time `json:"updatedAt"`
	value       string
}

var (
	globalKeyPattern  = regexp.MustCompile(`^[A-Z][A-Z0-9_]{1,39}$`)
	authHeaderPattern = regexp.MustCompile(`^[A-Za-z0-9-]{1,64}$`)
)

const (
	maxGlobalSecrets = 100
)

func (s *store) listSecrets(w http.ResponseWriter, r *http.Request, _ string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	items := make([]globalSecret, 0, len(s.secrets))
	for _, x := range s.secrets {
		items = append(items, *x)
	}
	sort.Slice(items, func(i, j int) bool { return items[i].Key < items[j].Key })
	writeJSON(w, 200, map[string]any{"items": items})
}

// putSecret creates or updates a secret. A new secret needs a value; an
// empty value on update keeps the stored one.
func (s *store) putSecret(w http.ResponseWriter, r *http.Request, _ string) {
	key := r.PathValue("key")
	var in struct {
		Value       *string `json:"value"`
		Description string  `json:"description"`
	}
	if !readJSON(w, r, &in) {
		return
	}
	if !globalKeyPattern.MatchString(key) {
		apiError(w, 422, "error.secret.key")
		return
	}
	in.Description = strings.TrimSpace(in.Description)
	if len([]rune(in.Description)) > 200 {
		apiError(w, 422, "error.field.too_long")
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.secrets == nil {
		s.secrets = map[string]*globalSecret{}
	}
	now := time.Now().UTC()
	x, exists := s.secrets[key]
	hasValue := in.Value != nil && *in.Value != ""
	if !exists {
		if !hasValue {
			apiError(w, 422, "error.secret.value_required")
			return
		}
		if len(s.secrets) >= maxGlobalSecrets {
			apiErrorParams(w, 422, "error.secret.limit", map[string]any{"max": maxGlobalSecrets})
			return
		}
		x = &globalSecret{Key: key, CreatedAt: now}
		s.secrets[key] = x
	}
	if hasValue {
		if len(*in.Value) > 4096 {
			apiError(w, 422, "error.field.too_long")
			return
		}
		x.value = *in.Value
	}
	x.Description, x.UpdatedAt = in.Description, now
	s.addServerLog(time.Now(), "change", "", "log.server.secret_saved", "api", s.user, map[string]any{"key": key}, nil)
	writeJSON(w, 200, x)
}

func (s *store) deleteSecret(w http.ResponseWriter, r *http.Request, _ string) {
	key := r.PathValue("key")
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, ok := s.secrets[key]; !ok {
		apiError(w, 404, "error.secret.unknown")
		return
	}
	delete(s.secrets, key)
	s.addServerLog(time.Now(), "change", "", "log.server.secret_deleted", "api", s.user, map[string]any{"key": key}, nil)
	w.WriteHeader(204)
}
