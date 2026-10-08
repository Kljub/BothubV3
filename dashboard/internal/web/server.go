// Package web contains the dashboard's HTTP server: routing, middleware,
// page handlers and the /api reverse proxy.
package web

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io/fs"
	"log/slog"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/Kljub/BothubV3/dashboard/internal/api"
	"github.com/Kljub/BothubV3/dashboard/internal/i18n"
)

// Config configures the server.
type Config struct {
	API           *api.Client
	I18n          *i18n.Bundle
	UI            fs.FS // templates/, static/
	DefaultLocale string
	Modules       []ModuleCategory
	Commands      map[string][]CommandInfo // module key -> built-in commands
	NodeDefs      []json.RawMessage        // shared/nodes/*.json for the editor
	Events        []EventCategory          // shared/events.json for custom events
	Docs          DocsLibrary              // shared/docs: shipped guides
}

// Server is the dashboard HTTP handler.
type Server struct {
	api           *api.Client
	i18n          *i18n.Bundle
	tpl           *templates
	static        fs.FS
	defaultLocale string
	modules       []ModuleCategory
	commands      map[string][]CommandInfo
	nodeDefs      []json.RawMessage
	events        []EventCategory
	docs          DocsLibrary
	self          *selfSampler
	assetVersion  string
	mainCSS       []byte // css/bothub.css with ?v=<hash> on every @import
	handler       http.Handler
	// exit ends the process for a restart from the resource overview; the
	// supervisor (Docker restart policy, later supervisord) starts it again.
	exit func()
}

// New builds the server and its routes.
func New(cfg Config) (*Server, error) {
	tpl, err := parseTemplates(cfg.UI)
	if err != nil {
		return nil, err
	}
	static, err := fs.Sub(cfg.UI, "static")
	if err != nil {
		return nil, err
	}
	version, err := hashFS(static)
	if err != nil {
		return nil, err
	}

	locale := cfg.DefaultLocale
	if !cfg.I18n.Has(locale) {
		locale = i18n.Fallback
	}

	s := &Server{
		api:           cfg.API,
		i18n:          cfg.I18n,
		tpl:           tpl,
		static:        static,
		defaultLocale: locale,
		modules:       cfg.Modules,
		commands:      cfg.Commands,
		nodeDefs:      cfg.NodeDefs,
		events:        cfg.Events,
		docs:          cfg.Docs,
		self:          newSelfSampler(),
		exit: func() {
			slog.Info("restart requested from the resource overview")
			os.Exit(0)
		},
		assetVersion: version,
	}
	if s.mainCSS, err = versionImports(static, "css/bothub.css", version); err != nil {
		return nil, err
	}
	s.handler = securityHeaders(s.routes())
	customInviteOn.Lock()
	customInviteOn.fetch = func(ctx context.Context, appID string) bool {
		page, err := cfg.API.InvitePage(ctx, appID)
		return err == nil && page.Enabled
	}
	customInviteOn.Unlock()
	return s, nil
}

func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	// API calls of this request tell the API which browser and IP they come
	// from (sessions list, security history).
	s.handler.ServeHTTP(w, r.WithContext(api.WithClient(r.Context(), r.UserAgent(), browserIP(r))))
}

// browserIP is the client address (session list, sign-in limits). The
// X-Forwarded-For header counts only when the request comes from a proxy on
// this machine or the private network (the reverse proxy in front of
// BotHub); its last entry is the address that proxy saw. Anyone else could
// write any address there to dodge the sign-in limits.
func browserIP(r *http.Request) string {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		host = r.RemoteAddr
	}
	if fwd := r.Header.Get("X-Forwarded-For"); fwd != "" && trustedProxy(host) {
		parts := strings.Split(fwd, ",")
		if last := strings.TrimSpace(parts[len(parts)-1]); net.ParseIP(last) != nil {
			return last
		}
	}
	return host
}

// trustedProxy: loopback or a private address (Docker network, LAN).
func trustedProxy(host string) bool {
	ip := net.ParseIP(host)
	return ip != nil && (ip.IsLoopback() || ip.IsPrivate())
}

