package api

import (
	"encoding/json"
	"time"
)

// Types mirror the schemas in api/openapi.yaml.

type SetupRequest struct {
	Username string `json:"username"`
	Password string `json:"password"`
	Locale   string `json:"locale,omitempty"`
}

type Me struct {
	Username         string  `json:"username"`
	Email            *string `json:"email"`
	TwoFactorEnabled bool    `json:"twoFactorEnabled"`
	Locale           string  `json:"locale"`
	Theme            string  `json:"theme"`
	CSRFToken        string  `json:"csrfToken"`
}

type Settings struct {
	Locale string `json:"locale,omitempty"`
	Theme  string `json:"theme,omitempty"`
}

// Bot statuses.
const (
	BotStopped  = "stopped"
	BotStarting = "starting"
	BotRunning  = "running"
	BotStopping = "stopping"
	BotError    = "error"
)

type Bot struct {
	ID             int64     `json:"id"`
	Name           string    `json:"name"`
	ApplicationID  *string   `json:"applicationId"`
	AvatarURL      *string   `json:"avatarUrl"`
	Status         string    `json:"status"`
	StatusErrorKey *string   `json:"statusErrorKey"`
	TokenSet       bool      `json:"tokenSet"`
	Autostart      bool      `json:"autostart"`
	GuildCount     int       `json:"guildCount"`
	CreatedAt      time.Time `json:"createdAt"`
	// StartedAt is when the bot went online; nil while it is not running.
	StartedAt *time.Time `json:"startedAt"`
}

// Transitioning reports whether the bot is between two stable states.
func (b Bot) Transitioning() bool {
	return b.Status == BotStarting || b.Status == BotStopping
}

type BotCreate struct {
	Name      string `json:"name,omitempty"`
	Token     string `json:"token"`
	Autostart bool   `json:"autostart"`
}

type BotUpdate struct {
	Name      *string `json:"name,omitempty"`
	Token     *string `json:"token,omitempty"`
	Autostart *bool   `json:"autostart,omitempty"`
}

type Guild struct {
	ID          string  `json:"id"`
	Name        string  `json:"name"`
	IconURL     *string `json:"iconUrl"`
	MemberCount int     `json:"memberCount"`
}

type ModuleState struct {
	Key     string `json:"key"`
	Enabled bool   `json:"enabled"`
}

type OverviewStats struct {
	Bots struct {
		Total  int `json:"total"`
		Online int `json:"online"`
	} `json:"bots"`
	Memory MemoryStats `json:"memory"`
}

type MemoryStats struct {
	Range        string          `json:"range"`
	CurrentBytes int64           `json:"currentBytes"`
	AverageBytes int64           `json:"averageBytes"`
	PeakBytes    int64           `json:"peakBytes"`
	LimitBytes   *int64          `json:"limitBytes"`
	Services     []ServiceMemory `json:"services"`
	Series       []MemorySample  `json:"series"`
}

type ServiceMemory struct {
	Name         string `json:"name"`
	CurrentBytes int64  `json:"currentBytes"`
}

type MemorySample struct {
	T     time.Time `json:"t"`
	Bytes int64     `json:"bytes"`
}

// BotProfile is the Discord profile of a bot. Avatar and banner changes are
// rate-limited by Discord; Limits says how many are left in the window.
type BotProfile struct {
	AvatarURL     *string `json:"avatarUrl"`
	BannerURL     *string `json:"bannerUrl"`
	Pronouns      string  `json:"pronouns"`
	Bio           string  `json:"bio"`
	WindowSeconds int     `json:"windowSeconds"`
	Limits        struct {
		Avatar RateLimit `json:"avatar"`
		Banner RateLimit `json:"banner"`
	} `json:"limits"`
}

type RateLimit struct {
	Remaining int        `json:"remaining"`
	Limit     int        `json:"limit"`
	ResetAt   *time.Time `json:"resetAt"`
}

type ProfileUpdate struct {
	Pronouns *string `json:"pronouns,omitempty"`
	Bio      *string `json:"bio,omitempty"`
}

// Presence statuses and activity types, in display order.
var (
	PresenceStatuses = []string{"online", "idle", "dnd", "invisible"}
	ActivityTypes    = []string{"none", "playing", "watching", "listening", "competing", "streaming"}
)

