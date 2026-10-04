package web

import (
	"context"
	"net/http"
	"net/url"
	"slices"
	"strconv"
	"strings"

	"github.com/Kljub/BothubV3/dashboard/internal/api"
)

// --- setup and login ---

type authForm struct {
	Username string
	Error    string
}

func (s *Server) handleSetupPage(w http.ResponseWriter, r *http.Request) {
	p := s.pageFor(r, nil)
	required, err := s.api.SetupRequired(r.Context())
	if err != nil {
		s.fail(w, r, p, err)
		return
	}
	if !required {
		http.Redirect(w, r, "/login", http.StatusSeeOther)
		return
	}
	s.render(w, http.StatusOK, "setup", "auth_layout", withData(p, authForm{}))
}

func (s *Server) handleSetup(w http.ResponseWriter, r *http.Request) {
	p := s.pageFor(r, nil)
	form := authForm{Username: strings.TrimSpace(r.PostFormValue("username"))}
	password := r.PostFormValue("password")

	if password != r.PostFormValue("password_confirm") {
		form.Error = s.i18n.T(p.Locale, "error.setup.password_mismatch")
		s.render(w, http.StatusUnprocessableEntity, "setup", "auth_layout", withData(p, form))
		return
	}

	locale := r.PostFormValue("locale")
	if !s.i18n.Has(locale) {
		locale = p.Locale
	}
	_, resp, err := s.api.Setup(r.Context(), api.SetupRequest{Username: form.Username, Password: password, Locale: locale})
	if err != nil {
		form.Error = s.apiErrorText(p, err)
		s.render(w, api.AsError(err).Status, "setup", "auth_layout", withData(p, form))
		return
	}
	relayCookies(w, resp)
	http.Redirect(w, r, "/bots", http.StatusSeeOther)
}

func (s *Server) handleLoginPage(w http.ResponseWriter, r *http.Request) {
	p := s.pageFor(r, nil)
	if required, err := s.api.SetupRequired(r.Context()); err == nil && required {
		http.Redirect(w, r, "/setup", http.StatusSeeOther)
		return
	}
	s.render(w, http.StatusOK, "login", "auth_layout", withData(p, authForm{}))
}

func (s *Server) handleLogin(w http.ResponseWriter, r *http.Request) {
	p := s.pageFor(r, nil)
	form := authForm{Username: strings.TrimSpace(r.PostFormValue("username"))}

	_, resp, err := s.api.Login(r.Context(), form.Username, r.PostFormValue("password"))
	if err != nil {
		apiErr := api.AsError(err)
		// Password correct, 2FA active: ask for the code. The API hands out a
		// short-lived ticket, so the password is never sent back to the browser.
		if apiErr.Key == "error.auth.totp_required" {
			ticket, _ := apiErr.Params["ticket"].(string)
			s.render(w, http.StatusOK, "login_totp", "auth_layout", withData(p, totpForm{Ticket: ticket}))
			return
		}
		form.Error = s.apiErrorText(p, err)
		s.render(w, apiErr.Status, "login", "auth_layout", withData(p, form))
		return
	}
	relayCookies(w, resp)
	http.Redirect(w, r, "/", http.StatusSeeOther)
}

func (s *Server) handleLogout(w http.ResponseWriter, r *http.Request, p Page) {
	resp, err := s.api.Logout(r.Context(), session(r))
	if err != nil && !api.IsStatus(err, http.StatusUnauthorized) {
		s.fail(w, r, p, err)
		return
	}
	relayCookies(w, resp)
	fullRedirect(w, r, "/login")
}

// --- bots ---

// handleCreateBot adds a bot from its token only. The API fetches name and
// application ID from Discord. Errors are shown inside the add-bot dialog.
func (s *Server) handleCreateBot(w http.ResponseWriter, r *http.Request, p Page) {
	bot, err := s.api.CreateBot(r.Context(), session(r), api.BotCreate{
		Token:     strings.TrimSpace(r.PostFormValue("token")),
		Autostart: true,
	})
	if err != nil {
		s.failTo(w, r, p, err, "#add-bot-error")
		return
	}
	// The new bot becomes the selected one: close the dialog and open its
	// overview, so the sidebar shows it right away.
	http.SetCookie(w, &http.Cookie{
		Name: botCookie, Value: strconv.FormatInt(bot.ID, 10), Path: "/",
		HttpOnly: true, SameSite: http.SameSiteStrictMode,
	})
	w.Header().Set("HX-Trigger", "bothub:close-dialogs")
	redirect(w, r, "/bots")
}