func (s *Server) routes() http.Handler {
	mux := http.NewServeMux()

	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		_, _ = w.Write([]byte("ok"))
	})
	mux.Handle("GET /static/css/bothub.css", cacheStatic(http.HandlerFunc(s.serveMainCSS)))
	mux.Handle("GET /static/", http.StripPrefix("/static/", cacheStatic(http.FileServerFS(s.static))))
	mux.Handle("/api/", s.apiProxy())
	mux.Handle("GET /cards/", cardFiles())

	// Public pages.
	mux.HandleFunc("GET /setup", s.handleSetupPage)
	mux.HandleFunc("POST /setup", s.handleSetup)
	mux.HandleFunc("GET /login", s.handleLoginPage)
	mux.HandleFunc("GET /device-check", s.handleDeviceCheck)
	// Public legal pages (Discord Developer Portal: Terms of Service and Privacy Policy URLs).
	mux.HandleFunc("GET /terms", s.legalPage("terms"))
	mux.HandleFunc("GET /privacy", s.legalPage("privacy"))
	// Custom invite link of a bot (Developer Portal install link).
	mux.HandleFunc("GET /invite/{app}", s.handleInvitePage)
	mux.HandleFunc("POST /login", s.handleLogin)
	mux.HandleFunc("GET /register", s.handleRegisterPage)
	mux.HandleFunc("POST /register", s.handleRegister)
	mux.HandleFunc("POST /login/totp", s.handleLoginTOTP)

	// Pages behind login.
	auth := func(h authHandler) http.Handler { return s.requireAuth(h) }
	mux.Handle("POST /logout", auth(s.handleLogout))
	// Docs: shipped guides, module reference, own articles (editor).
	mux.Handle("GET /docs", auth(s.handleDocs))
	mux.Handle("GET /docs/new", auth(s.handleDocEditor))
	mux.Handle("GET /docs/edit/{id}", auth(s.handleDocEditor))
	mux.Handle("GET /docs/manage", auth(s.handleDocManage))
	mux.Handle("POST /docs/preview", auth(s.handleDocPreview))
	mux.Handle("POST /docs/save", auth(s.handleDocSave))
	mux.Handle("POST /docs/delete/{id}", auth(s.handleDocDelete))
	mux.Handle("POST /docs/categories", auth(s.handleDocCategorySave))
	mux.Handle("POST /docs/categories/{slug}/delete", auth(s.handleDocCategoryDelete))
	mux.Handle("GET /docs/{category}", auth(s.handleDocs))
	mux.Handle("GET /docs/{category}/{slug}", auth(s.handleDocArticle))
	mux.Handle("GET /{$}", auth(s.handleOverview))
	mux.Handle("GET /overview/tiles", auth(s.handleOverviewTiles))
	mux.Handle("GET /overview/bots", auth(s.handleBotGrid))
	mux.Handle("GET /overview/memory", auth(s.handleOverviewMemory))
	mux.Handle("GET /overview/storage", auth(s.handleOverviewStorage))
	mux.Handle("GET /bots", auth(s.handleBot))
	mux.Handle("GET /bots/{section}", auth(s.handleBot))
	mux.Handle("GET /bots/modules/{key}", auth(s.handleModuleItem("modules")))
	mux.Handle("GET /bots/cards/{cid}", auth(s.handleCardStudio))
	mux.Handle("GET /bots/twitch/connect", auth(s.handleTwitchConnect))
	mux.Handle("POST /bots/twitch/disconnect", auth(s.handleTwitchDisconnect))
	mux.Handle("GET /auth/twitch/callback", auth(s.handleTwitchCallback))
	mux.Handle("GET /bots/plugins/{key}", auth(s.handleModuleItem("plugins")))
	mux.Handle("GET /bots/commands/{name}", auth(s.handleCommandPage))
	mux.Handle("GET /bots/builder/{cid}", auth(s.handleBuilderPage))
	mux.Handle("POST /bot/{id}/custom-commands", auth(s.handleCreateCommand))
	mux.Handle("PUT /bot/{id}/custom-commands/{cid}", auth(s.handleCommandEnabled))
	mux.Handle("DELETE /bot/{id}/custom-commands/{cid}", auth(s.handleDeleteCommand))
	mux.Handle("GET /bot/{id}/custom-commands", auth(s.handleCommandList))
	mux.Handle("PUT /bot/{id}/custom-commands/{cid}/group", auth(s.handleCommandGroupMove))
	mux.Handle("GET /bot/{id}/custom-commands/{cid}/details", auth(s.handleCommandDetails))
	mux.Handle("POST /bot/{id}/custom-commands/{cid}/versions/{vid}/restore", auth(s.handleRestoreVersion))
	mux.Handle("GET /bot/{id}/custom-commands/deleted", auth(s.handleDeletedCommands))
	mux.Handle("POST /bot/{id}/custom-commands/deleted/{cid}/restore", auth(s.handleRestoreDeleted))
	mux.Handle("POST /bot/{id}/custom-events", auth(s.handleCreateCommand))
	mux.Handle("PUT /bot/{id}/custom-events/{cid}", auth(s.handleCommandEnabled))
	mux.Handle("DELETE /bot/{id}/custom-events/{cid}", auth(s.handleDeleteCommand))
	mux.Handle("GET /bot/{id}/custom-events", auth(s.handleCommandList))
	mux.Handle("PUT /bot/{id}/custom-events/{cid}/group", auth(s.handleCommandGroupMove))
	mux.Handle("GET /bot/{id}/custom-events/{cid}/details", auth(s.handleCommandDetails))
	mux.Handle("POST /bot/{id}/custom-events/{cid}/versions/{vid}/restore", auth(s.handleRestoreVersion))
	mux.Handle("GET /bot/{id}/custom-events/deleted", auth(s.handleDeletedCommands))
	mux.Handle("POST /bot/{id}/custom-events/deleted/{cid}/restore", auth(s.handleRestoreDeleted))
	mux.Handle("GET /bots/events/builder/{cid}", auth(s.handleBuilderPage))
	mux.Handle("POST /bot/{id}/webhooks", auth(s.handleWebhookCreate))
	mux.Handle("PUT /bot/{id}/webhooks/{wid}", auth(s.handleWebhookUpdate))
	mux.Handle("DELETE /bot/{id}/webhooks/{wid}", auth(s.handleWebhookDelete))
	mux.Handle("POST /bot/{id}/webhooks/{wid}/test", auth(s.handleWebhookTest))
	mux.Handle("POST /bot/{id}/webhook-key", auth(s.handleWebhookKey))
	mux.Handle("PUT /bot/{id}/modules/{key}/settings", auth(s.handleSettingsSave))
	mux.Handle("POST /bot/{id}/modules/{key}/settings/{list}", auth(s.handleSettingsItem))
	mux.Handle("POST /bot/{id}/module-groups", auth(s.handleModuleGroups))
	mux.Handle("PUT /bot/{id}/modules/{key}/settings/{list}/{idx}", auth(s.handleSettingsItem))
	mux.Handle("DELETE /bot/{id}/modules/{key}/settings/{list}/{idx}", auth(s.handleSettingsItem))
	mux.Handle("POST /bot/{id}/timed-events", auth(s.handleTimedCreate))
	mux.Handle("PUT /bot/{id}/timed-events/{tid}", auth(s.handleTimedUpdate))
	mux.Handle("DELETE /bot/{id}/timed-events/{tid}", auth(s.handleTimedDelete))
	mux.Handle("PUT /bot/{id}/timed-settings", auth(s.handleTimedSettings))
	mux.Handle("PUT /bot/{id}/modules/moderation/config", auth(s.handleModerationConfig))
	mux.Handle("GET /bot/{id}/backup/download", auth(s.handleBackupDownload))
	mux.Handle("POST /bot/{id}/backups", auth(s.handleBackupSave))
	mux.Handle("DELETE /bot/{id}/backups/{tid}", auth(s.handleBackupDelete))
	mux.Handle("POST /bot/{id}/restore", auth(s.handleBackupRestore))
	mux.Handle("GET /bot/{id}/message-templates", auth(s.handleTemplateList))
	mux.Handle("POST /bot/{id}/message-templates", auth(s.handleTemplateCreate))
	mux.Handle("GET /bot/{id}/message-templates/channels", auth(s.handleTemplateChannels))
	mux.Handle("GET /bot/{id}/message-jobs/{jid}", auth(s.handleTemplateJob))
	mux.Handle("GET /bot/{id}/message-templates/{tid}/rename", auth(s.handleTemplateRenameForm))
	mux.Handle("PUT /bot/{id}/message-templates/{tid}/name", auth(s.handleTemplateRename))
	mux.Handle("POST /bot/{id}/message-templates/{tid}/copy", auth(s.handleTemplateCopy))
	mux.Handle("DELETE /bot/{id}/message-templates/{tid}", auth(s.handleTemplateDelete))
	mux.Handle("GET /bot/{id}/message-templates/{tid}/send", auth(s.handleTemplateSendForm))
	mux.Handle("POST /bot/{id}/message-templates/{tid}/send", auth(s.handleTemplateSend))
	mux.Handle("GET /bot/{id}/data/variables", auth(s.handleDataList))
	mux.Handle("GET /bot/{id}/data/variables/new", auth(s.handleDataForm))
	mux.Handle("POST /bot/{id}/data/variables", auth(s.handleDataCreate))
	mux.Handle("GET /bot/{id}/data/variables/{vid}/edit", auth(s.handleDataForm))
	mux.Handle("PUT /bot/{id}/data/variables/{vid}", auth(s.handleDataUpdate))
	mux.Handle("DELETE /bot/{id}/data/variables/{vid}", auth(s.handleDataDelete))
	mux.Handle("GET /bot/{id}/data/variables/{vid}/values", auth(s.handleDataValues))
	mux.Handle("PUT /bot/{id}/data/variables/{vid}/values", auth(s.handleDataSetValue))
	mux.Handle("DELETE /bot/{id}/data/variables/{vid}/values", auth(s.handleDataDeleteValue))
	mux.Handle("GET /bot/{id}/data/lookup", auth(s.handleDataLookup))
	mux.Handle("GET /bot/{id}/command-groups", auth(s.handleCommandGroups))
	mux.Handle("POST /bot/{id}/command-groups", auth(s.handleCreateGroup))
	mux.Handle("PUT /bot/{id}/command-groups/{gid}", auth(s.handleUpdateGroup))
	mux.Handle("DELETE /bot/{id}/command-groups/{gid}", auth(s.handleDeleteGroup))
	mux.Handle("PUT /bot/{id}/modules/{key}/state", auth(s.handleModuleState))
	mux.Handle("PUT /bot/{id}/modules/{key}/commands/{name}", auth(s.handleCommandState))
	mux.Handle("PUT /bot/{id}/plugins/{plugin}", auth(s.handleSetPlugin))
	mux.Handle("PUT /bot/{id}/plugins/{plugin}/settings", auth(s.handlePluginSettingsSave))
	mux.Handle("POST /bot/{id}/plugins/{plugin}/files", auth(s.handlePluginFileUpload))
	mux.Handle("GET /bot/{id}/plugins/{plugin}/files/{name}", auth(s.handlePluginFile))
	mux.Handle("GET /bot/{id}/plugins/{plugin}/download/{name}", auth(s.handlePluginDownload))
	mux.Handle("PUT /bot/{id}/plugins/{plugin}/commands/{cid}", auth(s.handlePluginCommand))
	mux.Handle("POST /bot/{id}/plugins/{plugin}/settings/{list}", auth(s.handlePluginSettingsItem))
	mux.Handle("PUT /bot/{id}/plugins/{plugin}/settings/{list}/{idx}", auth(s.handlePluginSettingsItem))
	mux.Handle("DELETE /bot/{id}/plugins/{plugin}/settings/{list}/{idx}", auth(s.handlePluginSettingsItem))
	mux.Handle("GET /select-bot/{id}", auth(s.handleOpenBot))
	// Updates from the git repository (admins).
	mux.Handle("GET /admin/update/status", auth(s.handleUpdateStatus))
	mux.Handle("GET /admin/update/badge", auth(s.handleUpdateBadge))
	mux.Handle("POST /admin/update/check", auth(s.handleUpdateCheck))
	mux.Handle("POST /admin/update/run", auth(s.handleUpdateRun))
	// Co-Work: members, invites, saved roles; joining by link or invite.
	mux.Handle("POST /bot/{id}/cowork/members/{user}", auth(s.handleCoworkMember))
	mux.Handle("POST /bot/{id}/cowork/members/{user}/remove", auth(s.handleCoworkRemove))
	mux.Handle("POST /bot/{id}/cowork/invites", auth(s.handleCoworkInvite))
	mux.Handle("POST /bot/{id}/cowork/invites/{n}/revoke", auth(s.handleCoworkRevoke))
	mux.Handle("POST /bot/{id}/cowork/roles", auth(s.handleCoworkRoleSave))
	mux.Handle("POST /bot/{id}/cowork/roles/{n}/delete", auth(s.handleCoworkRoleDelete))
	mux.Handle("GET /cowork/join/{token}", auth(s.handleCoworkJoinPage))
	mux.Handle("POST /cowork/join/{token}", auth(s.handleCoworkJoin))
	mux.Handle("POST /invites/{n}/{answer}", auth(s.handleInviteAnswer))
	mux.Handle("GET /home", auth(func(w http.ResponseWriter, r *http.Request, p Page) {
		// Logo: back to the bot selection, nothing selected.
		http.SetCookie(w, &http.Cookie{Name: botCookie, Path: "/", MaxAge: -1})
		http.Redirect(w, r, "/", http.StatusSeeOther)
	}))
	mux.Handle("POST /bots", auth(s.handleCreateBot))
	mux.Handle("DELETE /bot/{id}", auth(s.handleDeleteBot))
	mux.Handle("GET /bot/{id}/card", auth(s.handleBotCard))
	mux.Handle("GET /bot/{id}/stats", auth(s.handleBotStats))
	mux.Handle("GET /bot/{id}/logs", auth(s.handleBotLogs))
	mux.Handle("DELETE /bot/{id}/logs", auth(s.handleClearLogs))
	mux.Handle("GET /bot/{id}/errors", auth(s.handleBotErrors))
	mux.Handle("POST /bot/{id}/errors/dismiss-all", auth(s.handleRunAction))
	mux.Handle("POST /bot/{id}/errors/{rid}/{action}", auth(s.handleRunAction))
	mux.Handle("GET /bot/{id}/logs/export", auth(s.handleBotLogsExport))
	mux.Handle("GET /admin/logs/table", auth(s.handleServerLogs))
	mux.Handle("GET /admin/logs/export", auth(s.handleServerLogsExport))
	mux.Handle("GET /bot/{id}/header", auth(s.handleBotHeader))
	mux.Handle("GET /bot/{id}/media", auth(s.handleBotMedia))
	mux.Handle("POST /bot/{id}/power/{action}", auth(s.handleBotPower))
	mux.Handle("POST /bot/{id}/name", auth(s.handleBotName))
	mux.Handle("POST /bot/{id}/token", auth(s.handleBotToken))
	mux.Handle("PUT /bot/{id}/profile/{kind}", auth(s.handleProfileUpload))
	mux.Handle("POST /bot/{id}/profile/sync", auth(s.handleProfileSync))
	mux.Handle("POST /bot/{id}/profile", auth(s.handleBotProfile))
	mux.Handle("POST /bot/{id}/presence/status", auth(s.handlePresenceStatus))
	mux.Handle("POST /bot/{id}/presence/activity", auth(s.handlePresenceActivity))
	mux.Handle("POST /bot/{id}/presence/show", auth(s.handlePresenceShow))
	mux.Handle("POST /bot/{id}/presence/custom", auth(s.handleCustomStatus))
	mux.Handle("DELETE /bot/{id}/presence/custom", auth(s.handleCustomStatus))
	mux.Handle("POST /bot/{id}/presence/rotation", auth(s.handleRotation))
	mux.Handle("POST /bot/{id}/start", auth(s.handleStartBot))
	mux.Handle("POST /bot/{id}/stop", auth(s.handleStopBot))
	mux.Handle("POST /bot/{id}/restart", auth(s.handleRestartBotCard))
	mux.Handle("PUT /bot/{id}/modules/{key}", auth(s.handleSetModule))
	mux.Handle("DELETE /bot/{id}/guilds/{guildId}", auth(s.handleLeaveGuild))
	mux.Handle("GET /admin/{section}", auth(s.handleAdminSection))
	mux.Handle("POST /settings", auth(s.handleSettings))
	mux.Handle("POST /admin/server-settings", auth(s.handleServerSettings))
	mux.Handle("POST /admin/legal", auth(s.handleLegalSave))
	mux.Handle("POST /admin/invite", auth(s.handleInviteSettings))
	mux.Handle("POST /admin/registration", auth(s.handleRegistrationSettings))
	mux.Handle("POST /admin/security", auth(s.handleSecuritySettings))
	mux.Handle("PUT /bot/{id}/guild-access", auth(s.handleGuildAccess))
	mux.Handle("GET /admin/sdk-policies", auth(s.handleSdkPolicySearch))
	mux.Handle("PUT /admin/sdk-policies/{perm}", auth(s.handleSdkPolicy))
	mux.Handle("GET /admin/resources/table", auth(s.handleResources))
	mux.Handle("POST /admin/resources/{key}/restart", auth(s.handleRestartProcess))
	mux.Handle("POST /admin/roles", auth(s.handleCreateRole))
	mux.Handle("POST /admin/roles/{id}", auth(s.handleUpdateRole))
	mux.Handle("GET /admin/roles/editor", auth(s.handleRoleEditor))
	mux.Handle("DELETE /admin/roles/{id}", auth(s.handleDeleteRole))
	mux.Handle("POST /admin/users", auth(s.handleCreateUser))
	mux.Handle("POST /admin/users/{id}/role", auth(s.handleSetUserRole))
	mux.Handle("DELETE /admin/users/{id}", auth(s.handleDeleteUser))
	mux.Handle("POST /admin/users/{id}", auth(s.handleUpdateUser))
	mux.Handle("POST /admin/email", auth(s.handleSMTPSettings))
	mux.Handle("GET /store", auth(s.handleStore))
	mux.Handle("GET /store/{plugin}", auth(s.handleStorePlugin))
	mux.Handle("POST /store/{plugin}/install", auth(s.handleStoreInstall))
	mux.Handle("DELETE /store/{plugin}", auth(s.handleStoreUninstall))
	mux.Handle("POST /store/upload", auth(s.handleStoreUpload))
	mux.Handle("PUT /store/{plugin}/secrets", auth(s.handleStoreSecrets))
	mux.Handle("POST /store/{plugin}/grant", auth(s.handleStoreGrant))
	mux.Handle("POST /store/{plugin}/connect/{secret}", auth(s.handleConnectStart))
	// Plex sends the browser back from app.plex.tv: a cross-site navigation, so
	// the SameSite=Strict session cookie is not sent. "done" is public and only
	// forwards (same-site) to "finish", which has the cookie again.
	mux.HandleFunc("GET /store/{plugin}/connect/{secret}/done", s.handleConnectBounce)
	mux.Handle("GET /store/{plugin}/connect/{secret}/finish", auth(s.handleConnectDone))
	mux.Handle("DELETE /store/{plugin}/connect/{secret}", auth(s.handleConnectRemove))
	mux.Handle("PUT /store/{plugin}/enabled", auth(s.handleStoreEnabled))
	mux.Handle("POST /admin/secrets", auth(s.handleSecretSave))
	mux.Handle("PUT /admin/secrets/{key}", auth(s.handleSecretSave))
	mux.Handle("DELETE /admin/secrets/{key}", auth(s.handleSecretDelete))
	mux.Handle("GET /account/secrets", auth(s.handleUserSecrets))
	mux.Handle("POST /account/secrets", auth(s.handleSecretSave))
	mux.Handle("PUT /account/secrets/{key}", auth(s.handleSecretSave))
	mux.Handle("DELETE /account/secrets/{key}", auth(s.handleSecretDelete))
	mux.Handle("POST /account/integrations/{name}", auth(s.handleIntegrationSave))
	mux.Handle("DELETE /account/integrations/{name}", auth(s.handleIntegrationDelete))
	mux.Handle("POST /admin/email/test", auth(s.handleSMTPTest))
	mux.Handle("POST /account/password", auth(s.handleChangePassword))
	mux.Handle("POST /account/email", auth(s.handleChangeEmail))
	mux.Handle("POST /account/2fa/setup", auth(s.handleTwoFactorSetup))
	mux.Handle("POST /account/2fa/enable", auth(s.handleTwoFactorEnable))
	mux.Handle("POST /account/2fa/disable", auth(s.handleTwoFactorDisable))
	mux.Handle("GET /account/passkeys", auth(s.handlePasskeys))
	mux.Handle("GET /account/sessions", auth(s.handleSessions))
	mux.Handle("DELETE /account/sessions/{sid}", auth(s.handleRevokeSession))
	mux.Handle("POST /account/sessions/revoke-others", auth(s.handleRevokeOtherSessions))
	mux.Handle("GET /account/activity", auth(s.handleSecurityActivity))
	mux.Handle("DELETE /account/passkeys/{id}", auth(s.handleDeletePasskey))

	return mux
}

