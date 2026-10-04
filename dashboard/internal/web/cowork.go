package web

import (
	"fmt"
	"net/http"
	"slices"
	"strconv"
	"strings"

	"github.com/Kljub/BothubV3/dashboard/internal/api"
)

// Co-Work page of a bot (sidebar "Co-Work"): who works on it and with which
// role, invites by link or to a user, saved roles and the activity. The
// gateway decides who may change what; the page only hides what the user
// may not do.

// coworkRoles are the fixed roles in the order of the select.
var coworkRoles = []string{"viewer", "operator", "builder", "admin"}

// coworkExpiry and coworkUses are the choices of an invite link.
var coworkExpiry = []int{0, 1800, 3600, 21600, 43200, 86400, 604800}
var coworkUses = []int{0, 1, 5, 10, 25, 50, 100}

type coworkView struct {
	BotID      int64
	Page       api.CoworkPage
	CanManage  bool
	IsOwner    bool
	Roles      []string
	Expiry     []int
	Uses       []int
	NewLink    string // the link just created (shown once)
	MyName     string
	Activities []coworkActivityView
}

type coworkActivityView struct {
	When, Who, Text string
}

func (s *Server) coworkView(r *http.Request, p Page, botID int64, newLink string) (coworkView, error) {
	page, err := s.api.Cowork(r.Context(), session(r), botID)
	if err != nil {
		return coworkView{}, err
	}
	v := coworkView{BotID: botID, Page: page, CanManage: slices.Contains(page.MyPermissions, "members.manage"), IsOwner: page.MyRole == "owner",
		Roles: coworkRoles, Expiry: coworkExpiry, Uses: coworkUses, NewLink: newLink, MyName: p.Me.Username}
	for _, a := range page.Activity {
		who := "—"
		if a.User != nil {
			who = *a.User
		}
		var args []any
		for k, val := range a.Params {
			text := fmt.Sprint(val)
			if k == "area" {
				text = s.i18n.T(p.Locale, "cowork.area."+text)
			}
			if k == "role" {
				text = s.i18n.T(p.Locale, "cowork.role."+text)
			}
			args = append(args, k, text)
		}
		v.Activities = append(v.Activities, coworkActivityView{When: formatDocDate(a.Time, p.Locale) + " " + clockOf(a.Time), Who: who, Text: s.i18n.T(p.Locale, a.Key, args...)})
	}
	return v, nil
}

// clockOf: "14:05" of an ISO time.
func clockOf(iso string) string {
	if len(iso) < 16 {
		return ""
	}
	return iso[11:16]
}

// coworkRender answers the whole Co-Work section (htmx) after a change.
func (s *Server) coworkRender(w http.ResponseWriter, r *http.Request, p Page, botID int64, newLink string) {
	v, err := s.coworkView(r, p, botID, newLink)
	if err != nil {
		s.failTo(w, r, p, err, "#cowork-error")
		return
	}
	s.render(w, http.StatusOK, "bot", "bot_cowork_fragment", withData(p, v))
}

// roleFromForm: a fixed role, a saved role ("saved:<id>") or custom with checkboxes.
func roleFromForm(r *http.Request, page api.CoworkPage) (role string, perms []string, name string) {
	v := r.PostFormValue("role")
	if strings.HasPrefix(v, "saved:") {
		id, _ := strconv.ParseInt(strings.TrimPrefix(v, "saved:"), 10, 64)
		for _, sr := range page.Roles {
			if sr.ID == id {
				return "custom", sr.Permissions, sr.Name
			}
		}
	}
	if v == "custom" {
		_ = r.ParseForm()
		return "custom", r.PostForm["perm"], ""
	}
	return v, nil, ""
}

func (s *Server) handleCoworkMember(w http.ResponseWriter, r *http.Request, p Page) {
	id, ok := s.botID(w, r, p)
	if !ok {
		return
	}
	page, err := s.api.Cowork(r.Context(), session(r), id)
	if err != nil {
		s.failTo(w, r, p, err, "#cowork-error")
		return
	}
	role, perms, _ := roleFromForm(r, page)
	if err := s.api.SetBotMember(r.Context(), session(r), id, r.PathValue("user"), role, perms); err != nil {
		s.failTo(w, r, p, err, "#cowork-error")
		return
	}
	s.coworkRender(w, r, p, id, "")
}

