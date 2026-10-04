package web

import (
	"net/http"
	"slices"
	"strings"

	"github.com/Kljub/BothubV3/dashboard/internal/api"
)

// SDK policies (admin > SDK Policies): one switch per SDK permission, global
// for every bot and plugin. A plugin may use a permission only when it is on.
// The permissions are shown in their main groups (members, messages, …),
// sorted by the group's name; a group opens to its permissions. Inside
// "Modules" the permissions come per BotHub module (modules.<module>.*).
// A search filters by name, key, description and function names.

type sdkPoliciesView struct {
	Query  string
	Groups []sdkPolicyGroup
	Hits   int // permissions matching the search
}

type sdkPolicyGroup struct {
	Key, Label string
	Items      []sdkPolicyRow
	On         int  // permissions that apply now
	Open       bool // the group of the last change, or a group with search hits
}

// sdkPolicyRow is one permission with its texts; ModuleLabel is set on the
// first row of each module inside the Modules group (sub-heading).
type sdkPolicyRow struct {
	api.SdkPolicy
	Label, Hint, ModuleLabel string
}

// sdkTexts gives label and hint of a permission; modules.<key>.read share
// one text with the module's name.
func (s *Server) sdkTexts(p api.SdkPolicy, locale string) (label, hint, module string) {
	if p.Module != "" {
		module = s.i18n.T(locale, "sdk.module.all")
		if p.Module != "all" {
			module = s.i18n.T(locale, "module."+p.Module+".name")
		}
	}
	label, hint = s.i18n.T(locale, "sdk.perm."+p.Permission), s.i18n.T(locale, "sdk.perm."+p.Permission+"_hint")
	if label == "sdk.perm."+p.Permission && p.Module != "" && p.Module != "all" {
		label = s.i18n.T(locale, "sdk.perm.module_read", "module", module)
		hint = s.i18n.T(locale, "sdk.perm.module_read_hint", "module", module)
	}
	return label, hint, module
}

// sdkGroups sorts groups by their translated name and the permissions
// inside by theirs (in Modules: by module first, "all modules" on top);
// open names the group to keep open; q filters (case-insensitive).
func (s *Server) sdkGroups(items []api.SdkPolicy, locale, open, q string) ([]sdkPolicyGroup, int) {
	q = strings.ToLower(strings.TrimSpace(q))
	byKey := map[string]*sdkPolicyGroup{}
	var groups []*sdkPolicyGroup
	hits := 0
	for _, it := range items {
		label, hint, module := s.sdkTexts(it, locale)
		if q != "" && !strings.Contains(strings.ToLower(label+" "+hint+" "+it.Permission+" "+module+" "+strings.Join(it.Calls, " ")), q) {
			continue
		}
		hits++
		key := it.Group
		if key == "" {
			key = "other"
		}
		g, ok := byKey[key]
		if !ok {
			g = &sdkPolicyGroup{Key: key, Label: s.i18n.T(locale, "sdk.group."+key), Open: key == open || q != ""}
			byKey[key] = g
			groups = append(groups, g)
		}
		g.Items = append(g.Items, sdkPolicyRow{SdkPolicy: it, Label: label, Hint: hint, ModuleLabel: module})
		if it.Enabled {
			g.On++
		}
	}
	moduleOrder := func(r sdkPolicyRow) string {
		switch r.Module {
		case "":
			return ""
		case "all":
			return "\x00"
		}
		return "\x01" + strings.ToLower(r.ModuleLabel)
	}
	out := make([]sdkPolicyGroup, 0, len(groups))
	for _, g := range groups {
		slices.SortFunc(g.Items, func(a, b sdkPolicyRow) int {
			if c := strings.Compare(moduleOrder(a), moduleOrder(b)); c != 0 {
				return c
			}
			return strings.Compare(strings.ToLower(a.Label), strings.ToLower(b.Label))
		})
		// Sub-heading only on the first row of each module.
		last := "\xff"
		for i := range g.Items {
			if g.Items[i].ModuleLabel == last {
				g.Items[i].ModuleLabel = ""
			} else {
				last = g.Items[i].ModuleLabel
			}
		}
		out = append(out, *g)
	}
	slices.SortFunc(out, func(a, b sdkPolicyGroup) int {
		return strings.Compare(strings.ToLower(a.Label), strings.ToLower(b.Label))
	})
	return out, hits
}

func (s *Server) sdkView(items []api.SdkPolicy, locale, open, q string) sdkPoliciesView {
	groups, hits := s.sdkGroups(items, locale, open, q)
	return sdkPoliciesView{Query: strings.TrimSpace(q), Groups: groups, Hits: hits}
}

func (s *Server) sdkPolicies(r *http.Request, locale string) (sdkPoliciesView, error) {
	items, err := s.api.SdkPolicies(r.Context(), session(r))
	return s.sdkView(items, locale, "", r.URL.Query().Get("q")), err
}

// handleSdkPolicySearch answers the list for the search field.
func (s *Server) handleSdkPolicySearch(w http.ResponseWriter, r *http.Request, p Page) {
	v, err := s.sdkPolicies(r, p.Locale)
	if err != nil {
		s.failTo(w, r, p, err, "#sdk-policies-error")
		return
	}
	s.render(w, http.StatusOK, "admin", "sdk_policies_fragment", withData(p, v))
}

var sdkModes = []string{"allow", "default", "deny"}

// handleSdkPolicy sets one permission to allow, default or deny and answers
// the list; the group of the switch stays open, the search stays applied.
func (s *Server) handleSdkPolicy(w http.ResponseWriter, r *http.Request, p Page) {
	mode := r.PostFormValue("mode")
	if !slices.Contains(sdkModes, mode) {
		s.failTo(w, r, p, &api.Error{Status: http.StatusUnprocessableEntity, Key: "error.validation.failed"}, "#sdk-policies-error")
		return
	}
	items, err := s.api.SetSdkPolicy(r.Context(), session(r), r.PathValue("perm"), mode)
	if err != nil {
		s.failTo(w, r, p, err, "#sdk-policies-error")
		return
	}
	s.render(w, http.StatusOK, "admin", "sdk_policies_fragment", withData(p, s.sdkView(items, p.Locale, r.PostFormValue("group"), r.PostFormValue("q"))))
}
