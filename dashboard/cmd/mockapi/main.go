// Command mockapi is an in-memory stand-in for the PHP API during phase 1.
// It implements the parts of api/openapi.yaml the dashboard uses so far.
// Development only: data is lost on restart.
package main

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"
)

type bot struct {
	ID            int64      `json:"id"`
	Name          string     `json:"name"`
	ApplicationID *string    `json:"applicationId"`
	AvatarURL     *string    `json:"avatarUrl"`
	Status        string     `json:"status"`
	StatusErrKey  *string    `json:"statusErrorKey"`
	TokenSet      bool       `json:"tokenSet"`
	Autostart     bool       `json:"autostart"`
	GuildCount    int        `json:"guildCount"`
	CreatedAt     time.Time  `json:"createdAt"`
	StartedAt     *time.Time `json:"startedAt"` // set while running (bot goes online)
	// Co-Work: owner (0 = nobody, e.g. old bots) and members.
	OwnerID int64       `json:"ownerId"`
	Members []botMember `json:"members"`
	// For the signed-in user: "owner" or the member role, and their rights.
	Access      string   `json:"access,omitempty"`
	Permissions []string `json:"permissions,omitempty"`
	// Discriminator of the bot user ("#1234"), from Discord on demand.
	Discriminator string `json:"discriminator,omitempty"`
	// Bot tile: the profile banner (from Discord) and the presence status.
	BannerURL *string `json:"bannerUrl,omitempty"`
	Presence  string  `json:"presence,omitempty"`
	Verified  bool    `json:"verified,omitempty"` // Discord's Verified Bot badge
	token     string
}

type guild struct {
	ID          string  `json:"id"`
	Name        string  `json:"name"`
	IconURL     *string `json:"iconUrl"`
	MemberCount int     `json:"memberCount"`
}

type sessionData struct {
	csrf      string
	id        string // public ID for the sessions list (never the cookie value)
	createdAt time.Time
	lastSeen  time.Time
	userAgent string
	ip        string
	userID    int64 // the signed-in user
	remember  bool  // "stay signed in"
	expiresAt time.Time
	savedSeen time.Time // lastSeen as last stored in the database
	// Device binding (sessions.go): public key, last proof, open challenge.
	deviceKey    string
	provenAt     time.Time
	challenge    string
	challengeExp time.Time
}

// loginTicket: password right, 2FA asked next (valid 5 minutes). opts are
// the sign-in wishes of the first step.
type loginTicket struct {
	userID  int64
	expires time.Time
	opts    sessionOpts
	tries   int // wrong 2FA codes so far
}

type store struct {
	mu            sync.Mutex
	syncMu        sync.Mutex // orders the writes of account data to the PHP API
	defaultLocale string
	tickets       map[string]loginTicket
	sessions      map[string]*sessionData // by sessionKey(cookie)
	// envPasswordPlain: BOTHUB_ADMIN_PASSWORD is set as plain text (admins see a warning).
	envPasswordPlain bool
	updater          *updater // nil: updates from git are not set up
	updateState      updateState
	registration     registration     // self-registration (registration.go)
	security         securityPolicy   // Security Policies (policies.go)
	discrims         map[int64]string // bot ID -> discriminator of the bot user
	mem              memSampler       // memory of the overview (memstats.go)
	registerLimit    registerLimiter
	bots             map[int64]*bot
	nextID           int64
	modules          map[string]bool // "<botID>/<key>"
	known            map[string]bool // valid module keys

	discord *discordClient
	php     *phpBots // nil: bots stay in memory

	secEvents   []securityEvent
	secrets     map[string]*globalSecret
	webhooks    map[int64][]*webhook
	webhookSeq  int64
	webhookKeys map[int64]webhookKey
	profiles    map[int64]*profileData
	presences   map[int64]*presenceData
	plugins     map[int64][]*installedPlugin
	logs        map[int64][]logEntry
	logSeq      int64

	srvSettings    serverSettings
	legal          legalInfo      // without the PHP API
	invite         inviteSettings // without the PHP API
	started        time.Time
	roles          []*role
	passkeys       *passkeyStore
	cmdStates      map[string]bool // "<botID>/<module>/<command>"
	commandCatalog map[string][]string
	customCmds     map[int64][]*customCommand
	cmdSeq         int64
	templates      map[int64][]*msgTemplate
	eventTypes     map[string]bool
	cmdGroups      map[int64][]*cmdGroup
	groupSeq       int64
	presets        []commandPreset
	sdkPolicies    map[string]bool
	data           dataStore
	deletedCmds    map[int64][]deletedCmd
	tplSeq         int64
	users          []*mockUser
	roleSeq        int64
	userSeq        int64
	smtp           smtpData
	activePorts    [3]int // ports the running instance uses (public, api, redis)
}