// botSections are the entries of the per-bot sidebar category, in order.
var botSections = []string{"overview", "settings", "docs", "invite", "status", "server", "logs", "modules", "plugins"}

// botCookie remembers the bot picked on the dashboard, so its sidebar
// category stays visible on other pages.
const botCookie = "bothub_bot"

// handleOpenBot selects a bot (dashboard tile, bot switch) and opens its page.
// Only the bot ID goes into the session cookie, never the token.
func (s *Server) handleOpenBot(w http.ResponseWriter, r *http.Request, p Page) {
	id, ok := s.botID(w, r, p)
	if !ok {
		return
	}
	http.SetCookie(w, &http.Cookie{
		Name: botCookie, Value: strconv.FormatInt(id, 10), Path: "/",
		HttpOnly: true, SameSite: http.SameSiteStrictMode,
	})
	target := "/bots"
	if to := r.URL.Query().Get("to"); to != "overview" && slices.Contains(botSections, to) {
		target += "/" + to
	}
	http.Redirect(w, r, target, http.StatusSeeOther)
}

// handleBot renders one section of the selected bot: /bots and /bots/{section}.
// The bot comes from the session cookie, so URLs carry no bot ID.
func (s *Server) handleBot(w http.ResponseWriter, r *http.Request, p Page) {
	section := r.PathValue("section")
	if section == "" {
		section = "overview"
	}
	if !slices.Contains(botSections, section) {
		s.fail(w, r, p, &api.Error{Status: http.StatusNotFound, Key: "error.not_found"})
		return
	}
	bot, ok := s.selectedBotOrHome(w, r, p)
	if !ok {
		return
	}
	id, sess := bot.ID, session(r)
	p.SelectedBot = &bot
	p.Nav = "bot_" + section

	data := map[string]any{"Bot": bot, "Section": section}
	switch section {
	case "overview":
		stats, err := s.botStats(r, p, id)
		if err != nil {
			s.fail(w, r, p, err)
			return
		}
		data["Stats"] = stats
	case "settings":
		profile, err := s.api.Profile(r.Context(), sess, id)
		if err != nil {
			s.fail(w, r, p, err)
			return
		}
		data["Media"] = mediaView{Bot: bot, Profile: profile}
		backup, err := s.botBackupView(r, bot)
		if err != nil {
			s.fail(w, r, p, err)
			return
		}
		data["Backup"] = backup
	case "status":
		presence, err := s.api.Presence(r.Context(), sess, id)
		if err != nil {
			s.fail(w, r, p, err)
			return
		}
		profile, err := s.api.Profile(r.Context(), sess, id)
		if err != nil {
			s.fail(w, r, p, err)
			return
		}
		data["Presence"] = presenceView{BotID: id, Presence: presence, Profile: profile}
	case "plugins":
		plugins, err := s.pluginViews(r, id)
		if err != nil {
			s.fail(w, r, p, err)
			return
		}
		data["Plugins"] = plugins
	case "logs":
		logs, err := s.botLogs(r, p, id)
		if err != nil {
			s.fail(w, r, p, err)
			return
		}
		data["Logs"] = logs
	case "invite":
		if bot.ApplicationID != nil {
			data["InviteURL"] = inviteURL(bot.ApplicationID)
		}
	case "server":
		if bot.Status != api.BotRunning {
			break
		}
		guilds, err := s.api.ListGuilds(r.Context(), sess, id)
		if err != nil {
			s.fail(w, r, p, err)
			return
		}
		data["Guilds"] = guilds
	case "modules":
		// Modules apply to all guilds of the bot, so there is no guild choice.
		cats, err := s.moduleCategories(r, id)
		if err != nil {
			s.fail(w, r, p, err)
			return
		}
		data["Categories"] = cats
	}
	s.render(w, http.StatusOK, "bot", "layout", withData(p, data))
}