// apiProxy forwards /api/* unchanged to the API, so browser-side code (the
// command builder) can call the API through the one public port.
func (s *Server) apiProxy() http.Handler {
	target := s.api.BaseURL()
	return &httputil.ReverseProxy{
		Rewrite: func(pr *httputil.ProxyRequest) {
			pr.SetURL(target)
			pr.SetXForwarded()
			// The client address and agent are set here, never taken from the
			// browser: the API uses them for sign-in limits and the IP blocklist.
			pr.Out.Header.Set("X-BotHub-Client-IP", browserIP(pr.In))
			pr.Out.Header.Set("X-BotHub-Client-Agent", pr.In.UserAgent())
		},
		ErrorHandler: func(w http.ResponseWriter, r *http.Request, err error) {
			slog.Error("api proxy", "path", r.URL.Path, "err", err)
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusBadGateway)
			_, _ = w.Write([]byte(`{"error":{"key":"error.api.unreachable"}}`))
		},
	}
}

// --- middleware ---

type authHandler func(w http.ResponseWriter, r *http.Request, p Page)

// requireAuth loads the current user from the API. Without a valid session it
// redirects to the setup wizard (first start) or to the login page.
func (s *Server) requireAuth(h authHandler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		sess := session(r)
		if sess.Cookie == "" {
			s.redirectToLogin(w, r, nil)
			return
		}
		me, err := s.api.Me(r.Context(), sess)
		if api.IsStatus(err, http.StatusUnauthorized) {
			s.redirectToLogin(w, r, err)
			return
		}
		if err != nil {
			s.fail(w, r, s.pageFor(r, nil), err)
			return
		}
		p := s.pageFor(r, &me)
		// A hard reload (Ctrl+Shift+R) forgets the selected bot.
		if isHardReload(r) {
			http.SetCookie(w, &http.Cookie{Name: botCookie, Path: "/", MaxAge: -1})
			dropCookie(r, botCookie)
		}
		// Full pages show the bot switch in the sidebar; htmx fragments do not need it.
		if isPageRequest(r) {
			bots, err := s.api.ListBots(r.Context(), sess)
			if err != nil {
				s.fail(w, r, p, err)
				return
			}
			p.Bots, p.SelectedBot = bots, selectedBot(r, bots)
		}
		h(w, r, p)
	})
}