func main() {
	// "app hash-password": prints the Argon2id hash of a password (stdin or
	// argument) for BOTHUB_ADMIN_PASSWORD.
	if len(os.Args) > 1 && os.Args[1] == "hash-password" {
		pw := strings.Join(os.Args[2:], " ")
		if pw == "" {
			b, _ := io.ReadAll(io.LimitReader(os.Stdin, 1024))
			pw = strings.TrimRight(string(b), "\r\n")
		}
		if pw == "" {
			fmt.Fprintln(os.Stderr, "usage: app hash-password <password>   (or the password on stdin)")
			os.Exit(2)
		}
		fmt.Println(hashPassword(pw))
		return
	}
	envUser, envPassword := os.Getenv("BOTHUB_ADMIN_USER"), os.Getenv("BOTHUB_ADMIN_PASSWORD")
	s := &store{
		defaultLocale: "en",
		tickets:       map[string]loginTicket{},
		sessions:      map[string]*sessionData{},
		bots:          map[int64]*bot{},
		nextID:        1,
		modules:       map[string]bool{},
		known:         loadModuleKeys(),
	}
	s.srvSettings = defaultServerSettings()
	s.started = time.Now()
	s.smtp = smtpData{Port: 587, Security: "starttls", FromName: "BotHub"}
	s.activePorts = [3]int{s.srvSettings.PublicPort, s.srvSettings.APIPort, s.srvSettings.RedisPort}
	s.customCmds = map[int64][]*customCommand{}
	s.templates = map[int64][]*msgTemplate{}
	s.eventTypes = loadEventTypes()
	s.cmdGroups = map[int64][]*cmdGroup{}
	s.presets = loadCommandPresets()
	s.deletedCmds = map[int64][]deletedCmd{}
	s.seedUsers()
	s.discord = newDiscordClient(envOr("DISCORD_API_URL", discordAPI))
	if s.php = newPHPBots(); s.php != nil {
		slog.Info("mockapi: bots are stored in the PHP API", "url", s.php.base)
	}
	s.passkeys = newPasskeyStore()
	s.cmdStates, s.commandCatalog = map[string]bool{}, loadCommandCatalog()
	s.loadAccounts()
	s.loadServerSettings()
	s.loadRegistration()
	s.loadSecurity()
	go s.runMemorySampler()
	s.loadSMTP()
	s.updater = newUpdater()
	go s.runAutoUpdates()
	// BOTHUB_ADMIN_PASSWORD may be plain text or an Argon2id hash
	// ("$argon2id$…", see "app hash-password"). Plain text works, but admins see
	// a warning until the variable holds a hash.
	envHashed := strings.HasPrefix(envPassword, "$argon2id$")
	s.envPasswordPlain = envPassword != "" && !envHashed
	if s.envPasswordPlain {
		slog.Warn("mockapi: BOTHUB_ADMIN_PASSWORD is plain text; put an Argon2id hash there (docker compose exec app start-app hash-password)")
	}
	if len(s.users) == 0 && envUser != "" && envPassword != "" {
		s.mu.Lock()
		u := s.newUser(envUser, envPassword, 1, nil)
		if envHashed {
			u.passwordHash = envPassword
			s.persistUser(u)
		}
		s.mu.Unlock()
		slog.Info("mockapi: admin user taken from ENV", "user", envUser)
	}

	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/health", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, 200, map[string]string{"status": "ok"})
	})
	mux.HandleFunc("GET /api/v1/setup", s.setupState)
	mux.HandleFunc("GET /api/v1/legal", s.getLegal)
	mux.HandleFunc("GET /api/v1/invite/{app}", s.getInvitePage)
	mux.HandleFunc("GET /api/v1/admin/invite-settings", s.auth(s.getInviteSettings))
	mux.HandleFunc("PUT /api/v1/admin/invite-settings", s.auth(s.putInviteSettings))
	mux.HandleFunc("GET /api/v1/admin/legal", s.auth(s.getAdminLegal))
	mux.HandleFunc("PUT /api/v1/admin/legal", s.auth(s.putAdminLegal))
	mux.HandleFunc("POST /api/v1/setup", s.setup)
	mux.HandleFunc("GET /api/v1/auth/registration", s.registrationOpen)
	mux.HandleFunc("POST /api/v1/auth/register", s.audited("registered", "", nil, s.register))
	mux.HandleFunc("GET /api/v1/admin/registration", s.auth(s.getRegistration))
	mux.HandleFunc("GET /api/v1/admin/security", s.auth(s.getSecurity))
	mux.HandleFunc("PUT /api/v1/admin/security", s.auth(s.putSecurity))
	mux.HandleFunc("PUT /api/v1/admin/registration", s.auth(s.putRegistration))
	mux.HandleFunc("POST /api/v1/auth/login", s.audited("login", "login_failed", []string{"error.auth.invalid_credentials"}, s.login))
	mux.HandleFunc("POST /api/v1/auth/login/totp", s.audited("login", "login_failed", []string{"error.auth.totp_invalid", "error.auth.totp_clock"}, s.loginTOTP))
	mux.HandleFunc("POST /api/v1/auth/passkeys/login/begin", s.loginPasskeyBegin)
	mux.HandleFunc("POST /api/v1/auth/passkeys/login/finish", s.audited("login_passkey", "", nil, s.loginPasskeyFinish))
	mux.HandleFunc("GET /api/v1/auth/passkeys", s.auth(s.listPasskeys))
	mux.HandleFunc("DELETE /api/v1/auth/passkeys/{id}", s.auth(s.auditedAuth("passkey_removed", s.deletePasskey)))
	mux.HandleFunc("POST /api/v1/auth/passkeys/register/begin", s.auth(s.registerPasskeyBegin))
	mux.HandleFunc("POST /api/v1/auth/passkeys/register/finish", s.auth(s.auditedAuth("passkey_added", s.registerPasskeyFinish)))
	mux.HandleFunc("POST /api/v1/auth/password", s.auth(s.auditedAuth("password_changed", s.changePassword)))
	mux.HandleFunc("PUT /api/v1/auth/email", s.auth(s.auditedAuth("email_changed", s.changeEmail)))
	mux.HandleFunc("POST /api/v1/auth/2fa/setup", s.auth(s.setupTwoFactor))
	mux.HandleFunc("POST /api/v1/auth/2fa/enable", s.auth(s.auditedAuth("twofa_enabled", s.enableTwoFactor)))
	mux.HandleFunc("POST /api/v1/auth/2fa/disable", s.auth(s.auditedAuth("twofa_disabled", s.disableTwoFactor)))
	mux.HandleFunc("GET /api/v1/admin/email", s.auth(s.getSMTP))
	mux.HandleFunc("PUT /api/v1/admin/email", s.auth(s.putSMTP))
	mux.HandleFunc("POST /api/v1/admin/email/test", s.auth(s.testSMTP))
	mux.HandleFunc("POST /api/v1/auth/logout", s.auth(s.logout))
	mux.HandleFunc("GET /api/v1/auth/me", s.auth(s.me))
	mux.HandleFunc("GET /api/v1/auth/sessions", s.auth(s.listSessions))
	mux.HandleFunc("GET /api/v1/auth/device/challenge", s.auth(s.deviceChallenge))
	mux.HandleFunc("POST /api/v1/auth/device/proof", s.auth(s.deviceProof))
	mux.HandleFunc("DELETE /api/v1/auth/sessions/{sessionId}", s.auth(s.auditedAuth("session_revoked", s.revokeSession)))
	mux.HandleFunc("POST /api/v1/auth/sessions/revoke-others", s.auth(s.auditedAuth("sessions_revoked", s.revokeOtherSessions)))
	mux.HandleFunc("GET /api/v1/auth/activity", s.auth(s.securityActivity))
	// Admin: global secrets (write-only values).
	mux.HandleFunc("GET /api/v1/admin/plugins", s.auth(s.adminViaPHP(adminPHPRequired)))
	mux.HandleFunc("GET /api/v1/admin/plugins/market", s.auth(s.adminViaPHP(adminPHPRequired)))
	mux.HandleFunc("POST /api/v1/admin/plugins/install", s.auth(s.adminViaPHP(adminPHPRequired)))
	mux.HandleFunc("DELETE /api/v1/admin/plugins/{plugin}", s.auth(s.adminViaPHP(adminPHPRequired)))
	mux.HandleFunc("PATCH /api/v1/admin/plugins/{plugin}", s.auth(s.adminViaPHP(adminPHPRequired)))
	mux.HandleFunc("PUT /api/v1/admin/plugins/{plugin}/secrets", s.auth(s.adminViaPHP(adminPHPRequired)))
	mux.HandleFunc("GET /api/v1/admin/secrets", s.auth(s.adminViaPHP(s.listSecrets)))
	// Docs written in the dashboard (without the PHP API: none, read-only).
	mux.HandleFunc("GET /api/v1/docs", s.auth(s.adminViaPHP(noDocs)))
	mux.HandleFunc("POST /api/v1/docs", s.auth(s.adminViaPHP(adminPHPRequired)))
	mux.HandleFunc("GET /api/v1/docs/categories", s.auth(s.adminViaPHP(noDocs)))
	mux.HandleFunc("POST /api/v1/docs/categories", s.auth(s.adminViaPHP(adminPHPRequired)))
	mux.HandleFunc("DELETE /api/v1/docs/categories/{slug}", s.auth(s.adminViaPHP(adminPHPRequired)))
	mux.HandleFunc("GET /api/v1/docs/{id}", s.auth(s.adminViaPHP(adminPHPRequired)))
	mux.HandleFunc("PUT /api/v1/docs/{id}", s.auth(s.adminViaPHP(adminPHPRequired)))
	mux.HandleFunc("DELETE /api/v1/docs/{id}", s.auth(s.adminViaPHP(adminPHPRequired)))
	mux.HandleFunc("PUT /api/v1/admin/secrets/{key}", s.auth(s.adminViaPHP(s.putSecret)))
	mux.HandleFunc("DELETE /api/v1/admin/secrets/{key}", s.auth(s.adminViaPHP(s.deleteSecret)))
	// Own secrets of the signed-in user (without PHP: the same in-memory list).
	mux.HandleFunc("GET /api/v1/me/secrets", s.auth(s.adminViaPHP(s.listSecrets)))
	mux.HandleFunc("PUT /api/v1/me/secrets/{key}", s.auth(s.adminViaPHP(s.putSecret)))
	mux.HandleFunc("DELETE /api/v1/me/secrets/{key}", s.auth(s.adminViaPHP(s.deleteSecret)))
	mux.HandleFunc("GET /api/v1/settings", s.auth(s.settings))
	mux.HandleFunc("PATCH /api/v1/settings", s.auth(s.updateSettings))
	mux.HandleFunc("GET /api/v1/bots", s.auth(s.listBots))
	mux.HandleFunc("POST /api/v1/bots", s.auth(s.createBot))
	mux.HandleFunc("GET /api/v1/bots/{id}", s.auth(s.withBot(s.getBot)))
	mux.HandleFunc("PUT /api/v1/me/bot-order", s.auth(s.putBotOrder))
	mux.HandleFunc("GET /api/v1/bots/{id}/module-groups", s.auth(s.withBot(s.getModuleGroups)))
	mux.HandleFunc("PUT /api/v1/bots/{id}/module-groups", s.auth(s.withBot(s.putModuleGroups)))
	// Co-Work: the owner and members of a bot ({user}: ID or user name).
	mux.HandleFunc("GET /api/v1/bots/{id}/members", s.auth(s.withBot(s.listMembers)))
	mux.HandleFunc("PUT /api/v1/bots/{id}/members/{user}", s.auth(s.withBot(s.setMember)))
	mux.HandleFunc("DELETE /api/v1/bots/{id}/members/{user}", s.auth(s.withBot(s.removeMember)))
	mux.HandleFunc("GET /api/v1/bots/{id}/cowork", s.auth(s.withBot(s.coworkPage)))
	mux.HandleFunc("POST /api/v1/bots/{id}/cowork/invites", s.auth(s.withBot(s.createInvite)))
	mux.HandleFunc("DELETE /api/v1/bots/{id}/cowork/invites/{n}", s.auth(s.withBot(s.viaPHP(phpRequiredBot))))
	mux.HandleFunc("POST /api/v1/bots/{id}/cowork/roles", s.auth(s.withBot(s.viaPHP(phpRequiredBot))))
	mux.HandleFunc("DELETE /api/v1/bots/{id}/cowork/roles/{n}", s.auth(s.withBot(s.viaPHP(phpRequiredBot))))
	// The signed-in user's invites; accept by link token or invite ID.
	mux.HandleFunc("GET /api/v1/invites", s.auth(s.adminViaPHP(noDocs)))
	mux.HandleFunc("POST /api/v1/invites/accept", s.auth(s.adminViaPHP(adminPHPRequired)))
	mux.HandleFunc("POST /api/v1/invites/{n}/decline", s.auth(s.adminViaPHP(adminPHPRequired)))
	mux.HandleFunc("PATCH /api/v1/bots/{id}", s.auth(s.withBot(s.updateBot)))
	mux.HandleFunc("DELETE /api/v1/bots/{id}", s.auth(s.withBot(s.deleteBot)))
	mux.HandleFunc("POST /api/v1/bots/{id}/start", s.auth(s.withBot(s.startBot)))
	mux.HandleFunc("POST /api/v1/bots/{id}/stop", s.auth(s.withBot(s.stopBot)))
	mux.HandleFunc("GET /api/v1/bots/{id}/guilds", s.auth(s.withBot(s.listGuilds)))
	mux.HandleFunc("GET /api/v1/bots/{id}/guilds/{guildId}/roles", s.auth(s.withBot(s.listGuildRoles)))
	mux.HandleFunc("GET /api/v1/bots/{id}/guilds/{guildId}/channels", s.auth(s.withBot(s.listGuildChannels)))
	mux.HandleFunc("GET /api/v1/bots/{id}/modules", s.auth(s.withBot(s.modulesFromPHP(s.listModules))))
	mux.HandleFunc("PUT /api/v1/bots/{id}/modules/{key}", s.auth(s.withBot(s.viaPHP(s.setModule))))
	mux.HandleFunc("GET /api/v1/bots/{id}/modules/{key}/config", s.auth(s.withBot(s.viaPHP(phpRequired))))
	mux.HandleFunc("PUT /api/v1/bots/{id}/modules/{key}/config", s.auth(s.withBot(s.viaPHP(phpRequired))))
	mux.HandleFunc("GET /api/v1/stats/overview", s.auth(s.overviewStats))
	mux.HandleFunc("GET /api/v1/admin/server-settings", s.auth(s.getServerSettings))
	mux.HandleFunc("GET /api/v1/admin/sdk-policies", s.auth(s.listSdkPolicies))
	// Updates from the git repository (updater.go).
	mux.HandleFunc("GET /api/v1/admin/update", s.auth(s.getUpdate))
	mux.HandleFunc("POST /api/v1/admin/update/check", s.auth(s.checkUpdate))
	mux.HandleFunc("POST /api/v1/admin/update/run", s.auth(s.runUpdate))
	mux.HandleFunc("GET /api/v1/bots/{id}/backup", s.auth(s.withBot(s.viaPHP(phpRequired))))
	mux.HandleFunc("GET /api/v1/bots/{id}/guild-access", s.auth(s.withBot(s.viaPHP(phpRequired))))
	mux.HandleFunc("PUT /api/v1/bots/{id}/guild-access", s.auth(s.withBot(s.viaPHP(phpRequired))))
	mux.HandleFunc("GET /api/v1/bots/{id}/backups", s.auth(s.withBot(s.viaPHP(phpRequired))))
	mux.HandleFunc("POST /api/v1/bots/{id}/backups", s.auth(s.withBot(s.viaPHP(phpRequired))))
	mux.HandleFunc("GET /api/v1/bots/{id}/backups/{tid}", s.auth(s.withBot(s.viaPHP(phpRequired))))
	mux.HandleFunc("DELETE /api/v1/bots/{id}/backups/{tid}", s.auth(s.withBot(s.viaPHP(phpRequired))))
	mux.HandleFunc("POST /api/v1/bots/{id}/restore", s.auth(s.withBot(s.viaPHP(phpRequired))))
	mux.HandleFunc("PUT /api/v1/admin/sdk-policies/{perm}", s.auth(s.setSdkPolicy))
	mux.HandleFunc("GET /api/v1/admin/processes", s.auth(s.processes))
	mux.HandleFunc("POST /api/v1/admin/processes/{key}/restart", s.auth(s.restartProcess))
	mux.HandleFunc("GET /api/v1/admin/logs", s.auth(s.adminViaPHP(s.listServerLogs)))
	mux.HandleFunc("GET /api/v1/bots/{id}/modules/{key}/commands", s.auth(s.withBot(s.listModuleCommands)))
	mux.HandleFunc("GET /api/v1/bots/{id}/commands", s.auth(s.withBot(s.viaPHP(s.listCommands))))
	mux.HandleFunc("GET /api/v1/bots/{id}/commands/deleted", s.auth(s.withBot(s.viaPHP(s.listDeleted))))
	mux.HandleFunc("POST /api/v1/bots/{id}/commands/deleted/{cid}/restore", s.auth(s.withBot(s.viaPHP(s.restoreDeleted))))
	mux.HandleFunc("POST /api/v1/bots/{id}/commands/{cid}/versions/{vid}/restore", s.auth(s.withBot(s.viaPHP(s.restoreVersion))))
	mux.HandleFunc("GET /api/v1/bots/{id}/command-groups", s.auth(s.withBot(s.viaPHP(s.listGroups))))
	mux.HandleFunc("POST /api/v1/bots/{id}/command-groups", s.auth(s.withBot(s.viaPHP(s.createGroup))))
	mux.HandleFunc("PUT /api/v1/bots/{id}/command-groups/{gid}", s.auth(s.withBot(s.viaPHP(s.updateGroup))))
	mux.HandleFunc("DELETE /api/v1/bots/{id}/command-groups/{gid}", s.auth(s.withBot(s.viaPHP(s.deleteGroup))))
	mux.HandleFunc("POST /api/v1/bots/{id}/commands", s.auth(s.withBot(s.viaPHP(s.createCommand))))
	mux.HandleFunc("GET /api/v1/bots/{id}/commands/{cid}", s.auth(s.withBot(s.viaPHP(s.getCommand))))
	mux.HandleFunc("PATCH /api/v1/bots/{id}/commands/{cid}", s.auth(s.withBot(s.viaPHP(s.patchCommand))))
	mux.HandleFunc("PUT /api/v1/bots/{id}/commands/{cid}", s.auth(s.withBot(s.viaPHP(s.saveCommand))))
	mux.HandleFunc("POST /api/v1/bots/{id}/commands/{cid}/simulate", s.auth(s.withBot(s.simulateCommand)))
	// Card Designer: image cards (PHP API only).
	mux.HandleFunc("GET /api/v1/bots/{id}/cards", s.auth(s.withBot(s.viaPHP(phpRequired))))
	mux.HandleFunc("POST /api/v1/bots/{id}/cards", s.auth(s.withBot(s.viaPHP(phpRequired))))
	mux.HandleFunc("GET /api/v1/bots/{id}/cards/{cid}", s.auth(s.withBot(s.viaPHP(phpRequired))))
	mux.HandleFunc("PUT /api/v1/bots/{id}/cards/{cid}", s.auth(s.withBot(s.viaPHP(phpRequired))))
	mux.HandleFunc("DELETE /api/v1/bots/{id}/cards/{cid}", s.auth(s.withBot(s.viaPHP(phpRequired))))
	mux.HandleFunc("POST /api/v1/bots/{id}/cards/{cid}/send", s.auth(s.withBot(s.viaPHP(phpRequired))))
	mux.HandleFunc("GET /api/v1/bots/{id}/card-images", s.auth(s.withBot(s.viaPHP(phpRequired))))
	mux.HandleFunc("POST /api/v1/bots/{id}/card-images", s.auth(s.withBot(s.viaPHP(phpRequired))))
	mux.HandleFunc("GET /api/v1/bots/{id}/card-images/{iid}", s.auth(s.withBot(s.viaPHP(phpRequired))))
	mux.HandleFunc("DELETE /api/v1/bots/{id}/card-images/{iid}", s.auth(s.withBot(s.viaPHP(phpRequired))))
	mux.HandleFunc("GET /api/v1/bots/{id}/message-templates", s.auth(s.withBot(s.viaPHP(s.listTemplates))))
	mux.HandleFunc("GET /api/v1/bots/{id}/message-templates/{tid}", s.auth(s.withBot(s.viaPHP(s.getTemplate))))
	mux.HandleFunc("GET /api/v1/jobs/{jid}", s.auth(s.jobStatus))
	mux.HandleFunc("PUT /api/v1/bots/{id}/message-templates/{tid}", s.auth(s.withBot(s.viaPHP(s.updateTemplate))))
	mux.HandleFunc("POST /api/v1/bots/{id}/message-templates/{tid}/send", s.auth(s.withBot(s.viaPHP(phpRequired))))
	mux.HandleFunc("GET /api/v1/bots/{id}/commands/{cid}/versions", s.auth(s.withBot(s.viaPHP(s.listVersions))))
	mux.HandleFunc("GET /api/v1/bots/{id}/commands/{cid}/versions/{vid}", s.auth(s.withBot(s.viaPHP(s.getVersion))))
	mux.HandleFunc("POST /api/v1/bots/{id}/message-templates", s.auth(s.withBot(s.viaPHP(s.createTemplate))))
	mux.HandleFunc("DELETE /api/v1/bots/{id}/message-templates/{tid}", s.auth(s.withBot(s.viaPHP(s.deleteTemplate))))
	mux.HandleFunc("GET /api/v1/bots/{id}/data/variables", s.auth(s.withBot(s.viaPHP(s.listDataVariables))))
	mux.HandleFunc("POST /api/v1/bots/{id}/data/variables", s.auth(s.withBot(s.viaPHP(s.createDataVariable))))
	mux.HandleFunc("PUT /api/v1/bots/{id}/data/variables/{vid}", s.auth(s.withBot(s.viaPHP(s.updateDataVariable))))
	mux.HandleFunc("DELETE /api/v1/bots/{id}/data/variables/{vid}", s.auth(s.withBot(s.viaPHP(s.deleteDataVariable))))
	mux.HandleFunc("GET /api/v1/bots/{id}/data/variables/{vid}/values", s.auth(s.withBot(s.viaPHP(s.listDataValues))))
	mux.HandleFunc("PUT /api/v1/bots/{id}/data/variables/{vid}/values", s.auth(s.withBot(s.viaPHP(s.setDataValue))))
	mux.HandleFunc("DELETE /api/v1/bots/{id}/data/variables/{vid}/values", s.auth(s.withBot(s.viaPHP(s.deleteDataValues))))
	mux.HandleFunc("GET /api/v1/bots/{id}/data/variables/{vid}/values.csv", s.auth(s.withBot(s.exportDataValues)))
	mux.HandleFunc("GET /api/v1/bots/{id}/data/lookup", s.auth(s.withBot(s.viaPHP(s.lookupDataValues))))
	mux.HandleFunc("DELETE /api/v1/bots/{id}/commands/{cid}", s.auth(s.withBot(s.viaPHP(s.deleteCommand))))
	mux.HandleFunc("GET /api/v1/bots/{id}/events", s.auth(s.withBot(s.viaPHP(s.listCommands))))
	mux.HandleFunc("GET /api/v1/bots/{id}/events/deleted", s.auth(s.withBot(s.viaPHP(s.listDeleted))))
	mux.HandleFunc("POST /api/v1/bots/{id}/events/deleted/{cid}/restore", s.auth(s.withBot(s.viaPHP(s.restoreDeleted))))
	mux.HandleFunc("POST /api/v1/bots/{id}/events/{cid}/versions/{vid}/restore", s.auth(s.withBot(s.viaPHP(s.restoreVersion))))
	mux.HandleFunc("POST /api/v1/bots/{id}/events", s.auth(s.withBot(s.viaPHP(s.createCommand))))
	mux.HandleFunc("GET /api/v1/bots/{id}/events/{cid}", s.auth(s.withBot(s.viaPHP(s.getCommand))))
	mux.HandleFunc("PATCH /api/v1/bots/{id}/events/{cid}", s.auth(s.withBot(s.viaPHP(s.patchCommand))))
	mux.HandleFunc("PUT /api/v1/bots/{id}/events/{cid}", s.auth(s.withBot(s.viaPHP(s.saveCommand))))
	mux.HandleFunc("POST /api/v1/bots/{id}/events/{cid}/simulate", s.auth(s.withBot(s.simulateCommand)))
	mux.HandleFunc("GET /api/v1/bots/{id}/events/{cid}/versions", s.auth(s.withBot(s.viaPHP(s.listVersions))))
	mux.HandleFunc("GET /api/v1/bots/{id}/events/{cid}/versions/{vid}", s.auth(s.withBot(s.viaPHP(s.getVersion))))
	mux.HandleFunc("DELETE /api/v1/bots/{id}/events/{cid}", s.auth(s.withBot(s.viaPHP(s.deleteCommand))))
	mux.HandleFunc("PUT /api/v1/bots/{id}/modules/{key}/commands/{name}", s.auth(s.withBot(s.setModuleCommand)))
	mux.HandleFunc("GET /api/v1/admin/roles", s.auth(s.listRoles))
	mux.HandleFunc("POST /api/v1/admin/roles", s.auth(s.createRole))
	mux.HandleFunc("PUT /api/v1/admin/roles/{id}", s.auth(s.updateRole))
	mux.HandleFunc("DELETE /api/v1/admin/roles/{id}", s.auth(s.deleteRole))
	mux.HandleFunc("GET /api/v1/admin/users", s.auth(s.listUsers))
	mux.HandleFunc("POST /api/v1/admin/users", s.auth(s.createUser))
	mux.HandleFunc("PATCH /api/v1/admin/users/{id}", s.auth(s.patchUser))
	mux.HandleFunc("DELETE /api/v1/admin/users/{id}", s.auth(s.deleteUser))
	mux.HandleFunc("PUT /api/v1/admin/server-settings", s.auth(s.putServerSettings))
	mux.HandleFunc("POST /api/v1/bots/{id}/restart", s.auth(s.withBot(s.restartBot)))
	mux.HandleFunc("GET /api/v1/bots/{id}/profile", s.auth(s.withBot(s.getProfile)))
	mux.HandleFunc("PATCH /api/v1/bots/{id}/profile", s.auth(s.withBot(s.patchProfile)))
	mux.HandleFunc("POST /api/v1/bots/{id}/profile/sync", s.auth(s.withBot(s.syncProfile)))
	mux.HandleFunc("PUT /api/v1/bots/{id}/profile/{kind}", s.auth(s.withBot(s.uploadProfile)))
	mux.HandleFunc("GET /api/v1/bots/{id}/presence", s.auth(s.withBot(s.viaPHP(s.getPresence))))
	mux.HandleFunc("PATCH /api/v1/bots/{id}/presence", s.auth(s.withBot(s.viaPHP(s.patchPresence))))
	mux.HandleFunc("GET /api/v1/bots/{id}/stats", s.auth(s.withBot(s.viaPHP(s.botStats))))
	mux.HandleFunc("GET /api/v1/bots/{id}/logs", s.auth(s.withBot(s.viaPHP(s.listLogs))))
	mux.HandleFunc("DELETE /api/v1/bots/{id}/logs", s.auth(s.withBot(s.viaPHP(s.clearLogs))))
	mux.HandleFunc("GET /api/v1/bots/{id}/plugins", s.auth(s.withBot(s.viaPHP(s.listPlugins))))
	mux.HandleFunc("PATCH /api/v1/bots/{id}/plugins/{plugin}", s.auth(s.withBot(s.viaPHP(s.patchPlugin))))
	mux.HandleFunc("GET /api/v1/bots/{id}/plugins/{plugin}/config", s.auth(s.withBot(s.viaPHP(phpRequired))))
	mux.HandleFunc("GET /api/v1/bots/{id}/plugins/{plugin}/options", s.auth(s.withBot(s.viaPHP(phpRequired))))
	mux.HandleFunc("PUT /api/v1/bots/{id}/plugins/{plugin}/config", s.auth(s.withBot(s.viaPHP(phpRequired))))
	mux.HandleFunc("GET /api/v1/bots/{id}/plugins/{plugin}/files", s.auth(s.withBot(s.viaPHP(phpRequired))))
	mux.HandleFunc("POST /api/v1/bots/{id}/plugins/{plugin}/files", s.auth(s.withBot(s.viaPHP(phpRequired))))
	mux.HandleFunc("GET /api/v1/bots/{id}/plugins/{plugin}/files/{name}", s.auth(s.withBot(s.viaPHP(phpRequired))))
	mux.HandleFunc("DELETE /api/v1/bots/{id}/guilds/{guildId}", s.auth(s.withBot(s.leaveGuild)))
	// Webhooks (module page) and the public receiver for external services.
	mux.HandleFunc("GET /api/v1/bots/{id}/webhooks", s.auth(s.withBot(s.viaPHP(s.listWebhooks))))
	mux.HandleFunc("POST /api/v1/bots/{id}/webhooks", s.auth(s.withBot(s.viaPHP(s.createWebhook))))
	mux.HandleFunc("PATCH /api/v1/bots/{id}/webhooks/{wid}", s.auth(s.withBot(s.viaPHP(s.patchWebhook))))
	mux.HandleFunc("DELETE /api/v1/bots/{id}/webhooks/{wid}", s.auth(s.withBot(s.viaPHP(s.deleteWebhook))))
	mux.HandleFunc("POST /api/v1/bots/{id}/webhooks/{wid}/test", s.auth(s.withBot(s.viaPHP(s.testWebhook))))
	mux.HandleFunc("POST /api/v1/bots/{id}/webhook-key", s.auth(s.withBot(s.viaPHP(s.createWebhookKey))))
	mux.HandleFunc("POST /api/hooks/{botId}/{eventId}", s.hookToPHP)
	// Timed events live only in the PHP API (no in-memory fallback).
	mux.HandleFunc("GET /api/v1/bots/{id}/timed-events", s.auth(s.withBot(s.viaPHP(phpRequired))))
	mux.HandleFunc("POST /api/v1/bots/{id}/timed-events", s.auth(s.withBot(s.viaPHP(phpRequired))))
	mux.HandleFunc("GET /api/v1/bots/{id}/timed-events/{tid}", s.auth(s.withBot(s.viaPHP(phpRequired))))
	mux.HandleFunc("PUT /api/v1/bots/{id}/timed-events/{tid}", s.auth(s.withBot(s.viaPHP(phpRequired))))
	mux.HandleFunc("DELETE /api/v1/bots/{id}/timed-events/{tid}", s.auth(s.withBot(s.viaPHP(phpRequired))))
	mux.HandleFunc("GET /api/v1/bots/{id}/timed-settings", s.auth(s.withBot(s.viaPHP(phpRequired))))
	mux.HandleFunc("PATCH /api/v1/bots/{id}/timed-settings", s.auth(s.withBot(s.viaPHP(phpRequired))))
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) { apiError(w, 404, "error.not_found") })

	addr := envOr("LISTEN_ADDR", ":9000")
	slog.Info("mockapi listening", "addr", addr)
	if err := http.ListenAndServe(addr, s.blocklistMiddleware(mux)); err != nil {
		slog.Error("mockapi stopped", "err", err)
		os.Exit(1)
	}
}