func (s *Server) handleDeleteBot(w http.ResponseWriter, r *http.Request, p Page) {
	id, ok := s.botID(w, r, p)
	if !ok {
		return
	}
	if err := s.api.DeleteBot(r.Context(), session(r), id); err != nil {
		s.fail(w, r, p, err)
		return
	}
	redirect(w, r, "/")
}

func (s *Server) handleBotCard(w http.ResponseWriter, r *http.Request, p Page) {
	id, ok := s.botID(w, r, p)
	if !ok {
		return
	}
	s.renderBotCard(w, r, p, id)
}

func (s *Server) handleStartBot(w http.ResponseWriter, r *http.Request, p Page) {
	s.botAction(w, r, p, s.api.StartBot)
}

func (s *Server) handleStopBot(w http.ResponseWriter, r *http.Request, p Page) {
	s.botAction(w, r, p, s.api.StopBot)
}

func (s *Server) botAction(w http.ResponseWriter, r *http.Request, p Page, action func(context.Context, api.Session, int64) (api.Job, error)) {
	id, ok := s.botID(w, r, p)
	if !ok {
		return
	}
	if _, err := action(r.Context(), session(r), id); err != nil {
		s.fail(w, r, p, err)
		return
	}
	s.renderBotCard(w, r, p, id)
}

func (s *Server) renderBotCard(w http.ResponseWriter, r *http.Request, p Page, id int64) {
	bot, err := s.api.GetBot(r.Context(), session(r), id)
	if err != nil {
		s.fail(w, r, p, err)
		return
	}
	s.render(w, http.StatusOK, "overview", "bot_card_fragment", withData(p, bot))
}

// handleLeaveGuild makes the bot leave a guild and re-renders the server list.
func (s *Server) handleLeaveGuild(w http.ResponseWriter, r *http.Request, p Page) {
	id, ok := s.botID(w, r, p)
	if !ok {
		return
	}
	sess := session(r)
	if _, err := s.api.LeaveGuild(r.Context(), sess, id, r.PathValue("guildId")); err != nil {
		s.fail(w, r, p, err)
		return
	}
	bot, err := s.api.GetBot(r.Context(), sess, id)
	if err != nil {
		s.fail(w, r, p, err)
		return
	}
	guilds, err := s.api.ListGuilds(r.Context(), sess, id)
	if err != nil {
		s.fail(w, r, p, err)
		return
	}
	s.render(w, http.StatusOK, "bot", "server_list_fragment", withData(p, map[string]any{"Bot": bot, "Guilds": guilds}))
}

// --- admin dialog ---

var themes = []string{"system", "light", "dark"}

// adminSections are the entries of the admin dialog's sidebar, in order.
var adminSections = []string{"overview", "resources", "users_roles", "logs", "sdk_policies", "server_settings", "email", "api_secrets"}

func (s *Server) handleAdminSection(w http.ResponseWriter, r *http.Request, p Page) {
	section := r.PathValue("section")
	if !slices.Contains(adminSections, section) {
		s.fail(w, r, p, &api.Error{Status: http.StatusNotFound, Key: "error.not_found"})
		return
	}
	data := map[string]any{"Section": section, "Themes": themes}
	if section == "overview" {
		stats, err := s.api.OverviewStats(r.Context(), session(r), "24h")
		if err != nil {
			s.fail(w, r, p, err)
			return
		}
		data["Memory"] = s.memoryPanel(stats.Memory, p.Locale)
	}
	if section == "users_roles" {
		v, err := s.usersRoles(r)
		if err != nil {
			s.fail(w, r, p, err)
			return
		}
		data["UsersRoles"] = map[string]any{"View": v}
	}
	if section == "logs" {
		v, err := s.serverLogs(r, p)
		if err != nil {
			s.fail(w, r, p, err)
			return
		}
		data["Logs"] = v
	}
	if section == "resources" {
		rows, err := s.processRows(r, p)
		if err != nil {
			s.fail(w, r, p, err)
			return
		}
		data["Processes"] = rows
	}
	if section == "email" {
		smtp, err := s.api.SMTPSettings(r.Context(), session(r))
		if err != nil {
			s.fail(w, r, p, err)
			return
		}
		data["SMTP"] = smtp
		data["SecurityModes"] = api.SMTPSecurityModes
	}
	if section == "sdk_policies" {
		v, err := s.sdkPolicies(r, p.Locale)
		if err != nil {
			s.fail(w, r, p, err)
			return
		}
		data["SdkPolicies"] = v
	}
	if section == "api_secrets" {
		v, err := s.secretsData(r, p)
		if err != nil {
			s.fail(w, r, p, err)
			return
		}
		data["Secrets"] = v
	}
	if section == "server_settings" {
		settings, err := s.api.ServerSettings(r.Context(), session(r))
		if err != nil {
			s.fail(w, r, p, err)
			return
		}
		data["Server"] = settings
	}
	// The admin popup loads sections via htmx; a direct visit gets a full page.
	if isHTMX(r) {
		s.render(w, http.StatusOK, "admin", "admin_panel_fragment", withData(p, data))
		return
	}
	s.render(w, http.StatusOK, "admin", "layout", withData(p, data))
}