// isHardReload reports a full-page load that bypasses the cache: browsers send
// "Cache-Control: no-cache" (and Pragma) only for Ctrl+Shift+R / Ctrl+F5.
// A normal reload sends "max-age=0"; htmx requests never count.
func isHardReload(r *http.Request) bool {
	if r.Method != http.MethodGet || isHTMX(r) {
		return false
	}
	return strings.Contains(r.Header.Get("Cache-Control"), "no-cache") || r.Header.Get("Pragma") == "no-cache"
}

// dropCookie removes a cookie from the request, so later handlers do not see it.
func dropCookie(r *http.Request, name string) {
	cookies := r.Cookies()
	r.Header.Del("Cookie")
	for _, c := range cookies {
		if c.Name != name {
			r.AddCookie(c)
		}
	}
}

// selectedBot is the bot the user picked, remembered in the bothub_bot
// session cookie. Nil if none.
func selectedBot(r *http.Request, bots []api.Bot) *api.Bot {
	id := ""
	if c, err := r.Cookie(botCookie); err == nil {
		id = c.Value
	}
	for i := range bots {
		if strconv.FormatInt(bots[i].ID, 10) == id {
			return &bots[i]
		}
	}
	return nil
}

// redirectToLogin: a lost session goes to login (or setup); a device-bound
// session whose proof ran out goes to the device check first.
func (s *Server) redirectToLogin(w http.ResponseWriter, r *http.Request, err error) {
	if err != nil && api.AsError(err).Key == "error.auth.device_proof" {
		fullRedirect(w, r, "/device-check?next="+url.QueryEscape(returnPath(r)))
		return
	}
	target := "/login"
	if required, err := s.api.SetupRequired(r.Context()); err == nil && required {
		target = "/setup"
	}
	fullRedirect(w, r, target)
}