// --- auth ---

type authed func(w http.ResponseWriter, r *http.Request, sid string)

// auth is the one central check: session for every route, CSRF for every
// changing method.
func (s *store) auth(next authed) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		c, err := r.Cookie("bothub_session")
		key := ""
		s.mu.Lock()
		var sess *sessionData
		if err == nil {
			key = sessionKey(c.Value)
			sess = s.sessions[key]
		}
		if sess != nil && (s.userByID(sess.userID) == nil || time.Now().After(sess.expiresAt)) {
			s.dropSession(key) // the user was deleted, or the session ran out
			sess = nil
		}
		proof := sess != nil && needsDeviceProof(sess, r.URL.Path)
		admin, twoFA := false, false
		if sess != nil && !proof {
			s.touchSession(key, sess, r)
			r = r.WithContext(withUser(r.Context(), sess.userID))
			admin = slices.Contains(s.permissionsOf(s.userByID(sess.userID)), "admin.access")
			twoFA = s.needs2FA(s.userByID(sess.userID))
		}
		s.mu.Unlock()
		if sess == nil {
			apiError(w, 401, "error.auth.required")
			return
		}
		if proof {
			apiError(w, 401, "error.auth.device_proof")
			return
		}
		// Security Policies: without the required 2FA only reading and the own sign-in settings.
		if twoFA && !allowedWithout2FA(r) {
			apiError(w, 403, "error.security.2fa_required")
			return
		}
		// The admin area (users, roles, server settings, SDK policies, …) is for instance admins only.
		if strings.HasPrefix(r.URL.Path, "/api/v1/admin/") && !admin {
			apiError(w, 403, "error.access.denied")
			return
		}
		if r.Method != http.MethodGet {
			got := r.Header.Get("X-CSRF-Token")
			if subtle.ConstantTimeCompare([]byte(got), []byte(sess.csrf)) != 1 {
				apiError(w, 403, "error.csrf.invalid")
				return
			}
		}
		next(w, r, key)
	}
}

