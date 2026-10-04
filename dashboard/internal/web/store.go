package web

import (
	"log/slog"
	"net/http"
	"net/url"
	"slices"
	"strings"

	"github.com/Kljub/BothubV3/dashboard/internal/api"
)

// App Store: the one place to manage plugins. /store lists the market
// plugins plus installed ones that are not in the market (uploads), with
// search, category and state filters and a zip upload; /store/{plugin}
// shows contents and permissions and installs, updates, shares endpoints
// and uninstalls. Only an admin manages plugins; the API refuses everyone
// else. Bot owners switch installed plugins on per bot under Bot → Plugins.

var storeCategories = []string{"utility", "security", "messages", "fun", "ticket", "social"}

var storeFilters = []string{"all", "installed", "updates"}

type storeView struct {
	Query, Category, Filter string
	Categories, Filters     []string
	Items                   []storeItem
	Total                   int // market size before filtering
	MarketError             bool
	Notice                  string // translated
	// Live: the list came from the API's cache and is old (or missing); the
	// grid loads the current one at once (LiveURL, htmx "load") and swaps itself.
	Live    bool
	LiveURL string
}

type storeItem struct {
	ID, Name, Description, Developer, Version string
	Icon, Category, License                   string
	Published, Installed                      string
	Update                                    bool
	Size                                      int64
	Layers                                    *api.MarketLayers
	// Permissions: what the plugin needs now (the installed version when
	// installed, else the published one); MarketPermissions: what the
	// published version needs (install / update dialog).
	Permissions, MarketPermissions []storePermission
	Secrets                        []string
	// Uploaded: installed but not in the market (zip upload).
	Uploaded bool
	// Info is set for installed plugins.
	Info *installedInfo
}

// storePermission is one SDK permission the plugin asks for, with its risk,
// its SDK policy mode (allow, default, deny) and whether it is on right now
// (unknown = not in the catalog).
type storePermission struct {
	Key, Risk, Mode  string
	Enabled, Unknown bool
}

// storePage is the full page: either the list or one plugin.
type storePage struct {
	List   *storeView
	Detail *storeDetail
}

type storeDetail struct {
	Item   storeItem
	Notice string // translated
	// Blocked counts permissions the SDK policies switch off (the plugin does
	// not run while one is off); Grant counts the ones the install sets to
	// "allow" (every needed permission not set to allow yet).
	Blocked, Grant int
	ConnectError   string // translated, after a failed sign-in
	// Connect: sign-in helpers grouped by provider (installed plugins only).
	Connect []connectGroup
}

// Market list sources of storeItems.
const (
	marketCached  = iota // the API's last list, any age, never a download
	marketCurrent        // the API's 5-minute cache, downloads when older
	marketRefresh        // download now
)