type Activity struct {
	Type string `json:"type"`
	Name string `json:"name"`
	URL  string `json:"url,omitempty"`
}

type Presence struct {
	Status       string   `json:"status"`
	Activity     Activity `json:"activity"`
	CustomStatus string   `json:"customStatus"`
	Show         string   `json:"show"` // activity, custom: what Discord shows
	Rotation     Rotation `json:"rotation"`
}

type Rotation struct {
	Enabled         bool       `json:"enabled"`
	IntervalSeconds int        `json:"intervalSeconds"`
	Entries         []Activity `json:"entries"`
}

// PresenceUpdate changes only the fields that are set.
type PresenceUpdate struct {
	Status       *string   `json:"status,omitempty"`
	Activity     *Activity `json:"activity,omitempty"`
	CustomStatus *string   `json:"customStatus,omitempty"`
	Show         *string   `json:"show,omitempty"`
	Rotation     *Rotation `json:"rotation,omitempty"`
}

// InstalledPlugin is a plugin installed for one bot.
type InstalledPlugin struct {
	ID                 string   `json:"id"`
	Name               string   `json:"name"`
	Description        string   `json:"description"`
	Icon               string   `json:"icon"`
	Version            string   `json:"version"`
	Enabled            bool     `json:"enabled"`
	Beta               bool     `json:"beta"`
	GrantedPermissions []string `json:"grantedPermissions"`
	// InstanceEnabled: the admin's switch for every bot; BlockedBy: SDK
	// permissions that are off (the plugin does not run while one is listed).
	InstanceEnabled bool     `json:"instanceEnabled"`
	BlockedBy       []string `json:"blockedBy"`
	// Manifest is the plugin's bothub-plugin.json (settings schema, blocks …).
	Manifest json.RawMessage `json:"manifest,omitempty"`
	// Lang holds the plugin's texts per locale, keys "plugin.<id>.*".
	Lang map[string]map[string]string `json:"lang,omitempty"`
	// Webhooks: inbound URLs of the plugin for this bot (bothub.json services.webhooks).
	Webhooks []PluginWebhook `json:"webhooks,omitempty"`
}

// PluginWebhook is one inbound webhook; Path is relative to the dashboard (/api/hooks/plugin/…).
type PluginWebhook struct {
	Name string `json:"name"`
	Path string `json:"path"`
}

// ServerSettings are instance-wide settings (admin only). Port changes apply
// after a restart; RestartRequired says a saved value is not active yet.
type ServerSettings struct {
	Domain          string `json:"domain"`
	PublicPort      int    `json:"publicPort"`
	APIPort         int    `json:"apiPort"`
	RedisPort       int    `json:"redisPort"`
	BehindProxy     bool   `json:"behindProxy"`
	SessionHours    int    `json:"sessionHours"`
	MaxUploadMB     int    `json:"maxUploadMb"`
	RestartRequired bool   `json:"restartRequired"`
}

// SMTP security modes, in display order.
var SMTPSecurityModes = []string{"starttls", "tls", "none"}

// SMTPSettings configure outgoing mail (admin only). The password is
// write-only: the API reports PasswordSet but never returns it.
type SMTPSettings struct {
	Enabled     bool   `json:"enabled"`
	Host        string `json:"host"`
	Port        int    `json:"port"`
	Security    string `json:"security"`
	Username    string `json:"username"`
	PasswordSet bool   `json:"passwordSet"`
	FromAddress string `json:"fromAddress"`
	FromName    string `json:"fromName"`
}

// SMTPUpdate changes the mail settings. A nil Password keeps the stored one.
type SMTPUpdate struct {
	Enabled     bool    `json:"enabled"`
	Host        string  `json:"host"`
	Port        int     `json:"port"`
	Security    string  `json:"security"`
	Username    string  `json:"username"`
	Password    *string `json:"password,omitempty"`
	FromAddress string  `json:"fromAddress"`
	FromName    string  `json:"fromName"`
}

// TwoFactorSetup is a pending TOTP secret; it becomes active after EnableTwoFactor.
type TwoFactorSetup struct {
	Secret     string `json:"secret"`
	OtpauthURI string `json:"otpauthUri"`
}