// handleSettings saves language and theme. The theme applies in the browser
// right away; a new language re-renders the current page via AJAX.
func (s *Server) handleSettings(w http.ResponseWriter, r *http.Request, p Page) {
	in := api.Settings{Locale: r.PostFormValue("locale"), Theme: r.PostFormValue("theme")}
	if _, err := s.api.UpdateSettings(r.Context(), session(r), in); err != nil {
		s.fail(w, r, p, err)
		return
	}
	if in.Locale == "" || in.Locale == p.Locale {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	target := "/"
	if u, err := url.Parse(r.Header.Get("HX-Current-URL")); err == nil && u.Path != "" {
		target = u.RequestURI()
	}
	redirect(w, r, target)
}

// handleBotGrid renders the bot tiles (polling and after adding a bot).
func (s *Server) handleBotGrid(w http.ResponseWriter, r *http.Request, p Page) {
	bots, err := s.api.ListBots(r.Context(), session(r))
	if err != nil {
		s.fail(w, r, p, err)
		return
	}
	s.render(w, http.StatusOK, "overview", "bot_grid_fragment", withData(p, botGrid(bots, pageParam(r))))
}

// --- helpers ---

func (s *Server) botID(w http.ResponseWriter, r *http.Request, p Page) (int64, bool) {
	id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil || id < 1 {
		s.fail(w, r, p, &api.Error{Status: http.StatusNotFound, Key: "error.bot.not_found"})
		return 0, false
	}
	return id, true
}

// apiErrorText translates an API error; for validation errors it shows the
// first field error when the API sent one.
func (s *Server) apiErrorText(p Page, err error) string {
	apiErr := api.AsError(err)
	for _, fieldKey := range apiErr.Fields {
		return s.i18n.T(p.Locale, fieldKey)
	}
	return s.i18n.T(p.Locale, apiErr.Key, flatten(apiErr.Params)...)
}

// handleServerSettings saves the instance settings from the admin popup.
// The API validates; ports take effect after a restart.
func (s *Server) handleServerSettings(w http.ResponseWriter, r *http.Request, p Page) {
	num := func(name string) int {
		v, _ := strconv.Atoi(strings.TrimSpace(r.PostFormValue(name)))
		return v
	}
	in := api.ServerSettings{
		Domain:       strings.TrimSpace(r.PostFormValue("domain")),
		PublicPort:   num("public_port"),
		APIPort:      num("api_port"),
		RedisPort:    num("redis_port"),
		BehindProxy:  r.PostFormValue("behind_proxy") == "true",
		SessionHours: num("session_hours"),
		MaxUploadMB:  num("max_upload_mb"),
	}
	saved, err := s.api.UpdateServerSettings(r.Context(), session(r), in)
	if err != nil {
		s.failTo(w, r, p, err, "#admin-flash")
		return
	}
	if saved.RestartRequired {
		s.flashTo(w, p, "server_settings.saved_restart", "#admin-flash")
		return
	}
	s.flashTo(w, p, "server_settings.saved", "#admin-flash")
}