// securityHeaders sets headers for every response. The CSP allows only local
// scripts and styles; there are no inline handlers or inline scripts.
func securityHeaders(next http.Handler) http.Handler {
	const csp = "default-src 'self'; script-src 'self'; style-src 'self'; " +
		"img-src 'self' data: https://cdn.discordapp.com; connect-src 'self'; " +
		"frame-ancestors 'none'; base-uri 'self'; form-action 'self'"
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		h.Set("Content-Security-Policy", csp)
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("X-Frame-Options", "DENY")
		h.Set("Referrer-Policy", "same-origin")
		next.ServeHTTP(w, r)
	})
}

// cacheStatic lets browsers cache static files; URLs carry ?v=<hash>.
func cacheStatic(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("v") != "" {
			w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
		} else {
			w.Header().Set("Cache-Control", "no-cache")
		}
		next.ServeHTTP(w, r)
	})
}

// versionImports reads the main stylesheet and appends ?v=<version> to every
// @import url('…'), so browsers reload changed component files.
func versionImports(fsys fs.FS, name, version string) ([]byte, error) {
	src, err := fs.ReadFile(fsys, name)
	if err != nil {
		return nil, err
	}
	imports := regexp.MustCompile(`@import url\('([^'?]+)'\)`)
	return imports.ReplaceAll(src, []byte("@import url('$1?v="+version+"')")), nil
}