// Process is one entry of the resource overview: plugin_manager, api,
// discord_api (external: latency instead of CPU/memory), redis, botcore.
type Process struct {
	Key           string  `json:"key"`
	Kind          string  `json:"kind"`      // service or external
	LatencyMs     float64 `json:"latencyMs"` // external: ping, database: response time of a read
	Plugins       int     `json:"plugins"`   // plugin_manager: running plugin processes
	PID           int     `json:"pid"`
	Status        string  `json:"status"` // running, crashed, stopped
	CPUPercent    float64 `json:"cpuPercent"`
	MemoryBytes   int64   `json:"memoryBytes"`
	UptimeSeconds int64   `json:"uptimeSeconds"`
	Restarts24h   int     `json:"restarts24h"`
	StorageBytes  int64   `json:"storageBytes"`  // database: file size with WAL
	DiskFreeBytes int64   `json:"diskFreeBytes"` // database: free space of the data disk
	Bots          int     `json:"bots"`          // botcore: bots online
}

// Permissions a role can grant, in display order.
var Permissions = []string{
	"admin.access", "users.manage", "bots.create", "bots.manage", "bots.view",
	"modules.manage", "plugins.manage", "logs.view",
}

// Role groups permissions. The native roles (admin, user, banned, guest) are
// Builtin: they cannot be deleted, and admin always has every permission.
type Role struct {
	ID          int64    `json:"id"`
	Key         string   `json:"key"` // builtin key; empty for custom roles
	Name        string   `json:"name"`
	Builtin     bool     `json:"builtin"`
	Permissions []string `json:"permissions"`
	UserCount   int      `json:"userCount"`
}

type RoleWrite struct {
	Name        string   `json:"name"`
	Permissions []string `json:"permissions"`
}

type User struct {
	ID               int64      `json:"id"`
	Username         string     `json:"username"`
	Email            *string    `json:"email"`
	RoleID           int64      `json:"roleId"`
	TwoFactorEnabled bool       `json:"twoFactorEnabled"`
	Self             bool       `json:"self"`
	CreatedAt        time.Time  `json:"createdAt"`
	LastLoginAt      *time.Time `json:"lastLoginAt"`
}

type UserCreate struct {
	Username string `json:"username"`
	Email    string `json:"email,omitempty"`
	Password string `json:"password"`
	RoleID   int64  `json:"roleId"`
}

// Passkey is a registered WebAuthn credential of the current user.
type Passkey struct {
	ID         string     `json:"id"`
	Name       string     `json:"name"`
	CreatedAt  time.Time  `json:"createdAt"`
	LastUsedAt *time.Time `json:"lastUsedAt"`
}

// CustomCommand is a command built in the command builder. Graph follows
// shared/graph.schema.json.
type CustomCommand struct {
	ID          int64           `json:"id"`
	Name        string          `json:"name"`
	Description string          `json:"description"`
	Enabled     bool            `json:"enabled"`
	Builtin     bool            `json:"builtin"`
	Hidden      bool            `json:"hidden"`   // module/plugin copy the user has not edited yet
	Preset      *string         `json:"preset"`   // module copy: delete resets it to this preset
	Copy        bool            `json:"copy"`     // module or plugin copy: stays in its system group
	PluginID    *string         `json:"pluginId"` // plugin copy: listed on the plugin's page
	GroupID     *int64          `json:"groupId"`
	EventType   string          `json:"eventType,omitempty"` // custom events only
	UpdatedAt   time.Time       `json:"updatedAt"`
	Graph       json.RawMessage `json:"graph,omitempty"`
}

// CommandGroup is a folder on the custom commands page.
type CommandGroup struct {
	ID          int64  `json:"id"`
	Name        string `json:"name"`
	Description string `json:"description"`
	Position    int    `json:"position"`
	Commands    int    `json:"commands"`
	// System: module or plugin group. Not listed in the group dialog or the
	// move menu; the API refuses to change or delete it.
	System bool `json:"system"`
}

// UserGroups drops the system groups (module and plugin copies).
func UserGroups(groups []CommandGroup) []CommandGroup {
	out := make([]CommandGroup, 0, len(groups))
	for _, g := range groups {
		if !g.System {
			out = append(out, g)
		}
	}
	return out
}

// DeletedCommand is a custom command deleted in the last 30 days.
type DeletedCommand struct {
	ID          int64     `json:"id"`
	Name        string    `json:"name"`
	Description string    `json:"description"`
	DeletedAt   time.Time `json:"deletedAt"`
}

