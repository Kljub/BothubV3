package main

import (
	"encoding/json"
	"net/http"
	"net/mail"
	"strings"
)

// Operator details of the public Terms of Service and Privacy Policy pages.
// Stored by the PHP API (settings key "legal"); without it they stay in
// memory. GET /api/v1/legal is public (the pages need it without a login)
// and falls back to the first admin's e-mail when no contact e-mail is set.

type legalInfo struct {
	Operator  string  `json:"operator"`
	Address   string  `json:"address"`
	Email     string  `json:"email"`
	SourceURL string  `json:"sourceUrl"`
	UpdatedAt *string `json:"updatedAt"`
	// AdminEmail: the admin account's e-mail (fallback contact).
	AdminEmail string `json:"adminEmail,omitempty"`
}

func (s *store) readLegal(r *http.Request) (legalInfo, bool) {
	if s.php == nil {
		s.mu.Lock()
		defer s.mu.Unlock()
		return s.legal, true
	}
	req, err := http.NewRequestWithContext(r.Context(), http.MethodGet, s.php.base+"/internal/legal", nil)
	if err != nil {
		return legalInfo{}, false
	}
	req.Header.Set("X-BotHub-Internal", s.php.key)
	resp, err := s.php.http.Do(req)
	if err != nil {
		return legalInfo{}, false
	}
	defer resp.Body.Close()
	var out legalInfo
	if resp.StatusCode != http.StatusOK || json.NewDecoder(resp.Body).Decode(&out) != nil {
		return legalInfo{}, false
	}
	return out, true
}

func (s *store) adminEmail() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.account.email == nil {
		return ""
	}
	return *s.account.email
}

// getLegal is public: operator details plus the admin's e-mail as fallback.
func (s *store) getLegal(w http.ResponseWriter, r *http.Request) {
	info, ok := s.readLegal(r)
	if !ok {
		apiError(w, 502, "error.api.unreachable")
		return
	}
	info.AdminEmail = s.adminEmail()
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, 200, info)
}

func (s *store) getAdminLegal(w http.ResponseWriter, r *http.Request, _ string) {
	s.getLegal(w, r)
}

// putAdminLegal saves the operator details (PHP API, or in memory without it).
func (s *store) putAdminLegal(w http.ResponseWriter, r *http.Request, sid string) {
	if s.php != nil {
		s.adminViaPHP(adminPHPRequired)(w, r, sid)
		return
	}
	var in legalInfo
	if !readJSON(w, r, &in) {
		return
	}
	in.Operator, in.Address, in.Email, in.SourceURL = strings.TrimSpace(in.Operator), strings.TrimSpace(in.Address), strings.TrimSpace(in.Email), strings.TrimSpace(in.SourceURL)
	if in.SourceURL != "" && (len(in.SourceURL) > 300 || !strings.HasPrefix(in.SourceURL, "https://")) {
		apiError(w, 422, "error.validation.failed")
		return
	}
	if len([]rune(in.Operator)) > 120 || len([]rune(in.Address)) > 300 {
		apiError(w, 422, "error.validation.failed")
		return
	}
	if in.Email != "" {
		if _, err := mail.ParseAddress(in.Email); err != nil {
			apiError(w, 422, "error.validation.failed")
			return
		}
	}
	in.AdminEmail = ""
	s.mu.Lock()
	s.legal = in
	s.mu.Unlock()
	writeJSON(w, 200, in)
}