func (s *Server) serveMainCSS(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "text/css; charset=utf-8")
	_, _ = w.Write(s.mainCSS)
}

// hashFS returns a short hash over all files, used to bust static caches.
func hashFS(fsys fs.FS) (string, error) {
	h := sha256.New()
	err := fs.WalkDir(fsys, ".", func(p string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return err
		}
		b, err := fs.ReadFile(fsys, p)
		if err != nil {
			return err
		}
		h.Write([]byte(p))
		h.Write(b)
		return nil
	})
	return hex.EncodeToString(h.Sum(nil))[:12], err
}

// --- request helpers ---

// session returns the browser's session cookie and CSRF token. The token comes
// from the X-CSRF-Token header (htmx) or the csrf_token form field (plain forms).
// The dashboard does not check it; the API does.
func session(r *http.Request) api.Session {
	var s api.Session
	if c, err := r.Cookie(api.SessionCookie); err == nil {
		s.Cookie = c.Value
	}
	s.CSRF = r.Header.Get("X-CSRF-Token")
	if s.CSRF == "" && r.Method != http.MethodGet {
		s.CSRF = r.PostFormValue("csrf_token")
	}
	return s
}

// pageFor builds the page data. Locale: user setting, else browser, else default.
func (s *Server) pageFor(r *http.Request, me *api.Me) Page {
	p := Page{Locale: s.defaultLocale, Theme: "system"}
	if al := r.Header.Get("Accept-Language"); al != "" {
		p.Locale = s.i18n.Match(al)
	}
	if me != nil {
		p.Me = *me
		p.CSRF = me.CSRFToken
		if s.i18n.Has(me.Locale) {
			p.Locale = me.Locale
		}
		if me.Theme != "" {
			p.Theme = me.Theme
		}
	}
	return p
}