// storeItems merges the market with the installed plugins. The installed
// list is required; the market is optional (marketErr reports it failed,
// the installed plugins still show). fresh: the market list is current
// (always true unless mode is marketCached).
func (s *Server) storeItems(r *http.Request, p Page, mode int) (items []storeItem, marketErr, fresh bool, err error) {
	installed, manifests, err := s.installedPlugins(r, p)
	if err != nil {
		return nil, false, false, err
	}
	var market []api.MarketPlugin
	var merr error
	fresh = true
	if mode == marketCached {
		market, fresh, merr = s.api.MarketPluginsCached(r.Context(), session(r))
	} else {
		market, merr = s.api.MarketPlugins(r.Context(), session(r), mode == marketRefresh)
	}
	if merr != nil {
		if st := api.AsError(merr).Status; st == http.StatusForbidden || st == http.StatusUnauthorized {
			return nil, false, false, merr
		}
		slog.Warn("market list failed", "err", merr)
		marketErr = true
	}
	policies, _ := s.api.SdkPolicies(r.Context(), session(r)) // optional: risk badges only
	byKey := make(map[string]api.SdkPolicy, len(policies))
	for _, pol := range policies {
		byKey[pol.Permission] = pol
	}
	perms := func(keys []string) []storePermission {
		var out []storePermission
		for _, key := range keys {
			pol, ok := byKey[key]
			out = append(out, storePermission{Key: key, Risk: pol.Risk, Mode: pol.Mode, Enabled: pol.Enabled, Unknown: !ok})
		}
		return out
	}
	seen := map[string]bool{}
	for _, m := range market {
		it := storeItem{
			ID: m.ID, Name: m.Name, Description: m.Description, Developer: m.Developer, Version: m.Version,
			Icon: m.Icon, Category: m.Category, License: m.License, Size: m.Size, Layers: m.Layers, Secrets: m.Secrets,
			Permissions: perms(m.Permissions), MarketPermissions: perms(m.Permissions),
		}
		if m.Published != nil {
			it.Published = *m.Published
		}
		if pl, ok := installed[m.ID]; ok {
			it.Installed = pl.Version
			info := installedDetails(pl, manifests[m.ID], p.Locale)
			it.Info = &info
			// The installed version decides what runs (it may differ from the market, e.g. an upload).
			it.Permissions = perms(manifests[m.ID].Permissions)
		}
		it.Update = it.Installed != "" && it.Published != "" && newerVersion(it.Published, it.Installed)
		seen[m.ID] = true
		items = append(items, it)
	}
	// Installed plugins outside the market: everything comes from the manifest.
	for id, pl := range installed {
		if seen[id] {
			continue
		}
		m := manifests[id]
		info := installedDetails(pl, m, p.Locale)
		layers := &api.MarketLayers{Commands: len(m.Commands), Nodes: len(m.Blocks), Events: len(m.Events), Services: len(m.Tasks) + len(m.Secrets)}
		if m.Settings != nil {
			layers.Dashboard = 1
		}
		items = append(items, storeItem{
			ID: id, Name: m.Name, Description: m.Description, Developer: m.Author, Version: pl.Version,
			Icon: m.Icon, Category: m.Category, License: m.License, Installed: pl.Version, Uploaded: true,
			Layers: layers, Secrets: m.Secrets, Permissions: perms(m.Permissions), Info: &info,
		})
	}
	for i := range items {
		it := &items[i]
		if it.Name == "" {
			it.Name = it.ID
		}
		if it.Icon == "" {
			it.Icon = "🧩"
		}
		if !slices.Contains(storeCategories, it.Category) {
			it.Category = "utility"
		}
	}
	slices.SortFunc(items, func(a, b storeItem) int { return strings.Compare(strings.ToLower(a.Name), strings.ToLower(b.Name)) })
	return items, marketErr, fresh, nil
}

// storeFilter reads q, cat and filter from the query; unknown values fall back.
func storeFilter(r *http.Request) storeView {
	q := r.URL.Query()
	v := storeView{
		Query: strings.TrimSpace(q.Get("q")), Category: q.Get("cat"), Filter: q.Get("filter"),
		Categories: storeCategories, Filters: storeFilters,
	}
	if len(v.Query) > 60 {
		v.Query = v.Query[:60]
	}
	if !slices.Contains(storeCategories, v.Category) {
		v.Category = ""
	}
	if !slices.Contains(storeFilters, v.Filter) {
		v.Filter = "all"
	}
	return v
}

func (v *storeView) apply(items []storeItem) {
	v.Total = len(items)
	q := strings.ToLower(v.Query)
	for _, it := range items {
		switch {
		case v.Category != "" && it.Category != v.Category:
		case v.Filter == "installed" && it.Installed == "":
		case v.Filter == "updates" && !it.Update:
		case q != "" && !strings.Contains(strings.ToLower(it.Name+" "+it.Description+" "+it.Developer+" "+it.ID), q):
		default:
			v.Items = append(v.Items, it)
		}
	}
}