func (s *store) setupState(w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	defer s.mu.Unlock()
	writeJSON(w, 200, map[string]bool{"required": len(s.users) == 0})
}

func (s *store) setup(w http.ResponseWriter, r *http.Request) {
	var in struct{ Username, Password, Locale string }
	if !readJSON(w, r, &in) {
		return
	}
	s.mu.Lock()
	if len(s.users) > 0 {
		s.mu.Unlock()
		apiError(w, 409, "error.setup.already_done")
		return
	}
	if len(in.Username) < 3 || len(in.Username) > 32 || len(in.Password) < minPassword {
		s.mu.Unlock()
		apiError(w, 422, "error.field.too_short")
		return
	}
	if in.Locale != "" {
		s.defaultLocale = in.Locale
	}
	u := s.newUser(in.Username, in.Password, 1, nil)
	s.mu.Unlock()
	s.startSession(w, r, 201, u.ID, sessionOpts{})
}

func (s *store) login(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Username, Password string
		sessionOpts
	}
	if !readJSON(w, r, &in) {
		return
	}
	ip := clientIP(r)
	if wait := logins.blocked(ip, in.Username); wait > 0 {
		apiErrorParams(w, 429, "error.auth.too_many_attempts", map[string]any{"minutes": wait})
		return
	}
	s.mu.Lock()
	u := s.userByName(in.Username)
	hash := ""
	if u != nil {
		hash = u.passwordHash
	}
	s.mu.Unlock()
	// The hash is checked outside the lock (Argon2id takes a moment); an unknown
	// name costs the same as a wrong password.
	if hash == "" {
		hash = dummyHash
	}
	ok := checkPassword(hash, in.Password) && u != nil
	s.mu.Lock()
	if ok && s.roleKey(u.RoleID) == "banned" {
		ok = false
	}
	if ok && u.totpSecret != "" {
		// Password right, 2FA on: hand out a short-lived ticket for the second step.
		ticket := s.newTicket(u.ID, in.sessionOpts)
		s.mu.Unlock()
		apiErrorParams(w, 401, "error.auth.totp_required", map[string]any{"ticket": ticket})
		return
	}
	s.mu.Unlock()
	if !ok {
		logins.failed(ip, in.Username)
		apiError(w, 401, "error.auth.invalid_credentials")
		return
	}
	logins.succeeded(ip, in.Username)
	s.startSession(w, r, 200, u.ID, in.sessionOpts)
}