func isHTMX(r *http.Request) bool { return r.Header.Get("HX-Request") == "true" }

// isPageRequest reports a request that renders the full layout (sidebar
// included): a normal load, a boosted link or form (hx-boost on <body>), an
// htmx history restore, or a redirect() target (X-BotHub-Page).
func isPageRequest(r *http.Request) bool {
	return !isHTMX(r) || r.Header.Get("HX-Boosted") == "true" || r.Header.Get("HX-History-Restore-Request") == "true" || r.Header.Get("X-BotHub-Page") == "1"
}

// redirect sends a normal redirect, or HX-Location for htmx requests so htmx
// loads the target page via AJAX instead of a full reload.
func redirect(w http.ResponseWriter, r *http.Request, to string) {
	if isHTMX(r) {
		// The marker header makes the target render as a full page (sidebar with bots).
		loc, _ := json.Marshal(map[string]any{"path": to, "target": "body", "headers": map[string]string{"X-BotHub-Page": "1"}})
		w.Header().Set("HX-Location", string(loc))
		w.WriteHeader(http.StatusNoContent)
		return
	}
	http.Redirect(w, r, to, http.StatusSeeOther)
}

// fullRedirect is redirect with a full page load for htmx requests. Needed for
// pages in auth_layout: an htmx swap keeps the old <body>, so body.auth and its
// centering would be missing.
func fullRedirect(w http.ResponseWriter, r *http.Request, to string) {
	if isHTMX(r) {
		w.Header().Set("HX-Redirect", to)
		w.WriteHeader(http.StatusNoContent)
		return
	}
	http.Redirect(w, r, to, http.StatusSeeOther)
}