// handleStore renders the App Store page, or only the grid for htmx. The
// page and the filters answer from the API's cached market list at once;
// when that list is old or missing, the grid fetches the current one in the
// background (live=1) and replaces itself. "Refresh" downloads it the same way.
func (s *Server) handleStore(w http.ResponseWriter, r *http.Request, p Page) {
	v := storeFilter(r)
	q := r.URL.Query()
	mode := marketCached
	switch {
	case q.Get("live") == "1" && q.Get("refresh") == "1":
		mode = marketRefresh
	case q.Get("live") == "1":
		mode = marketCurrent
	}
	items, marketErr, fresh, err := s.storeItems(r, p, mode)
	if err != nil {
		s.fail(w, r, p, err)
		return
	}
	v.MarketError = marketErr
	if mode == marketCached && (!fresh || q.Get("refresh") == "1") {
		live := url.Values{"live": {"1"}}
		for _, k := range []string{"q", "cat", "filter", "refresh"} {
			if val := q.Get(k); val != "" {
				live.Set(k, val)
			}
		}
		v.Live, v.LiveURL = true, "/store?"+live.Encode()
	}
	v.apply(items)
	p.Nav = "store"
	if isHTMX(r) && r.Header.Get("HX-Target") == "store-grid" {
		s.render(w, http.StatusOK, "store", "store_grid_fragment", withData(p, v))
		return
	}
	s.render(w, http.StatusOK, "store", "layout", withData(p, storePage{List: &v}))
}

func (s *Server) storeDetail(w http.ResponseWriter, r *http.Request, p Page, id string) (storeDetail, bool) {
	if !pluginIDPattern.MatchString(id) {
		s.fail(w, r, p, &api.Error{Status: http.StatusNotFound, Key: "error.not_found"})
		return storeDetail{}, false
	}
	items, _, fresh, err := s.storeItems(r, p, marketCached)
	if err == nil && !fresh && !slices.ContainsFunc(items, func(it storeItem) bool { return it.ID == id }) {
		// Not in the old list (e.g. a new plugin): ask the current one.
		items, _, _, err = s.storeItems(r, p, marketCurrent)
	}
	if err != nil {
		s.fail(w, r, p, err)
		return storeDetail{}, false
	}
	for _, it := range items {
		if it.ID == id {
			d := storeDetail{Item: it}
			for _, perm := range it.Permissions {
				if !perm.Enabled {
					d.Blocked++
				}
			}
			// The install / update dialog sets the published version's permissions to allow.
			for _, perm := range it.MarketPermissions {
				if perm.Mode != "allow" && !perm.Unknown {
					d.Grant++
				}
			}
			if it.Info != nil && len(it.Info.Connect) > 0 {
				// Server names come from the address secrets the sign-in created.
				names := map[string]string{}
				if secrets, err := s.api.UserSecrets(r.Context(), session(r)); err == nil {
					for _, x := range secrets {
						names[x.Key] = strings.TrimPrefix(x.Description, "Plex server ")
					}
				}
				rows := slices.Clone(it.Info.Connect)
				for i := range rows {
					rows[i].Name = names[addressKeyFor(rows[i].Key)]
				}
				d.Connect = connectGroups(rows)
			}
			return d, true
		}
	}
	s.fail(w, r, p, &api.Error{Status: http.StatusNotFound, Key: "error.not_found"})
	return storeDetail{}, false
}

// handleStorePlugin renders the detail page of one plugin.
func (s *Server) handleStorePlugin(w http.ResponseWriter, r *http.Request, p Page) {
	d, ok := s.storeDetail(w, r, p, r.PathValue("plugin"))
	if !ok {
		return
	}
	p.Nav = "store"
	// Back from a sign-in (plexconnect.go).
	if key := r.URL.Query().Get("connected"); secretKeyPattern.MatchString(key) {
		d.Notice = s.i18n.T(p.Locale, "store.connect.done", "secret", key)
	}
	if reason := r.URL.Query().Get("connect_error"); slices.Contains([]string{"expired", "plex", "no_server", "no_token", "save"}, reason) {
		d.ConnectError = s.i18n.T(p.Locale, "store.connect.error."+reason)
	}
	s.render(w, http.StatusOK, "store", "layout", withData(p, storePage{Detail: &d}))
}

