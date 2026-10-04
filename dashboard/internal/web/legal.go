package web

import (
	"net/http"
	"strconv"
	"strings"

	"github.com/Kljub/BothubV3/dashboard/internal/api"
)

// Public Terms of Service (/terms) and Privacy Policy (/privacy) of this
// BotHub instance. Public on purpose: the Discord Developer Portal needs both
// URLs (Developer Terms, section 5a), and members must reach them without an
// account. The operator details come from Admin → Server settings; the
// contact e-mail falls back to the admin's e-mail.

// legalVersion is the date of the current texts (shown as "last updated").
const legalVersion = "2026-10-04"

type legalView struct {
	Kind     string // "terms" or "privacy"
	Operator string
	Address  []string // lines
	Email    string
	Source   string // public source code (open source), optional
	Domain   string
	Updated  string
	// Other is the URL of the other page; Lang the language of the text.
	Other, Lang string
}

func (s *Server) legalPage(kind string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		p := s.pageFor(r, nil)
		if l := r.URL.Query().Get("lang"); l == "de" || l == "en" {
			p.Locale = l
		}
		lang := "en"
		if strings.HasPrefix(p.Locale, "de") {
			lang = "de"
		}
		v := legalView{Kind: kind, Lang: lang, Domain: r.Host}
		if info, err := s.api.Legal(r.Context()); err == nil {
			v.Operator, v.Email, v.Source = info.Operator, info.Email, info.SourceURL
			if v.Email == "" {
				v.Email = info.AdminEmail
			}
			for _, line := range strings.Split(info.Address, "\n") {
				if line = strings.TrimSpace(line); line != "" {
					v.Address = append(v.Address, line)
				}
			}
		}
		v.Updated = formatDateOnly(legalVersion, lang)
		if kind == "terms" {
			v.Other = "/privacy"
		} else {
			v.Other = "/terms"
		}
		w.Header().Set("Cache-Control", "no-cache")
		s.render(w, http.StatusOK, "legal", "legal_layout", withData(p, v))
	}
}

// formatDateOnly turns 2026-10-04 into "4. Oktober 2026" / "October 4, 2026".
func formatDateOnly(iso, lang string) string {
	parts := strings.Split(iso, "-")
	if len(parts) != 3 {
		return iso
	}
	de := []string{"Januar", "Februar", "März", "April", "Mai", "Juni", "Juli", "August", "September", "Oktober", "November", "Dezember"}
	en := []string{"January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"}
	m, err := strconv.Atoi(parts[1])
	if err != nil || m < 1 || m > 12 {
		return iso
	}
	day := strings.TrimLeft(parts[2], "0")
	if lang == "de" {
		return day + ". " + de[m-1] + " " + parts[0]
	}
	return en[m-1] + " " + day + ", " + parts[0]
}

// handleLegalSave stores the operator details (Admin → Server settings).
func (s *Server) handleLegalSave(w http.ResponseWriter, r *http.Request, p Page) {
	in := api.LegalInfo{
		Operator:  strings.TrimSpace(r.PostFormValue("operator")),
		Address:   strings.TrimSpace(r.PostFormValue("address")),
		Email:     strings.TrimSpace(r.PostFormValue("email")),
		SourceURL: strings.TrimSpace(r.PostFormValue("source_url")),
	}
	if _, err := s.api.SaveLegal(r.Context(), session(r), in); err != nil {
		s.failTo(w, r, p, err, "#legal-flash")
		return
	}
	s.flashTo(w, p, "legal_settings.saved", "#legal-flash")
}