func (s *Server) handleCoworkRemove(w http.ResponseWriter, r *http.Request, p Page) {
	id, ok := s.botID(w, r, p)
	if !ok {
		return
	}
	uid, _ := strconv.ParseInt(r.PathValue("user"), 10, 64)
	if err := s.api.RemoveBotMember(r.Context(), session(r), id, uid); err != nil {
		s.failTo(w, r, p, err, "#cowork-error")
		return
	}
	s.coworkRender(w, r, p, id, "")
}

func (s *Server) handleCoworkInvite(w http.ResponseWriter, r *http.Request, p Page) {
	id, ok := s.botID(w, r, p)
	if !ok {
		return
	}
	page, err := s.api.Cowork(r.Context(), session(r), id)
	if err != nil {
		s.failTo(w, r, p, err, "#cowork-error")
		return
	}
	role, perms, name := roleFromForm(r, page)
	expires, _ := strconv.Atoi(r.PostFormValue("expires"))
	uses, _ := strconv.Atoi(r.PostFormValue("uses"))
	kind := r.PostFormValue("kind")
	in := map[string]any{"kind": kind, "username": strings.TrimSpace(r.PostFormValue("username")), "role": role, "permissions": perms, "roleName": name, "expiresIn": expires, "maxUses": uses}
	inv, err := s.api.CreateInvite(r.Context(), session(r), id, in)
	if err != nil {
		s.failTo(w, r, p, err, "#cowork-error")
		return
	}
	link := ""
	if inv.Token != "" {
		scheme := "http"
		if r.TLS != nil || r.Header.Get("X-Forwarded-Proto") == "https" {
			scheme = "https"
		}
		link = scheme + "://" + r.Host + "/cowork/join/" + inv.Token
	}
	s.coworkRender(w, r, p, id, link)
}

func (s *Server) handleCoworkRevoke(w http.ResponseWriter, r *http.Request, p Page) {
	id, ok := s.botID(w, r, p)
	if !ok {
		return
	}
	n, _ := strconv.ParseInt(r.PathValue("n"), 10, 64)
	if err := s.api.RevokeInvite(r.Context(), session(r), id, n); err != nil {
		s.failTo(w, r, p, err, "#cowork-error")
		return
	}
	s.coworkRender(w, r, p, id, "")
}

func (s *Server) handleCoworkRoleSave(w http.ResponseWriter, r *http.Request, p Page) {
	id, ok := s.botID(w, r, p)
	if !ok {
		return
	}
	_ = r.ParseForm()
	if err := s.api.SaveCoworkRole(r.Context(), session(r), id, strings.TrimSpace(r.PostFormValue("name")), r.PostForm["perm"]); err != nil {
		s.failTo(w, r, p, err, "#cowork-error")
		return
	}
	s.coworkRender(w, r, p, id, "")
}

func (s *Server) handleCoworkRoleDelete(w http.ResponseWriter, r *http.Request, p Page) {
	id, ok := s.botID(w, r, p)
	if !ok {
		return
	}
	n, _ := strconv.ParseInt(r.PathValue("n"), 10, 64)
	if err := s.api.DeleteCoworkRole(r.Context(), session(r), id, n); err != nil {
		s.failTo(w, r, p, err, "#cowork-error")
		return
	}
	s.coworkRender(w, r, p, id, "")
}

// --- joining ---

// handleCoworkJoinPage: the invite link asks before joining.
func (s *Server) handleCoworkJoinPage(w http.ResponseWriter, r *http.Request, p Page) {
	s.render(w, http.StatusOK, "bot", "layout", withData(p, map[string]any{"Section": "cowork_join", "Token": r.PathValue("token")}))
}

func (s *Server) handleCoworkJoin(w http.ResponseWriter, r *http.Request, p Page) {
	botID, err := s.api.AcceptInvite(r.Context(), session(r), r.PathValue("token"), 0)
	if err != nil {
		s.fail(w, r, p, err)
		return
	}
	redirect(w, r, fmt.Sprintf("/select-bot/%d", botID))
}

// handleInviteAnswer: accept or decline an invite to the user (overview page).
func (s *Server) handleInviteAnswer(w http.ResponseWriter, r *http.Request, p Page) {
	n, _ := strconv.ParseInt(r.PathValue("n"), 10, 64)
	if r.PathValue("answer") == "accept" {
		botID, err := s.api.AcceptInvite(r.Context(), session(r), "", n)
		if err != nil {
			s.fail(w, r, p, err)
			return
		}
		redirect(w, r, fmt.Sprintf("/select-bot/%d", botID))
		return
	}
	if err := s.api.DeclineInvite(r.Context(), session(r), n); err != nil {
		s.fail(w, r, p, err)
		return
	}
	redirect(w, r, "/")
}