// startSession always creates a new session ID (no fixation). The cookie is
// 32 random bytes; only its hash is kept (sessions.go).
func (s *store) startSession(w http.ResponseWriter, r *http.Request, status int, userID int64, opts sessionOpts) {
	if opts.DeviceKey != "" {
		if _, err := parseDeviceKey(opts.DeviceKey); err != nil {
			apiError(w, 422, "error.auth.device_key_invalid")
			return
		}
	}
	sid, csrf := randomHex(32), randomHex(32)
	key := sessionKey(sid)
	now := time.Now().UTC()
	s.mu.Lock()
	sess := &sessionData{csrf: csrf, id: randomHex(8), createdAt: now, userID: userID,
		remember: opts.Remember, deviceKey: opts.DeviceKey, provenAt: now, expiresAt: s.sessionExpiry(now, opts.Remember)}
	s.sessions[key] = sess
	sess.lastSeen, sess.userAgent, sess.ip = now, clientAgent(r), clientIP(r)
	s.persistSession(key, sess)
	if u := s.userByID(userID); u != nil {
		now := time.Now().UTC()
		u.LastLoginAt = &now
		s.persistUser(u)
	}
	s.mu.Unlock()
	cookie := &http.Cookie{
		Name: "bothub_session", Value: sid, Path: "/",
		HttpOnly: true, SameSite: http.SameSiteStrictMode, Secure: r.Header.Get("X-Forwarded-Proto") == "https",
	}
	if opts.Remember {
		cookie.MaxAge = int(rememberFor / time.Second)
	}
	http.SetCookie(w, cookie)
	writeJSON(w, status, s.meFor(userID, csrf))
}