// CommandVersion is one saved graph of a command (without the graph).
type CommandVersion struct {
	ID      int64     `json:"id"`
	SavedAt time.Time `json:"savedAt"`
	Nodes   int       `json:"nodes"`
}

// Log levels, in filter order.
var LogLevels = []string{"error", "warning", "change", "update"}

type LogEntry struct {
	ID     int64          `json:"id"`
	Time   time.Time      `json:"time"`
	Level  string         `json:"level"`
	Code   *string        `json:"code"`
	Key    string         `json:"key"`
	Params map[string]any `json:"params"`
	Change *LogChange     `json:"change"`
	Source string         `json:"source,omitempty"` // server logs only
	Actor  string         `json:"actor,omitempty"`  // server logs only
}

type LogChange struct {
	Field string  `json:"field"`
	Old   *string `json:"old"`
	New   *string `json:"new"`
}

// Bot metric keys, in display order.
var BotMetrics = []string{"newMembers", "activeUsers", "messages", "voiceMinutes", "moderation", "commands", "pluginUsages"}

type BotStats struct {
	Range    string                   `json:"range"`
	Totals   map[string]int64         `json:"totals"`
	Previous map[string]int64         `json:"previous"`
	Series   map[string][]MetricPoint `json:"series"`
	Top      struct {
		Commands   []TopEntry `json:"commands"`
		Plugins    []TopEntry `json:"plugins"`
		ModActions []TopEntry `json:"modActions"`
	} `json:"top"`
}

type MetricPoint struct {
	T time.Time `json:"t"`
	V int64     `json:"v"`
}

type TopEntry struct {
	Name  string `json:"name"`
	Count int64  `json:"count"`
}

type Job struct {
	ID         string     `json:"id"`
	Type       string     `json:"type"`
	Status     string     `json:"status"`
	ErrorKey   *string    `json:"errorKey"`
	CreatedAt  time.Time  `json:"createdAt"`
	FinishedAt *time.Time `json:"finishedAt"`
}

// TimedEvent is a schedule that starts custom events of type "timed".
// Kind "interval" runs every IntervalSeconds, "schedule" at each of Times
// ("HH:MM:SS"). Weekdays (0 = Sunday) limit both; empty = every day.
type TimedEvent struct {
	ID              int64    `json:"id,omitempty"`
	Name            string   `json:"name"`
	Kind            string   `json:"kind"`
	IntervalSeconds *int     `json:"intervalSeconds"`
	Times           []string `json:"times"`
	Weekdays        []int    `json:"weekdays"`
	Enabled         bool     `json:"enabled"`
	LastRunAt       *string  `json:"lastRunAt,omitempty"`
}

// TimedSettings are the bot's time zone (IANA name, "" = server time) and
// the server behind {DEFAULT_SERVER}.
// GuildRef is a role or channel of one guild.
type GuildRef struct {
	ID    string `json:"id"`
	Guild string `json:"guild"`
}

type GuildRole struct {
	ID      string `json:"id"`
	Name    string `json:"name"`
	Managed bool   `json:"managed"`
}

type GuildChannel struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	Type string `json:"type"`
}

// AutoPunishment fires when a member reaches Count warnings or timeouts.
type AutoPunishment struct {
	Trigger  string `json:"trigger"` // warnings, timeouts
	Count    int    `json:"count"`
	Action   string `json:"action"` // timeout, kick, ban
	Duration string `json:"duration"`
}

// ModerationConfig is the settings page of the moderation module.
// PermissionsBlock is the shared permissions block (allowed and banned roles,
// required Discord permissions, banned channels) of commands and modules.
type PermissionsBlock struct {
	AllowedRoles        []GuildRef `json:"allowed_roles"`
	BannedRoles         []GuildRef `json:"banned_roles"`
	RequiredPermissions []string   `json:"required_permissions"`
	BannedChannels      []GuildRef `json:"banned_channels"`
}

type ModerationConfig struct {
	Moderators        PermissionsBlock `json:"moderators"`
	Admins            PermissionsBlock `json:"admins"`
	LogEnabled        bool             `json:"logEnabled"`
	LogChannels       []GuildRef       `json:"logChannels"`
	PunishmentColor   string           `json:"punishmentColor"`
	LogColor          string           `json:"logColor"`
	DMEnabled         bool             `json:"dmEnabled"`
	DMMode            string           `json:"dmMode"`
	DMMessage         string           `json:"dmMessage"`
	BanDeleteMessages string           `json:"banDeleteMessages"`
	AutoPunishments   []AutoPunishment `json:"autoPunishments"`
}