// relayCookies passes the API's Set-Cookie headers to the browser.
func relayCookies(w http.ResponseWriter, resp api.Response) {
	for _, c := range resp.SetCookies {
		w.Header().Add("Set-Cookie", c)
	}
}

// fail shows an API error. htmx requests get the message in #flash, full page
// requests get the error page. A lost session always goes back to login.
func (s *Server) fail(w http.ResponseWriter, r *http.Request, p Page, err error) {
	s.failTo(w, r, p, err, "#flash")
}

// failTo is fail with a custom htmx target for the message, e.g. inside a dialog.
func (s *Server) failTo(w http.ResponseWriter, r *http.Request, p Page, err error, target string) {
	apiErr := api.AsError(err)
	if apiErr.Status == http.StatusUnauthorized {
		s.redirectToLogin(w, r, err)
		return
	}
	if apiErr.Status >= 500 || apiErr.Key == "error.api.unreachable" {
		slog.Error("api call failed", "path", r.URL.Path, "err", err)
	}
	msg := s.i18n.T(p.Locale, apiErr.Key, flatten(apiErr.Params)...)

	if isHTMX(r) {
		w.Header().Set("HX-Retarget", target)
		w.Header().Set("HX-Reswap", "innerHTML")
		s.render(w, http.StatusOK, "error", "flash_error_fragment", withData(p, msg))
		return
	}
	status := apiErr.Status
	if status < 400 {
		status = http.StatusBadGateway
	}
	s.render(w, status, "error", "layout", withData(p, map[string]string{"Message": msg}))
}

// flash shows a success message in #flash (htmx requests only).
func (s *Server) flash(w http.ResponseWriter, p Page, key string) {
	s.flashTo(w, p, key, "#flash")
}

// flashTo shows a success message in another element, e.g. inside a dialog.
func (s *Server) flashTo(w http.ResponseWriter, p Page, key, target string) {
	w.Header().Set("HX-Retarget", target)
	w.Header().Set("HX-Reswap", "innerHTML")
	s.render(w, http.StatusOK, "error", "flash_success_fragment", withData(p, s.i18n.T(p.Locale, key)))
}

func withData(p Page, data any) Page {
	p.Data = data
	return p
}

func flatten(m map[string]any) []any {
	out := make([]any, 0, len(m)*2)
	for k, v := range m {
		out = append(out, k, v)
	}
	return out
}

// Timeouts for http.Server, exported for main.
const (
	ReadHeaderTimeout = 5 * time.Second
	WriteTimeout      = 30 * time.Second
	IdleTimeout       = 120 * time.Second
)