func (s *store) logout(w http.ResponseWriter, r *http.Request, sid string) {
	s.mu.Lock()
	s.dropSession(sid)
	s.mu.Unlock()
	http.SetCookie(w, &http.Cookie{Name: "bothub_session", Value: "", Path: "/", MaxAge: -1, HttpOnly: true, SameSite: http.SameSiteStrictMode})
	w.WriteHeader(204)
}

func (s *store) me(w http.ResponseWriter, r *http.Request, sid string) {
	s.mu.Lock()
	sess := s.sessions[sid]
	s.mu.Unlock()
	writeJSON(w, 200, s.meFor(sess.userID, sess.csrf))
}

func (s *store) meFor(userID int64, csrf string) map[string]any {
	s.mu.Lock()
	defer s.mu.Unlock()
	u := s.userByID(userID)
	if u == nil {
		return map[string]any{"csrfToken": csrf}
	}
	perms := s.permissionsOf(u)
	if perms == nil {
		perms = []string{}
	}
	warnings := []string{}
	if s.envPasswordPlain && slices.Contains(perms, "admin.access") {
		warnings = append(warnings, "env_password_plain")
	}
	if s.needs2FA(u) {
		warnings = append(warnings, "twofa_required")
	}
	if slices.Contains(perms, "admin.access") && s.updateState.behind > 0 && s.srvSettings.AutoUpdate == "check" {
		warnings = append(warnings, "update_available")
	}
	return map[string]any{"id": u.ID, "username": u.Username, "email": u.Email, "twoFactorEnabled": u.totpSecret != "",
		"locale": u.localeOr(s.defaultLocale), "theme": u.themeOr(), "roleId": u.RoleID, "permissions": perms, "warnings": warnings, "csrfToken": csrf}
}

// --- settings ---

func (s *store) settings(w http.ResponseWriter, r *http.Request, sid string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	u := s.sessUser(sid)
	writeJSON(w, 200, map[string]string{"locale": u.localeOr(s.defaultLocale), "theme": u.themeOr()})
}

func (s *store) updateSettings(w http.ResponseWriter, r *http.Request, sid string) {
	var in struct{ Locale, Theme string }
	if !readJSON(w, r, &in) {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	switch in.Theme {
	case "", "system", "light", "dark":
	default:
		apiError(w, 422, "error.settings.invalid")
		return
	}
	u := s.sessUser(sid)
	if in.Locale != "" {
		u.locale = in.Locale
	}
	if in.Theme != "" {
		u.theme = in.Theme
	}
	s.persistUser(u)
	writeJSON(w, 200, map[string]string{"locale": u.localeOr(s.defaultLocale), "theme": u.themeOr()})
}

// --- bots ---

type botHandler func(w http.ResponseWriter, r *http.Request, b *bot)

func (s *store) withBot(next botHandler) authed {
	return func(w http.ResponseWriter, r *http.Request, sid string) {
		id, _ := strconv.ParseInt(r.PathValue("id"), 10, 64)
		s.mu.Lock()
		b := s.bots[id]
		s.mu.Unlock()
		if s.php != nil {
			// Status and name come from the API (the NodeCore writes the status).
			if err := s.syncBots(r.Context()); err != nil {
				pe := asPHPError(err)
				apiError(w, pe.Status, pe.Key)
				return
			}
			s.mu.Lock()
			b = s.bots[id]
			s.mu.Unlock()
		}
		if b == nil {
			apiError(w, 404, "error.bot.not_found")
			return
		}
		// Co-Work: only the owner, members and instance admins; members only with the right.
		s.mu.Lock()
		found, ok := s.allowed(s.sessUser(sid), b, r)
		s.mu.Unlock()
		if !found {
			apiError(w, 404, "error.bot.not_found")
			return
		}
		if !ok {
			apiError(w, 403, "error.access.denied")
			return
		}
		rec := &statusRecorder{ResponseWriter: w, status: 200}
		next(rec, r, b)
		s.recordActivity(r, b, rec.status)
	}
}

func (s *store) listBots(w http.ResponseWriter, r *http.Request, sid string) {
	if s.php != nil {
		if err := s.syncBots(r.Context()); err != nil {
			pe := asPHPError(err)
			apiError(w, pe.Status, pe.Key)
			return
		}
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	me := s.sessUser(sid)
	items := make([]bot, 0, len(s.bots))
	for id := int64(1); id < s.nextID; id++ {
		if b, ok := s.bots[id]; ok {
			// Only the bots the user owns or works on (instance admins: all).
			role, perms, has := s.botAccess(me, b)
			if !has {
				continue
			}
			c := *b
			c.Access, c.Permissions = role, perms
			p := s.profileOf(b.ID)
			c.BannerURL, c.Verified = p.banner, p.verified
			if c.Presence == "" {
				c.Presence = s.presenceOf(b.ID).Status
			}
			// Banner not read yet: from Discord in the background (the next poll shows it).
			if !p.synced && time.Since(p.syncTried) > time.Minute {
				p.syncTried = time.Now()
				go func(b *bot) {
					ctx, cancel := context.WithTimeout(context.Background(), profileLoadTimeout)
					defer cancel()
					_ = s.loadProfile(ctx, b)
				}(b)
			}
			items = append(items, c)
		}
	}
	if me != nil {
		items = orderBots(items, me.uiPrefs.BotOrder)
	}
	writeJSON(w, 200, map[string]any{"items": items})
}

func (s *store) createBot(w http.ResponseWriter, r *http.Request, _ string) {
	var in struct {
		Name      string `json:"name"`
		Token     string `json:"token"`
		Autostart bool   `json:"autostart"`
	}
	if !readJSON(w, r, &in) {
		return
	}
	if strings.TrimSpace(in.Token) == "" {
		apiError(w, 422, "error.field.required")
		return
	}
	// Bot limit of the role (Users & Roles).
	if s.php != nil {
		if err := s.syncBots(r.Context()); err != nil {
			pe := asPHPError(err)
			apiError(w, pe.Status, pe.Key)
			return
		}
	}
	s.mu.Lock()
	allowed := true
	if u := s.sessUserFromRequest(r); u != nil {
		allowed = s.canCreateBot(w, u.ID)
	}
	s.mu.Unlock()
	if !allowed {
		return
	}
	// Discord tells whether the token is valid and whose bot it is.
	id, err := s.discord.checkToken(r.Context(), in.Token)
	if err != nil {
		de := asDiscordError(err)
		apiError(w, de.Status, de.Key)
		return
	}
	token := strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(in.Token), "Bot "))
	if s.php != nil {
		s.createStoredBot(w, r, in.Name, token, in.Autostart, id)
		return
	}
	s.mu.Lock()
	for _, other := range s.bots {
		if other.ApplicationID != nil && *other.ApplicationID == id.Application.ID {
			s.mu.Unlock()
			apiError(w, 409, "error.bot.duplicate")
			return
		}
	}
	name := strings.TrimSpace(in.Name)
	if name == "" {
		name = id.User.Username
		if id.User.GlobalName != nil && *id.User.GlobalName != "" {
			name = *id.User.GlobalName
		}
	}
	appID, avatar := id.Application.ID, avatarURL(id.User)
	b := &bot{ID: s.nextID, Name: name, ApplicationID: &appID, AvatarURL: &avatar, Status: "stopped", TokenSet: true, Autostart: in.Autostart, CreatedAt: time.Now().UTC(), token: token}
	if u := s.sessUserFromRequest(r); u != nil {
		b.OwnerID = u.ID
	}
	s.bots[b.ID] = b
	s.nextID++
	s.seedPresets(b.ID)
	p := s.profileOf(b.ID)
	p.avatar, p.banner, p.bio = &avatar, bannerURL(id.User), id.Application.Description
	if missing := missingIntents(id.Application.Flags); len(missing) > 0 {
		s.addLog(b.ID, time.Now(), "warning", "WAR-2002", "", map[string]any{"intent": strings.Join(missing, ", ")}, nil)
	}
	out := *b
	s.mu.Unlock()
	s.refreshGuildCount(r.Context(), b)
	s.mu.Lock()
	out.GuildCount = b.GuildCount
	s.mu.Unlock()
	writeJSON(w, 201, out)
}