type TimedSettings struct {
	Timezone        string  `json:"timezone"`
	DefaultServerID *string `json:"defaultServerId"`
}

// Webhook lets an external service start the bot's custom events of type
// "webhook" (POST to URL). EventID is the random part of the URL.
type Webhook struct {
	ID           int64      `json:"id"`
	EventID      string     `json:"eventId"`
	Name         string     `json:"name"`
	RequireKey   bool       `json:"requireKey"`
	Enabled      bool       `json:"enabled"`
	URL          string     `json:"url"` // path; the dashboard adds the host
	Calls        int        `json:"calls"`
	LastCalledAt *time.Time `json:"lastCalledAt"`
	CreatedAt    time.Time  `json:"createdAt"`
}

// WebhookList is the module page data: webhooks and the state of the API key.
// The key itself is never returned here, only its last characters.
type WebhookList struct {
	Items  []Webhook `json:"items"`
	APIKey struct {
		Set       bool       `json:"set"`
		Hint      *string    `json:"hint"`
		CreatedAt *time.Time `json:"createdAt"`
	} `json:"apiKey"`
}

type WebhookCreate struct {
	EventID    string `json:"eventId"`
	Name       string `json:"name"`
	RequireKey bool   `json:"requireKey"`
}

type WebhookUpdate struct {
	Name       *string `json:"name,omitempty"`
	RequireKey *bool   `json:"requireKey,omitempty"`
	Enabled    *bool   `json:"enabled,omitempty"`
}

// AdminPlugin is a plugin installed on the instance (Admin → Plugin Manager).
// MarketPlugin is one plugin folder of the market repo (Template left out).
// Published is the version listed in index.json (installable), nil when the
// plugin has no release yet; Installed is the version on this instance.
type MarketPlugin struct {
	ID          string   `json:"id"`
	Name        string   `json:"name"`
	Description string   `json:"description"`
	Developer   string   `json:"developer"`
	Version     string   `json:"version"`
	Permissions []string `json:"permissions"`
	Published   *string  `json:"published"`
	Installed   *string  `json:"installed"`
	// App Store: emoji, category (module group key), license and the
	// endpoints the plugin asks for. Layers and Size come from the release
	// in index.json (nil/0 without a release).
	Icon     string        `json:"icon"`
	Category string        `json:"category"`
	License  string        `json:"license"`
	Secrets  []string      `json:"secrets"`
	Layers   *MarketLayers `json:"layers"`
	Size     int64         `json:"size"`
}

// MarketLayers counts the parts of a released plugin.
type MarketLayers struct {
	Commands  int `json:"commands"`
	Events    int `json:"events"`
	Services  int `json:"services"`
	Nodes     int `json:"nodes"`
	Dashboard int `json:"dashboard"`
}

type AdminPlugin struct {
	ID          string                       `json:"id"`
	Version     string                       `json:"version"`
	SHA256      string                       `json:"sha256"`
	Enabled     bool                         `json:"enabled"`
	InstalledAt time.Time                    `json:"installedAt"`
	Manifest    json.RawMessage              `json:"manifest"`
	Lang        map[string]map[string]string `json:"lang"`
	// BlockedBy: declared SDK permissions the SDK policies switch off; the
	// bot does not start the plugin while one is listed.
	BlockedBy []string `json:"blockedBy"`
	// SecretShares: every name of manifest.secrets, whether a secret with
	// that name exists and whether it is shared with the plugin.
	SecretShares map[string]SecretShare `json:"secretShares"`
}

type SecretShare struct {
	Exists bool `json:"exists"`
	// Set: it has a value (false: an empty placeholder).
	Set    bool `json:"set"`
	Shared bool `json:"shared"`
}

// PluginInstall is the API's answer to an install: the command copies it
// created per bot and the ones whose plugin version changed.
type PluginInstall struct {
	ID       string `json:"id"`
	Version  string `json:"version"`
	Commands struct {
		Created int `json:"created"`
	} `json:"commands"`
}