// handleStoreInstall installs (or updates to) the published version, then
// switches on every SDK permission the plugin needs that is off (the
// install dialog lists them), and answers the detail panel with a notice.
func (s *Server) handleStoreInstall(w http.ResponseWriter, r *http.Request, p Page) {
	id := r.PathValue("plugin")
	version := strings.TrimSpace(r.PostFormValue("version"))
	if !pluginIDPattern.MatchString(id) || !pluginVersionPattern.MatchString(version) {
		s.fail(w, r, p, &api.Error{Status: http.StatusUnprocessableEntity, Key: "error.plugin.market_input"})
		return
	}
	d, ok := s.storeDetail(w, r, p, id)
	if !ok {
		return
	}
	res, err := s.api.InstallPluginMarket(r.Context(), session(r), id, version)
	if err != nil {
		s.fail(w, r, p, err)
		return
	}
	if err := s.grantPermissions(r, d.Item.MarketPermissions); err != nil {
		s.fail(w, r, p, err)
		return
	}
	s.renderStoreDetail(w, r, p, id, "store.installed", "plugin", res.ID, "version", res.Version)
}

// handleStoreGrant switches on the SDK permissions an installed plugin is
// missing, so the bot starts it again.
func (s *Server) handleStoreGrant(w http.ResponseWriter, r *http.Request, p Page) {
	d, ok := s.storeDetail(w, r, p, r.PathValue("plugin"))
	if !ok {
		return
	}
	if err := s.grantPermissions(r, d.Item.Permissions); err != nil {
		s.fail(w, r, p, err)
		return
	}
	s.renderStoreDetail(w, r, p, d.Item.ID, "store.granted")
}

// grantPermissions sets every listed permission to "allow" that is not
// set so yet: off ones, and on ones that only follow the risk default, so a
// later change of the default cannot switch the plugin off unnoticed.
func (s *Server) grantPermissions(r *http.Request, perms []storePermission) error {
	for _, perm := range perms {
		if perm.Mode == "allow" || perm.Unknown {
			continue
		}
		if _, err := s.api.SetSdkPolicy(r.Context(), session(r), perm.Key, "allow"); err != nil {
			return err
		}
	}
	return nil
}

// handleStoreEnabled switches an installed plugin on or off for every bot.
func (s *Server) handleStoreEnabled(w http.ResponseWriter, r *http.Request, p Page) {
	id := r.PathValue("plugin")
	if !pluginIDPattern.MatchString(id) {
		s.fail(w, r, p, &api.Error{Status: http.StatusNotFound, Key: "error.not_found"})
		return
	}
	on := r.PostFormValue("enabled") == "true"
	if err := s.api.SetPluginEnabled(r.Context(), session(r), id, on); err != nil {
		s.fail(w, r, p, err)
		return
	}
	notice := "store.disabled"
	if on {
		notice = "store.enabled"
	}
	s.renderStoreDetail(w, r, p, id, notice, "plugin", id)
}

// handleStoreUninstall removes the plugin (optionally with its command copies).
func (s *Server) handleStoreUninstall(w http.ResponseWriter, r *http.Request, p Page) {
	id := r.PathValue("plugin")
	if !pluginIDPattern.MatchString(id) {
		s.fail(w, r, p, &api.Error{Status: http.StatusNotFound, Key: "error.not_found"})
		return
	}
	if err := s.api.UninstallPlugin(r.Context(), session(r), id, r.URL.Query().Get("deleteCommands") == "1"); err != nil {
		s.fail(w, r, p, err)
		return
	}
	s.i18n.SetPlugin(id, nil)
	items, _, _, err := s.storeItems(r, p, marketCached)
	if err != nil {
		s.fail(w, r, p, err)
		return
	}
	// An uploaded plugin is gone from the store with its uninstall.
	if !slices.ContainsFunc(items, func(it storeItem) bool { return it.ID == id }) {
		redirect(w, r, "/store")
		return
	}
	s.renderStoreDetail(w, r, p, id, "admin.plugins.uninstalled", "plugin", id)
}

func (s *Server) renderStoreDetail(w http.ResponseWriter, r *http.Request, p Page, id, notice string, args ...any) {
	d, ok := s.storeDetail(w, r, p, id)
	if !ok {
		return
	}
	d.Notice = s.i18n.T(p.Locale, notice, args...)
	s.render(w, http.StatusOK, "store", "store_detail_fragment", withData(p, d))
}