// createStoredBot saves a checked bot in the PHP API (token encrypted there).
func (s *store) createStoredBot(w http.ResponseWriter, r *http.Request, name, token string, autostart bool, id botIdentity) {
	if strings.TrimSpace(name) == "" {
		name = id.User.Username
		if id.User.GlobalName != nil && *id.User.GlobalName != "" {
			name = *id.User.GlobalName
		}
	}
	created, err := s.php.create(r.Context(), map[string]any{
		"name": name, "token": token, "applicationId": id.Application.ID, "avatarUrl": avatarURL(id.User), "autostart": autostart,
	})
	if err != nil {
		pe := asPHPError(err)
		apiError(w, pe.Status, pe.Key)
		return
	}
	b := created
	b.token = token
	s.mu.Lock()
	s.bots[b.ID] = &b
	s.nextID = max(s.nextID, b.ID+1)
	p := s.profileOf(b.ID)
	avatar := avatarURL(id.User)
	p.avatar, p.banner, p.bio = &avatar, bannerURL(id.User), id.Application.Description
	if missing := missingIntents(id.Application.Flags); len(missing) > 0 {
		s.addLog(b.ID, time.Now(), "warning", "WAR-2002", "", map[string]any{"intent": strings.Join(missing, ", ")}, nil)
	}
	out := b
	s.mu.Unlock()
	writeJSON(w, 201, out)
}

// refreshGuildCount asks Discord how many servers the bot is in.
func (s *store) refreshGuildCount(ctx context.Context, b *bot) {
	s.mu.Lock()
	token := b.token
	s.mu.Unlock()
	guilds, err := s.discord.guilds(ctx, token)
	if err != nil {
		return
	}
	s.mu.Lock()
	b.GuildCount = len(guilds)
	s.mu.Unlock()
}

func (s *store) getBot(w http.ResponseWriter, r *http.Request, b *bot) {
	s.mu.Lock()
	out := *b
	out.Access, out.Permissions, _ = s.botAccess(s.sessUserFromRequest(r), b)
	d, known := s.discrims[b.ID]
	s.mu.Unlock()
	// The discriminator is asked once per bot (the bot list from the API does not keep it).
	if !known {
		// An error is kept too (empty): a new token asks again.
		if u, err := s.discord.me(r.Context(), s.botToken(b)); err == nil && u.Discriminator != "0" {
			d = u.Discriminator
		}
		s.mu.Lock()
		if s.discrims == nil {
			s.discrims = map[int64]string{}
		}
		s.discrims[b.ID] = d
		s.mu.Unlock()
	}
	out.Discriminator = d
	writeJSON(w, 200, out)
}

func (s *store) updateBot(w http.ResponseWriter, r *http.Request, b *bot) {
	var in struct {
		Name      *string `json:"name"`
		Token     *string `json:"token"`
		Autostart *bool   `json:"autostart"`
	}
	if !readJSON(w, r, &in) {
		return
	}
	s.mu.Lock()
	if in.Name != nil && *in.Name != "" && *in.Name != b.Name {
		s.addLog(b.ID, time.Now(), "change", "", "log.change.name", nil, &logChange{Field: "name", Old: strp(b.Name), New: strp(*in.Name)})
		b.Name = *in.Name
	}
	if in.Token != nil && *in.Token != "" {
		delete(s.discrims, b.ID) // another bot user: ask Discord again
		// A new token must be valid and belong to the same Discord application.
		s.mu.Unlock()
		id, err := s.discord.checkToken(r.Context(), *in.Token)
		s.mu.Lock()
		if err != nil {
			s.mu.Unlock()
			de := asDiscordError(err)
			apiError(w, de.Status, de.Key)
			return
		}
		if b.ApplicationID != nil && *b.ApplicationID != id.Application.ID {
			s.mu.Unlock()
			apiError(w, 422, "error.bot.token_other_bot")
			return
		}
		s.discord.forget(b.token)
		// Never log token values, only that it changed.
		s.addLog(b.ID, time.Now(), "change", "", "log.change.token", nil, &logChange{Field: "token"})
		b.token, b.TokenSet = strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(*in.Token), "Bot ")), true
	}
	if in.Autostart != nil {
		b.Autostart = *in.Autostart
	}
	out := *b
	s.mu.Unlock()
	if s.php != nil {
		fields := map[string]any{"name": out.Name, "autostart": out.Autostart}
		if in.Token != nil && *in.Token != "" {
			fields["token"] = s.botToken(b)
		}
		saved, err := s.php.update(r.Context(), b.ID, fields)
		if err != nil {
			pe := asPHPError(err)
			apiError(w, pe.Status, pe.Key)
			return
		}
		out = saved
	}
	writeJSON(w, 200, out)
}

func (s *store) deleteBot(w http.ResponseWriter, r *http.Request, b *bot) {
	if s.php != nil {
		if err := s.php.remove(r.Context(), b.ID); err != nil {
			pe := asPHPError(err)
			apiError(w, pe.Status, pe.Key)
			return
		}
	}
	s.mu.Lock()
	delete(s.bots, b.ID)
	s.mu.Unlock()
	w.WriteHeader(204)
}

// storedJob hands start/stop/restart to the NodeCore via the API.
func (s *store) storedJob(w http.ResponseWriter, r *http.Request, b *bot, action string) bool {
	if s.php == nil {
		return false
	}
	job, err := s.php.job(r.Context(), b.ID, action)
	if err != nil {
		pe := asPHPError(err)
		apiError(w, pe.Status, pe.Key)
		return true
	}
	writeJSON(w, 202, job)
	return true
}

func (s *store) startBot(w http.ResponseWriter, r *http.Request, b *bot) {
	s.mu.Lock()
	allowed := s.canRunBot(w, b)
	s.mu.Unlock()
	if !allowed {
		return
	}
	// The gateway login belongs to the NodeCore; here Discord only confirms
	// that the token still works, the status change itself is simulated.
	if _, err := s.discord.me(r.Context(), s.botToken(b)); err != nil {
		if de := asDiscordError(err); de.Key == "error.bot.token_invalid" {
			s.transition(w, b, "bot.start", "starting", "error")
			return
		}
		de := asDiscordError(err)
		apiError(w, de.Status, de.Key)
		return
	}
	if s.storedJob(w, r, b, "start") {
		return
	}
	s.transition(w, b, "bot.start", "starting", "running")
	go s.refreshGuildCount(context.WithoutCancel(r.Context()), b)
}

func (s *store) stopBot(w http.ResponseWriter, r *http.Request, b *bot) {
	if s.storedJob(w, r, b, "stop") {
		return
	}
	s.transition(w, b, "bot.stop", "stopping", "stopped")
}

// transition simulates the NodeCore executing a job: the status changes after a delay.
func (s *store) transition(w http.ResponseWriter, b *bot, jobType, during, after string) {
	s.mu.Lock()
	b.Status, b.StatusErrKey = during, nil
	s.mu.Unlock()
	time.AfterFunc(2*time.Second, func() {
		s.mu.Lock()
		defer s.mu.Unlock()
		b.Status = after
		b.StartedAt = nil
		if after == "running" {
			now := time.Now().UTC()
			b.StartedAt = &now
		}
		switch after {
		case "running":
			s.addLog(b.ID, time.Now(), "update", "", "log.update.bot_started", map[string]any{"name": b.Name}, nil)
		case "stopped":
			s.addLog(b.ID, time.Now(), "update", "", "log.update.bot_stopped", nil, nil)
		case "error":
			s.addLog(b.ID, time.Now(), "error", "ERR-1001", "", nil, nil)
		}
		if after == "error" {
			key := "error.bot.token_invalid"
			b.StatusErrKey = &key
		}
	})
	writeJSON(w, 202, map[string]any{
		"id": randomUUID(), "type": jobType, "status": "queued", "createdAt": time.Now().UTC(),
	})
}

// --- stats ---

// overviewStats counts the bots; memory comes from the sampler (memstats.go).
func (s *store) overviewStats(w http.ResponseWriter, r *http.Request, _ string) {
	q := r.URL.Query()
	rng := q.Get("range")
	to := time.Now().UTC()
	from := to.Add(-24 * time.Hour)
	switch rng {
	case "1h":
		from = to.Add(-time.Hour)
	case "7d":
		from = to.Add(-7 * 24 * time.Hour)
	case "custom":
		f, err1 := time.Parse(time.RFC3339, q.Get("from"))
		t, err2 := time.Parse(time.RFC3339, q.Get("to"))
		if err1 != nil || err2 != nil || !f.Before(t) {
			apiError(w, 422, "error.validation.failed")
			return
		}
		from, to = f, t
	default:
		rng = "24h"
	}
	s.mu.Lock()
	total, online := len(s.bots), 0
	for _, b := range s.bots {
		if b.Status == "running" {
			online++
		}
	}
	s.mu.Unlock()
	writeJSON(w, 200, map[string]any{
		"bots":    map[string]int{"total": total, "online": online},
		"memory":  s.memoryStats(r.Context(), rng, from, to),
		"storage": storageStats(),
	})
}

// --- guilds and modules ---

// botToken reads the token under the lock.
func (s *store) botToken(b *bot) string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return b.token
}

func (s *store) listGuilds(w http.ResponseWriter, r *http.Request, b *bot) {
	list, err := s.discord.guilds(r.Context(), s.botToken(b))
	if err != nil {
		de := asDiscordError(err)
		apiError(w, de.Status, de.Key)
		return
	}
	items := make([]guild, 0, len(list))
	for _, g := range list {
		items = append(items, guild{ID: g.ID, Name: g.Name, IconURL: guildIconURL(g), MemberCount: g.MemberCount})
	}
	s.mu.Lock()
	b.GuildCount = len(items)
	s.mu.Unlock()
	writeJSON(w, 200, map[string]any{"items": items})
}

// guildOf returns the guild from the path when the bot is in it.
func (s *store) guildOf(w http.ResponseWriter, r *http.Request, b *bot) (guild, bool) {
	gid := r.PathValue("guildId")
	list, err := s.discord.guilds(r.Context(), s.botToken(b))
	if err != nil {
		de := asDiscordError(err)
		apiError(w, de.Status, de.Key)
		return guild{}, false
	}
	for _, g := range list {
		if g.ID == gid {
			return guild{ID: g.ID, Name: g.Name, IconURL: guildIconURL(g), MemberCount: g.MemberCount}, true
		}
	}
	apiError(w, 404, "error.guild.not_found")
	return guild{}, false
}

// listGuildRoles returns the guild's roles, highest first, without @everyone.
func (s *store) listGuildRoles(w http.ResponseWriter, r *http.Request, b *bot) {
	g, ok := s.guildOf(w, r, b)
	if !ok {
		return
	}
	roles, err := s.discord.roles(r.Context(), s.botToken(b), g.ID)
	if err != nil {
		de := asDiscordError(err)
		apiError(w, de.Status, de.Key)
		return
	}
	slices.SortFunc(roles, func(x, y discordRole) int { return y.Position - x.Position })
	items := []map[string]any{}
	for _, role := range roles {
		if role.ID == g.ID { // @everyone
			continue
		}
		items = append(items, map[string]any{"id": role.ID, "name": role.Name, "color": roleColor(role.Color), "position": role.Position, "managed": role.Managed})
	}
	writeJSON(w, 200, map[string]any{"items": items})
}

// listGuildChannels returns the guild's channels in display order: channels
// without a category first, then each category followed by its channels.
func (s *store) listGuildChannels(w http.ResponseWriter, r *http.Request, b *bot) {
	g, ok := s.guildOf(w, r, b)
	if !ok {
		return
	}
	chans, err := s.discord.channels(r.Context(), s.botToken(b), g.ID)
	if err != nil {
		de := asDiscordError(err)
		apiError(w, de.Status, de.Key)
		return
	}
	// Categories first in Discord's order, their channels right after them.
	slices.SortFunc(chans, func(x, y discordChannel) int {
		if x.Position != y.Position {
			return x.Position - y.Position
		}
		return strings.Compare(x.ID, y.ID)
	})
	items := []map[string]any{}
	for _, c := range chans {
		typ, known := channelTypes[c.Type]
		if !known {
			continue
		}
		var parent any
		if c.ParentID != nil {
			parent = *c.ParentID
		}
		items = append(items, map[string]any{"id": c.ID, "name": c.Name, "type": typ, "parentId": parent, "position": c.Position})
	}
	writeJSON(w, 200, map[string]any{"items": items})
}

func (s *store) listModules(w http.ResponseWriter, r *http.Request, b *bot) {
	s.mu.Lock()
	defer s.mu.Unlock()
	items := []map[string]any{}
	for key := range s.known {
		items = append(items, map[string]any{"key": key, "enabled": s.modules[moduleID(b.ID, key)]})
	}
	writeJSON(w, 200, map[string]any{"items": items})
}

func (s *store) setModule(w http.ResponseWriter, r *http.Request, b *bot) {
	key := r.PathValue("key")
	var in struct {
		Enabled bool `json:"enabled"`
	}
	if !readJSON(w, r, &in) {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if !s.known[key] {
		apiError(w, 404, "error.module.unknown")
		return
	}
	if s.modules[moduleID(b.ID, key)] != in.Enabled {
		logKey := "log.change.module_disabled"
		if in.Enabled {
			logKey = "log.change.module_enabled"
		}
		s.addLog(b.ID, time.Now(), "change", "", logKey, map[string]any{"module": key}, nil)
	}
	s.modules[moduleID(b.ID, key)] = in.Enabled
	writeJSON(w, 200, map[string]any{"key": key, "enabled": in.Enabled})
}

func (s *store) leaveGuild(w http.ResponseWriter, r *http.Request, b *bot) {
	gid := r.PathValue("guildId")
	if _, ok := s.guildOf(w, r, b); !ok {
		return
	}
	if err := s.discord.leaveGuild(r.Context(), s.botToken(b), gid); err != nil {
		de := asDiscordError(err)
		apiError(w, de.Status, de.Key)
		return
	}
	s.mu.Lock()
	if b.GuildCount > 0 {
		b.GuildCount--
	}
	s.mu.Unlock()
	writeJSON(w, 202, map[string]any{"id": randomUUID(), "type": "guild.leave", "status": "done", "createdAt": time.Now().UTC()})
}

func moduleID(botID int64, key string) string {
	return strconv.FormatInt(botID, 10) + "/" + key
}

// --- helpers ---

// loadEventTypes reads the event keys from shared/events.json.
func loadEventTypes() map[string]bool {
	keys := map[string]bool{}
	raw, err := os.ReadFile(filepath.Join(envOr("SHARED_DIR", "/shared"), "events.json"))
	if err != nil {
		slog.Warn("mockapi: event catalog not found", "err", err)
		return keys
	}
	var catalog struct {
		Categories []struct {
			Events []struct {
				Key string `json:"key"`
			} `json:"events"`
		} `json:"categories"`
	}
	_ = json.Unmarshal(raw, &catalog)
	for _, c := range catalog.Categories {
		for _, e := range c.Events {
			keys[e.Key] = true
		}
	}
	return keys
}

func loadModuleKeys() map[string]bool {
	keys := map[string]bool{}
	raw, err := os.ReadFile(filepath.Join(envOr("SHARED_DIR", "/shared"), "modules.json"))
	if err != nil {
		slog.Warn("mockapi: module catalog not found", "err", err)
		return keys
	}
	var catalog struct {
		Modules []struct {
			Key string `json:"key"`
		} `json:"modules"`
	}
	_ = json.Unmarshal(raw, &catalog)
	for _, m := range catalog.Modules {
		keys[m.Key] = true
	}
	return keys
}

func readJSON(w http.ResponseWriter, r *http.Request, v any) bool {
	if !strings.HasPrefix(r.Header.Get("Content-Type"), "application/json") {
		apiError(w, 422, "error.validation.failed")
		return false
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20)).Decode(v); err != nil {
		apiError(w, 422, "error.validation.failed")
		return false
	}
	return true
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func apiError(w http.ResponseWriter, status int, key string) {
	writeJSON(w, status, map[string]any{"error": map[string]string{"key": key}})
}

func randomHex(n int) string {
	b := make([]byte, n)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

func randomUUID() string {
	h := randomHex(16)
	return h[0:8] + "-" + h[8:12] + "-" + h[12:16] + "-" + h[16:20] + "-" + h[20:32]
}

func envOr(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}
