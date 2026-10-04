// Package api is the dashboard's client for the BotHub API (see api/openapi.yaml).
//
// The dashboard never checks permissions itself. It forwards the browser's
// session cookie and CSRF token, and the API decides.
package api

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// SessionCookie is the name of the API's session cookie.
const SessionCookie = "bothub_session"

// Error is an error response from the API. Key is an i18n key.
type Error struct {
	Status int               `json:"-"`
	Key    string            `json:"key"`
	Params map[string]any    `json:"params,omitempty"`
	Fields map[string]string `json:"fields,omitempty"`
}

func (e *Error) Error() string { return fmt.Sprintf("api: %d %s", e.Status, e.Key) }

// AsError returns the API error inside err, or a generic one for
// transport failures, so callers always have an i18n key to show.
func AsError(err error) *Error {
	var apiErr *Error
	if errors.As(err, &apiErr) {
		return apiErr
	}
	return &Error{Status: http.StatusBadGateway, Key: "error.api.unreachable"}
}

// IsStatus reports whether err is an API error with the given HTTP status.
func IsStatus(err error, status int) bool {
	var apiErr *Error
	return errors.As(err, &apiErr) && apiErr.Status == status
}

// Session carries the browser's credentials to the API.
type Session struct {
	Cookie string // value of the bothub_session cookie
	CSRF   string // X-CSRF-Token sent by the browser
}

type clientKey struct{}

type clientInfo struct{ agent, ip string }

// WithClient remembers the browser's User-Agent and IP for the API calls of
// this request (sessions list and security history show them).
func WithClient(ctx context.Context, agent, ip string) context.Context {
	return context.WithValue(ctx, clientKey{}, clientInfo{agent: agent, ip: ip})
}

// Client talks to the API.
type Client struct {
	base *url.URL
	http *http.Client
}

// New creates a client for the API at baseURL.
func New(baseURL string) (*Client, error) {
	u, err := url.Parse(strings.TrimRight(baseURL, "/"))
	if err != nil {
		return nil, fmt.Errorf("parse API_URL: %w", err)
	}
	return &Client{base: u, http: &http.Client{Timeout: 10 * time.Second}}, nil
}

// BaseURL returns the API address, used by the /api reverse proxy.
func (c *Client) BaseURL() *url.URL { return c.base }

// Response is what a call returns besides the decoded body. SetCookies must be
// relayed to the browser after setup, login and logout.
type Response struct {
	SetCookies []string
}

func (c *Client) do(ctx context.Context, s Session, method, path string, in, out any) (Response, error) {
	if in == nil {
		return c.doRaw(ctx, s, method, path, "", nil, out)
	}
	b, err := json.Marshal(in)
	if err != nil {
		return Response{}, err
	}
	return c.doRaw(ctx, s, method, path, "application/json", bytes.NewReader(b), out)
}

// doRaw sends body with the given content type and decodes a JSON answer into out.
func (c *Client) doRaw(ctx context.Context, s Session, method, path, contentType string, body io.Reader, out any) (Response, error) {
	req, err := http.NewRequestWithContext(ctx, method, c.base.String()+path, body)
	if err != nil {
		return Response{}, err
	}
	req.Header.Set("Accept", "application/json")
	if contentType != "" {
		req.Header.Set("Content-Type", contentType)
	}
	if s.Cookie != "" {
		req.AddCookie(&http.Cookie{Name: SessionCookie, Value: s.Cookie})
	}
	if s.CSRF != "" {
		req.Header.Set("X-CSRF-Token", s.CSRF)
	}
	if c, ok := ctx.Value(clientKey{}).(clientInfo); ok {
		req.Header.Set("X-BotHub-Client-Agent", c.agent)
		req.Header.Set("X-BotHub-Client-IP", c.ip)
	}

	resp, err := c.http.Do(req)
	if err != nil {
		return Response{}, fmt.Errorf("%s %s: %w", method, path, err)
	}
	defer resp.Body.Close()

	result := Response{SetCookies: resp.Header.Values("Set-Cookie")}

	if resp.StatusCode >= 400 {
		var env struct {
			Error Error `json:"error"`
		}
		if err := json.NewDecoder(resp.Body).Decode(&env); err != nil || env.Error.Key == "" {
			env.Error.Key = "error.api.unexpected"
		}
		env.Error.Status = resp.StatusCode
		return result, &env.Error
	}

	if out != nil && resp.StatusCode != http.StatusNoContent {
		if err := json.NewDecoder(resp.Body).Decode(out); err != nil {
			return result, fmt.Errorf("%s %s: decode: %w", method, path, err)
		}
	}
	return result, nil
}

type list[T any] struct {
	Items []T `json:"items"`
}

// --- setup and auth ---

func (c *Client) SetupRequired(ctx context.Context) (bool, error) {
	var out struct {
		Required bool `json:"required"`
	}
	_, err := c.do(ctx, Session{}, http.MethodGet, "/api/v1/setup", nil, &out)
	return out.Required, err
}

func (c *Client) Setup(ctx context.Context, in SetupRequest) (Me, Response, error) {
	var me Me
	resp, err := c.do(ctx, Session{}, http.MethodPost, "/api/v1/setup", in, &me)
	return me, resp, err
}

// LoginOptions: "stay signed in" and the browser's device key (public key,
// SPKI base64url; empty when the browser has none).
type LoginOptions struct {
	Remember  bool   `json:"remember"`
	DeviceKey string `json:"deviceKey,omitempty"`
}

func (c *Client) Login(ctx context.Context, username, password string, opts LoginOptions) (Me, Response, error) {
	var me Me
	in := map[string]any{"username": username, "password": password, "remember": opts.Remember, "deviceKey": opts.DeviceKey}
	resp, err := c.do(ctx, Session{}, http.MethodPost, "/api/v1/auth/login", in, &me)
	return me, resp, err
}

func (c *Client) Logout(ctx context.Context, s Session) (Response, error) {
	return c.do(ctx, s, http.MethodPost, "/api/v1/auth/logout", nil, nil)
}

func (c *Client) Me(ctx context.Context, s Session) (Me, error) {
	var me Me
	_, err := c.do(ctx, s, http.MethodGet, "/api/v1/auth/me", nil, &me)
	return me, err
}

// --- settings ---

func (c *Client) Settings(ctx context.Context, s Session) (Settings, error) {
	var out Settings
	_, err := c.do(ctx, s, http.MethodGet, "/api/v1/settings", nil, &out)
	return out, err
}

func (c *Client) UpdateSettings(ctx context.Context, s Session, in Settings) (Settings, error) {
	var out Settings
	_, err := c.do(ctx, s, http.MethodPatch, "/api/v1/settings", in, &out)
	return out, err
}

// --- bots ---

func (c *Client) ListBots(ctx context.Context, s Session) ([]Bot, error) {
	var out list[Bot]
	_, err := c.do(ctx, s, http.MethodGet, "/api/v1/bots", nil, &out)
	return out.Items, err
}

func (c *Client) CreateBot(ctx context.Context, s Session, in BotCreate) (Bot, error) {
	var out Bot
	_, err := c.do(ctx, s, http.MethodPost, "/api/v1/bots", in, &out)
	return out, err
}

func (c *Client) GetBot(ctx context.Context, s Session, id int64) (Bot, error) {
	var out Bot
	_, err := c.do(ctx, s, http.MethodGet, fmt.Sprintf("/api/v1/bots/%d", id), nil, &out)
	return out, err
}

func (c *Client) UpdateBot(ctx context.Context, s Session, id int64, in BotUpdate) (Bot, error) {
	var out Bot
	_, err := c.do(ctx, s, http.MethodPatch, fmt.Sprintf("/api/v1/bots/%d", id), in, &out)
	return out, err
}

func (c *Client) DeleteBot(ctx context.Context, s Session, id int64) error {
	_, err := c.do(ctx, s, http.MethodDelete, fmt.Sprintf("/api/v1/bots/%d", id), nil, nil)
	return err
}

func (c *Client) StartBot(ctx context.Context, s Session, id int64) (Job, error) {
	var out Job
	_, err := c.do(ctx, s, http.MethodPost, fmt.Sprintf("/api/v1/bots/%d/start", id), nil, &out)
	return out, err
}

func (c *Client) StopBot(ctx context.Context, s Session, id int64) (Job, error) {
	var out Job
	_, err := c.do(ctx, s, http.MethodPost, fmt.Sprintf("/api/v1/bots/%d/stop", id), nil, &out)
	return out, err
}

// --- stats ---

func (c *Client) OverviewStats(ctx context.Context, s Session, rng string) (OverviewStats, error) {
	var out OverviewStats
	_, err := c.do(ctx, s, http.MethodGet, "/api/v1/stats/overview?range="+url.QueryEscape(rng), nil, &out)
	return out, err
}

// OverviewStatsBetween returns the stats for a custom time range.
func (c *Client) OverviewStatsBetween(ctx context.Context, s Session, from, to time.Time) (OverviewStats, error) {
	var out OverviewStats
	q := url.Values{"range": {"custom"}, "from": {from.UTC().Format(time.RFC3339)}, "to": {to.UTC().Format(time.RFC3339)}}
	_, err := c.do(ctx, s, http.MethodGet, "/api/v1/stats/overview?"+q.Encode(), nil, &out)
	return out, err
}

func (c *Client) RestartBot(ctx context.Context, s Session, id int64) (Job, error) {
	var out Job
	_, err := c.do(ctx, s, http.MethodPost, fmt.Sprintf("/api/v1/bots/%d/restart", id), nil, &out)
	return out, err
}

// --- profile and presence ---

func (c *Client) Profile(ctx context.Context, s Session, botID int64) (BotProfile, error) {
	var out BotProfile
	_, err := c.do(ctx, s, http.MethodGet, fmt.Sprintf("/api/v1/bots/%d/profile", botID), nil, &out)
	return out, err
}

func (c *Client) UpdateProfile(ctx context.Context, s Session, botID int64, in ProfileUpdate) (BotProfile, error) {
	var out BotProfile
	_, err := c.do(ctx, s, http.MethodPatch, fmt.Sprintf("/api/v1/bots/%d/profile", botID), in, &out)
	return out, err
}

func (c *Client) SyncProfile(ctx context.Context, s Session, botID int64) (BotProfile, error) {
	var out BotProfile
	_, err := c.do(ctx, s, http.MethodPost, fmt.Sprintf("/api/v1/bots/%d/profile/sync", botID), nil, &out)
	return out, err
}

// UploadProfileImage sends an avatar or banner image (kind "avatar" or "banner").
func (c *Client) UploadProfileImage(ctx context.Context, s Session, botID int64, kind, filename string, file io.Reader) (BotProfile, error) {
	var buf bytes.Buffer
	mw := multipart.NewWriter(&buf)
	part, err := mw.CreateFormFile("file", filename)
	if err != nil {
		return BotProfile{}, err
	}
	if _, err := io.Copy(part, file); err != nil {
		return BotProfile{}, err
	}
	if err := mw.Close(); err != nil {
		return BotProfile{}, err
	}
	var out BotProfile
	path := fmt.Sprintf("/api/v1/bots/%d/profile/%s", botID, url.PathEscape(kind))
	_, err = c.doRaw(ctx, s, http.MethodPut, path, mw.FormDataContentType(), &buf, &out)
	return out, err
}

func (c *Client) Presence(ctx context.Context, s Session, botID int64) (Presence, error) {
	var out Presence
	_, err := c.do(ctx, s, http.MethodGet, fmt.Sprintf("/api/v1/bots/%d/presence", botID), nil, &out)
	return out, err
}

func (c *Client) UpdatePresence(ctx context.Context, s Session, botID int64, in PresenceUpdate) (Presence, error) {
	var out Presence
	_, err := c.do(ctx, s, http.MethodPatch, fmt.Sprintf("/api/v1/bots/%d/presence", botID), in, &out)
	return out, err
}

// BotStatsBetween returns the stats of a bot for a custom time range.
func (c *Client) BotStatsBetween(ctx context.Context, s Session, botID int64, from, to time.Time, guild string) (BotStats, error) {
	var out BotStats
	q := url.Values{"range": {"custom"}, "from": {from.UTC().Format(time.RFC3339)}, "to": {to.UTC().Format(time.RFC3339)}}
	if guild != "" {
		q.Set("guild", guild)
	}
	_, err := c.do(ctx, s, http.MethodGet, fmt.Sprintf("/api/v1/bots/%d/stats?%s", botID, q.Encode()), nil, &out)
	return out, err
}

// BotStats: the overview numbers of a range; guild "" is every server.
func (c *Client) BotStats(ctx context.Context, s Session, botID int64, rng, guild string) (BotStats, error) {
	var out BotStats
	path := fmt.Sprintf("/api/v1/bots/%d/stats?range=%s", botID, url.QueryEscape(rng))
	if guild != "" {
		path += "&guild=" + url.QueryEscape(guild)
	}
	_, err := c.do(ctx, s, http.MethodGet, path, nil, &out)
	return out, err
}

// --- account security ---

// LoginTOTP finishes a login that needs a 2FA code. ticket comes from the
// params of the error.auth.totp_required answer to Login.
func (c *Client) LoginTOTP(ctx context.Context, ticket, code string) (Me, Response, error) {
	var me Me
	in := map[string]string{"ticket": ticket, "code": code}
	resp, err := c.do(ctx, Session{}, http.MethodPost, "/api/v1/auth/login/totp", in, &me)
	return me, resp, err
}

func (c *Client) ChangePassword(ctx context.Context, s Session, current, next string) error {
	in := map[string]string{"currentPassword": current, "newPassword": next}
	_, err := c.do(ctx, s, http.MethodPost, "/api/v1/auth/password", in, nil)
	return err
}

func (c *Client) ChangeEmail(ctx context.Context, s Session, email, currentPassword string) (Me, error) {
	var me Me
	in := map[string]string{"email": email, "currentPassword": currentPassword}
	_, err := c.do(ctx, s, http.MethodPut, "/api/v1/auth/email", in, &me)
	return me, err
}

func (c *Client) SetupTwoFactor(ctx context.Context, s Session) (TwoFactorSetup, error) {
	var out TwoFactorSetup
	_, err := c.do(ctx, s, http.MethodPost, "/api/v1/auth/2fa/setup", nil, &out)
	return out, err
}

// EnableTwoFactor activates the pending secret and returns one-time recovery codes.
func (c *Client) EnableTwoFactor(ctx context.Context, s Session, code string) ([]string, error) {
	var out struct {
		RecoveryCodes []string `json:"recoveryCodes"`
	}
	_, err := c.do(ctx, s, http.MethodPost, "/api/v1/auth/2fa/enable", map[string]string{"code": code}, &out)
	return out.RecoveryCodes, err
}

func (c *Client) DisableTwoFactor(ctx context.Context, s Session, currentPassword, code string) error {
	in := map[string]string{"currentPassword": currentPassword, "code": code}
	_, err := c.do(ctx, s, http.MethodPost, "/api/v1/auth/2fa/disable", in, nil)
	return err
}

// --- passkeys ---
// Registration and login run in the browser against /api/v1/auth/passkeys/*
// (through the /api proxy); the dashboard only lists and deletes.

func (c *Client) Passkeys(ctx context.Context, s Session) ([]Passkey, error) {
	var out list[Passkey]
	_, err := c.do(ctx, s, http.MethodGet, "/api/v1/auth/passkeys", nil, &out)
	return out.Items, err
}

func (c *Client) DeletePasskey(ctx context.Context, s Session, id string) error {
	_, err := c.do(ctx, s, http.MethodDelete, "/api/v1/auth/passkeys/"+url.PathEscape(id), nil, nil)
	return err
}

// --- email (SMTP) ---

func (c *Client) SMTPSettings(ctx context.Context, s Session) (SMTPSettings, error) {
	var out SMTPSettings
	_, err := c.do(ctx, s, http.MethodGet, "/api/v1/admin/email", nil, &out)
	return out, err
}

func (c *Client) UpdateSMTPSettings(ctx context.Context, s Session, in SMTPUpdate) (SMTPSettings, error) {
	var out SMTPSettings
	_, err := c.do(ctx, s, http.MethodPut, "/api/v1/admin/email", in, &out)
	return out, err
}

func (c *Client) SendTestEmail(ctx context.Context, s Session, to string) error {
	_, err := c.do(ctx, s, http.MethodPost, "/api/v1/admin/email/test", map[string]string{"to": to}, nil)
	return err
}

// --- users and roles ---

func (c *Client) Roles(ctx context.Context, s Session) ([]Role, error) {
	var out list[Role]
	_, err := c.do(ctx, s, http.MethodGet, "/api/v1/admin/roles", nil, &out)
	return out.Items, err
}

func (c *Client) CreateRole(ctx context.Context, s Session, in RoleWrite) (Role, error) {
	var out Role
	_, err := c.do(ctx, s, http.MethodPost, "/api/v1/admin/roles", in, &out)
	return out, err
}

func (c *Client) UpdateRole(ctx context.Context, s Session, id int64, in RoleWrite) (Role, error) {
	var out Role
	_, err := c.do(ctx, s, http.MethodPut, fmt.Sprintf("/api/v1/admin/roles/%d", id), in, &out)
	return out, err
}

func (c *Client) DeleteRole(ctx context.Context, s Session, id int64) error {
	_, err := c.do(ctx, s, http.MethodDelete, fmt.Sprintf("/api/v1/admin/roles/%d", id), nil, nil)
	return err
}

func (c *Client) Users(ctx context.Context, s Session) ([]User, error) {
	var out list[User]
	_, err := c.do(ctx, s, http.MethodGet, "/api/v1/admin/users", nil, &out)
	return out.Items, err
}

func (c *Client) CreateUser(ctx context.Context, s Session, in UserCreate) (User, error) {
	var out User
	_, err := c.do(ctx, s, http.MethodPost, "/api/v1/admin/users", in, &out)
	return out, err
}

func (c *Client) SetUserRole(ctx context.Context, s Session, id, roleID int64) (User, error) {
	var out User
	_, err := c.do(ctx, s, http.MethodPatch, fmt.Sprintf("/api/v1/admin/users/%d", id), map[string]int64{"roleId": roleID}, &out)
	return out, err
}

func (c *Client) DeleteUser(ctx context.Context, s Session, id int64) error {
	_, err := c.do(ctx, s, http.MethodDelete, fmt.Sprintf("/api/v1/admin/users/%d", id), nil, nil)
	return err
}

// --- processes ---

func (c *Client) Processes(ctx context.Context, s Session) ([]Process, error) {
	var out list[Process]
	_, err := c.do(ctx, s, http.MethodGet, "/api/v1/admin/processes", nil, &out)
	return out.Items, err
}

// RestartProcess asks for a restart of one process of the resource overview.
func (c *Client) RestartProcess(ctx context.Context, s Session, key string) error {
	_, err := c.do(ctx, s, http.MethodPost, "/api/v1/admin/processes/"+url.PathEscape(key)+"/restart", nil, nil)
	return err
}

// --- server settings ---

func (c *Client) ServerSettings(ctx context.Context, s Session) (ServerSettings, error) {
	var out ServerSettings
	_, err := c.do(ctx, s, http.MethodGet, "/api/v1/admin/server-settings", nil, &out)
	return out, err
}

func (c *Client) UpdateServerSettings(ctx context.Context, s Session, in ServerSettings) (ServerSettings, error) {
	var out ServerSettings
	_, err := c.do(ctx, s, http.MethodPut, "/api/v1/admin/server-settings", in, &out)
	return out, err
}

// --- custom commands and custom events (builder) ---

// Kind picks custom commands or custom events. Both share one API shape
// under /api/v1/bots/{id}/commands and /api/v1/bots/{id}/events.
type Kind string

const (
	KindCommand Kind = "commands"
	KindEvent   Kind = "events"
)

func (k Kind) path(botID int64, rest string) string {
	return fmt.Sprintf("/api/v1/bots/%d/%s%s", botID, k, rest)
}

func (c *Client) CustomCommands(ctx context.Context, s Session, kind Kind, botID int64) ([]CustomCommand, error) {
	var out list[CustomCommand]
	rest := ""
	if kind == KindCommand {
		rest = "?builtin=false"
	}
	_, err := c.do(ctx, s, http.MethodGet, kind.path(botID, rest), nil, &out)
	return out.Items, err
}

func (c *Client) CustomCommand(ctx context.Context, s Session, kind Kind, botID, id int64) (CustomCommand, error) {
	var out CustomCommand
	_, err := c.do(ctx, s, http.MethodGet, kind.path(botID, fmt.Sprintf("/%d", id)), nil, &out)
	return out, err
}

// CreateCustomCommand creates a command; the API adds a starter graph
// (slash trigger + reply) so the editor never starts empty.
func (c *Client) CreateCustomCommand(ctx context.Context, s Session, botID int64, name, description string) (CustomCommand, error) {
	var out CustomCommand
	in := map[string]any{"name": name, "description": description, "enabled": true}
	_, err := c.do(ctx, s, http.MethodPost, KindCommand.path(botID, ""), in, &out)
	return out, err
}

// CreateCustomEvent creates an event without a type; the event type is
// picked in the editor. The API adds a starter graph with an event trigger.
func (c *Client) CreateCustomEvent(ctx context.Context, s Session, botID int64, name string) (CustomCommand, error) {
	var out CustomCommand
	in := map[string]any{"name": name, "enabled": true}
	_, err := c.do(ctx, s, http.MethodPost, KindEvent.path(botID, ""), in, &out)
	return out, err
}

func (c *Client) SetCustomCommandEnabled(ctx context.Context, s Session, kind Kind, botID, id int64, enabled bool) (CustomCommand, error) {
	var out CustomCommand
	_, err := c.do(ctx, s, http.MethodPatch, kind.path(botID, fmt.Sprintf("/%d", id)), map[string]bool{"enabled": enabled}, &out)
	return out, err
}

// SetCustomCommandPrivate sets whether only the user sees the command's
// replies; a module or plugin copy stays unsaved.
func (c *Client) SetCustomCommandPrivate(ctx context.Context, s Session, kind Kind, botID, id int64, private bool) (CustomCommand, error) {
	var out CustomCommand
	_, err := c.do(ctx, s, http.MethodPatch, kind.path(botID, fmt.Sprintf("/%d", id)), map[string]bool{"private": private}, &out)
	return out, err
}

func (c *Client) DeleteCustomCommand(ctx context.Context, s Session, kind Kind, botID, id int64) error {
	_, err := c.do(ctx, s, http.MethodDelete, kind.path(botID, fmt.Sprintf("/%d", id)), nil, nil)
	return err
}

// SetCustomCommandGroup moves a command into a group; nil means no group.
func (c *Client) SetCustomCommandGroup(ctx context.Context, s Session, kind Kind, botID, id int64, groupID *int64) error {
	_, err := c.do(ctx, s, http.MethodPatch, kind.path(botID, fmt.Sprintf("/%d", id)), map[string]*int64{"groupId": groupID}, nil)
	return err
}

func (c *Client) DeletedCommands(ctx context.Context, s Session, kind Kind, botID int64) ([]DeletedCommand, error) {
	var out list[DeletedCommand]
	_, err := c.do(ctx, s, http.MethodGet, kind.path(botID, "/deleted"), nil, &out)
	return out.Items, err
}

func (c *Client) RestoreDeletedCommand(ctx context.Context, s Session, kind Kind, botID, id int64) error {
	_, err := c.do(ctx, s, http.MethodPost, kind.path(botID, fmt.Sprintf("/deleted/%d/restore", id)), nil, nil)
	return err
}

func (c *Client) CommandVersions(ctx context.Context, s Session, kind Kind, botID, id int64) ([]CommandVersion, error) {
	var out list[CommandVersion]
	_, err := c.do(ctx, s, http.MethodGet, kind.path(botID, fmt.Sprintf("/%d/versions", id)), nil, &out)
	return out.Items, err
}

func (c *Client) RestoreCommandVersion(ctx context.Context, s Session, kind Kind, botID, id, version int64) error {
	_, err := c.do(ctx, s, http.MethodPost, kind.path(botID, fmt.Sprintf("/%d/versions/%d/restore", id, version)), nil, nil)
	return err
}

// --- command groups ---

func (c *Client) CommandGroups(ctx context.Context, s Session, botID int64) ([]CommandGroup, error) {
	var out list[CommandGroup]
	_, err := c.do(ctx, s, http.MethodGet, fmt.Sprintf("/api/v1/bots/%d/command-groups", botID), nil, &out)
	return out.Items, err
}

func (c *Client) CreateCommandGroup(ctx context.Context, s Session, botID int64, g CommandGroup) error {
	_, err := c.do(ctx, s, http.MethodPost, fmt.Sprintf("/api/v1/bots/%d/command-groups", botID), g, nil)
	return err
}

func (c *Client) UpdateCommandGroup(ctx context.Context, s Session, botID int64, g CommandGroup) error {
	_, err := c.do(ctx, s, http.MethodPut, fmt.Sprintf("/api/v1/bots/%d/command-groups/%d", botID, g.ID), g, nil)
	return err
}

func (c *Client) DeleteCommandGroup(ctx context.Context, s Session, botID, id int64) error {
	_, err := c.do(ctx, s, http.MethodDelete, fmt.Sprintf("/api/v1/bots/%d/command-groups/%d", botID, id), nil, nil)
	return err
}

// --- module commands ---

// CommandState is whether a built-in command of a module is enabled for a bot.
type CommandState struct {
	Name    string `json:"name"`
	Enabled bool   `json:"enabled"`
}

func (c *Client) ModuleCommands(ctx context.Context, s Session, botID int64, module string) ([]CommandState, error) {
	var out list[CommandState]
	path := fmt.Sprintf("/api/v1/bots/%d/modules/%s/commands", botID, url.PathEscape(module))
	_, err := c.do(ctx, s, http.MethodGet, path, nil, &out)
	return out.Items, err
}

func (c *Client) SetModuleCommand(ctx context.Context, s Session, botID int64, module, name string, enabled bool) (CommandState, error) {
	var out CommandState
	path := fmt.Sprintf("/api/v1/bots/%d/modules/%s/commands/%s", botID, url.PathEscape(module), url.PathEscape(name))
	_, err := c.do(ctx, s, http.MethodPut, path, map[string]bool{"enabled": enabled}, &out)
	return out, err
}

// --- plugins ---

func (c *Client) ListBotPlugins(ctx context.Context, s Session, botID int64) ([]InstalledPlugin, error) {
	var out list[InstalledPlugin]
	_, err := c.do(ctx, s, http.MethodGet, fmt.Sprintf("/api/v1/bots/%d/plugins", botID), nil, &out)
	return out.Items, err
}

func (c *Client) SetBotPluginEnabled(ctx context.Context, s Session, botID int64, pluginID string, enabled bool) (InstalledPlugin, error) {
	var out InstalledPlugin
	path := fmt.Sprintf("/api/v1/bots/%d/plugins/%s", botID, url.PathEscape(pluginID))
	_, err := c.do(ctx, s, http.MethodPatch, path, map[string]bool{"enabled": enabled}, &out)
	return out, err
}

// PluginConfigRaw reads this bot's saved settings of a plugin into out.
// ChoiceOption is one option of a dynamic "choices" field (ctx.config.setOptions).
type ChoiceOption struct {
	Value string `json:"value"`
	Label string `json:"label"`
}

// PluginFieldOptions: the options a plugin set for its dynamic choices fields on this bot.
func (c *Client) PluginFieldOptions(ctx context.Context, s Session, botID int64, pluginID string) (map[string][]ChoiceOption, error) {
	var out struct {
		Options map[string][]ChoiceOption `json:"options"`
	}
	_, err := c.do(ctx, s, http.MethodGet, fmt.Sprintf("/api/v1/bots/%d/plugins/%s/options", botID, url.PathEscape(pluginID)), nil, &out)
	return out.Options, err
}

func (c *Client) PluginConfigRaw(ctx context.Context, s Session, botID int64, pluginID string, out any) error {
	var wrap struct {
		Config json.RawMessage `json:"config"`
	}
	if _, err := c.do(ctx, s, http.MethodGet, fmt.Sprintf("/api/v1/bots/%d/plugins/%s/config", botID, url.PathEscape(pluginID)), nil, &wrap); err != nil {
		return err
	}
	if len(wrap.Config) == 0 {
		return nil
	}
	return json.Unmarshal(wrap.Config, out)
}

// SetPluginConfigRaw replaces the settings; the API validates them against
// the plugin's manifest.settings.
func (c *Client) SetPluginConfigRaw(ctx context.Context, s Session, botID int64, pluginID string, in, out any) error {
	var wrap struct {
		Config json.RawMessage `json:"config"`
	}
	if _, err := c.do(ctx, s, http.MethodPut, fmt.Sprintf("/api/v1/bots/%d/plugins/%s/config", botID, url.PathEscape(pluginID)), map[string]any{"config": in}, &wrap); err != nil {
		return err
	}
	if len(wrap.Config) == 0 {
		return nil
	}
	return json.Unmarshal(wrap.Config, out)
}

// AdminPlugins lists the plugins installed on the instance.
func (c *Client) AdminPlugins(ctx context.Context, s Session) ([]AdminPlugin, error) {
	var out list[AdminPlugin]
	_, err := c.do(ctx, s, http.MethodGet, "/api/v1/admin/plugins", nil, &out)
	return out.Items, err
}

// MarketPlugins lists the plugins of the market repo (cached 5 min by the
// API; refresh asks GitHub again).
// MarketPluginsCached returns the API's last market list of any age without
// a download; fresh reports it is younger than 5 minutes (false also when
// there is no list yet).
func (c *Client) MarketPluginsCached(ctx context.Context, s Session) ([]MarketPlugin, bool, error) {
	var out struct {
		Items []MarketPlugin `json:"items"`
		Fresh bool           `json:"fresh"`
	}
	_, err := c.do(ctx, s, http.MethodGet, "/api/v1/admin/plugins/market?cached=1", nil, &out)
	return out.Items, out.Fresh, err
}

func (c *Client) MarketPlugins(ctx context.Context, s Session, refresh bool) ([]MarketPlugin, error) {
	var out list[MarketPlugin]
	path := "/api/v1/admin/plugins/market"
	if refresh {
		path += "?refresh=1"
	}
	_, err := c.do(ctx, s, http.MethodGet, path, nil, &out)
	return out.Items, err
}

// InstallPluginUpload installs a plugin zip (max 5 MB; the API checks it).
func (c *Client) InstallPluginUpload(ctx context.Context, s Session, zip []byte) (PluginInstall, error) {
	var out PluginInstall
	_, err := c.do(ctx, s, http.MethodPost, "/api/v1/admin/plugins/install",
		map[string]string{"source": "upload", "zip": base64.StdEncoding.EncodeToString(zip)}, &out)
	return out, err
}

// InstallPluginMarket installs a version listed in the market index.
func (c *Client) InstallPluginMarket(ctx context.Context, s Session, id, version string) (PluginInstall, error) {
	var out PluginInstall
	_, err := c.do(ctx, s, http.MethodPost, "/api/v1/admin/plugins/install",
		map[string]string{"source": "market", "id": id, "version": version}, &out)
	return out, err
}

// SharePluginSecrets sets the secrets a plugin may read by name (secrets.read).
func (c *Client) SharePluginSecrets(ctx context.Context, s Session, id string, shared []string) error {
	_, err := c.do(ctx, s, http.MethodPut, "/api/v1/admin/plugins/"+url.PathEscape(id)+"/secrets", map[string][]string{"shared": shared}, nil)
	return err
}

// UninstallPlugin removes a plugin; deleteCommands also deletes its Custom
// Command copies on every bot.
// SetPluginEnabled switches an installed plugin on or off for every bot.
func (c *Client) SetPluginEnabled(ctx context.Context, s Session, id string, enabled bool) error {
	_, err := c.do(ctx, s, http.MethodPatch, "/api/v1/admin/plugins/"+url.PathEscape(id), map[string]bool{"enabled": enabled}, nil)
	return err
}

func (c *Client) UninstallPlugin(ctx context.Context, s Session, id string, deleteCommands bool) error {
	path := "/api/v1/admin/plugins/" + url.PathEscape(id)
	if deleteCommands {
		path += "?deleteCommands=1"
	}
	_, err := c.do(ctx, s, http.MethodDelete, path, nil, nil)
	return err
}

// --- logs ---

// Logs returns the bot's log entries, oldest first. level "" means all.
func (c *Client) Logs(ctx context.Context, s Session, botID int64, level string) ([]LogEntry, error) {
	var out list[LogEntry]
	path := fmt.Sprintf("/api/v1/bots/%d/logs?limit=500", botID)
	if level != "" {
		path += "&level=" + url.QueryEscape(level)
	}
	_, err := c.do(ctx, s, http.MethodGet, path, nil, &out)
	return out.Items, err
}

// ServerLogs returns the instance log (all services, audit events), oldest first.
func (c *Client) ServerLogs(ctx context.Context, s Session, level string) ([]LogEntry, error) {
	var out list[LogEntry]
	path := "/api/v1/admin/logs?limit=500"
	if level != "" {
		path += "&level=" + url.QueryEscape(level)
	}
	_, err := c.do(ctx, s, http.MethodGet, path, nil, &out)
	return out.Items, err
}

func (c *Client) ClearLogs(ctx context.Context, s Session, botID int64) error {
	_, err := c.do(ctx, s, http.MethodDelete, fmt.Sprintf("/api/v1/bots/%d/logs", botID), nil, nil)
	return err
}

// --- guilds and modules ---

// LeaveGuild makes the bot leave a guild.
func (c *Client) LeaveGuild(ctx context.Context, s Session, botID int64, guildID string) (Job, error) {
	var out Job
	path := fmt.Sprintf("/api/v1/bots/%d/guilds/%s", botID, url.PathEscape(guildID))
	_, err := c.do(ctx, s, http.MethodDelete, path, nil, &out)
	return out, err
}

func (c *Client) ListGuilds(ctx context.Context, s Session, botID int64) ([]Guild, error) {
	var out list[Guild]
	_, err := c.do(ctx, s, http.MethodGet, fmt.Sprintf("/api/v1/bots/%d/guilds", botID), nil, &out)
	return out.Items, err
}

// ListBotModules returns the module states of a bot. Modules apply to all guilds of the bot.
func (c *Client) ListBotModules(ctx context.Context, s Session, botID int64) ([]ModuleState, error) {
	var out list[ModuleState]
	_, err := c.do(ctx, s, http.MethodGet, fmt.Sprintf("/api/v1/bots/%d/modules", botID), nil, &out)
	return out.Items, err
}

func (c *Client) SetBotModule(ctx context.Context, s Session, botID int64, key string, enabled bool) (ModuleState, error) {
	var out ModuleState
	path := fmt.Sprintf("/api/v1/bots/%d/modules/%s", botID, url.PathEscape(key))
	_, err := c.do(ctx, s, http.MethodPut, path, map[string]bool{"enabled": enabled}, &out)
	return out, err
}

// ModerationConfig returns the moderation module settings (defaults filled in).
func (c *Client) ModerationConfig(ctx context.Context, s Session, botID int64) (ModerationConfig, error) {
	var out ModerationConfig
	_, err := c.do(ctx, s, http.MethodGet, fmt.Sprintf("/api/v1/bots/%d/modules/moderation/config", botID), nil, &out)
	return out, err
}

func (c *Client) SetModerationConfig(ctx context.Context, s Session, botID int64, in ModerationConfig) (ModerationConfig, error) {
	var out ModerationConfig
	_, err := c.do(ctx, s, http.MethodPut, fmt.Sprintf("/api/v1/bots/%d/modules/moderation/config", botID), in, &out)
	return out, err
}

// GuildRoles lists the roles of a guild (without @everyone), highest first.
func (c *Client) GuildRoles(ctx context.Context, s Session, botID int64, guildID string) ([]GuildRole, error) {
	var out list[GuildRole]
	_, err := c.do(ctx, s, http.MethodGet, fmt.Sprintf("/api/v1/bots/%d/guilds/%s/roles", botID, url.PathEscape(guildID)), nil, &out)
	return out.Items, err
}

// GuildChannels lists the channels of a guild in display order.
func (c *Client) GuildChannels(ctx context.Context, s Session, botID int64, guildID string) ([]GuildChannel, error) {
	var out list[GuildChannel]
	_, err := c.do(ctx, s, http.MethodGet, fmt.Sprintf("/api/v1/bots/%d/guilds/%s/channels", botID, url.PathEscape(guildID)), nil, &out)
	return out.Items, err
}

// --- timed events ---

func (c *Client) TimedEvents(ctx context.Context, s Session, botID int64) ([]TimedEvent, error) {
	var out list[TimedEvent]
	_, err := c.do(ctx, s, http.MethodGet, fmt.Sprintf("/api/v1/bots/%d/timed-events", botID), nil, &out)
	return out.Items, err
}

func (c *Client) CreateTimedEvent(ctx context.Context, s Session, botID int64, e TimedEvent) error {
	_, err := c.do(ctx, s, http.MethodPost, fmt.Sprintf("/api/v1/bots/%d/timed-events", botID), e, nil)
	return err
}

func (c *Client) UpdateTimedEvent(ctx context.Context, s Session, botID int64, e TimedEvent) error {
	_, err := c.do(ctx, s, http.MethodPut, fmt.Sprintf("/api/v1/bots/%d/timed-events/%d", botID, e.ID), e, nil)
	return err
}

func (c *Client) DeleteTimedEvent(ctx context.Context, s Session, botID, id int64) error {
	_, err := c.do(ctx, s, http.MethodDelete, fmt.Sprintf("/api/v1/bots/%d/timed-events/%d", botID, id), nil, nil)
	return err
}

func (c *Client) TimedSettings(ctx context.Context, s Session, botID int64) (TimedSettings, error) {
	var out TimedSettings
	_, err := c.do(ctx, s, http.MethodGet, fmt.Sprintf("/api/v1/bots/%d/timed-settings", botID), nil, &out)
	return out, err
}

func (c *Client) SetTimedSettings(ctx context.Context, s Session, botID int64, in TimedSettings) error {
	_, err := c.do(ctx, s, http.MethodPatch, fmt.Sprintf("/api/v1/bots/%d/timed-settings", botID), in, nil)
	return err
}

// --- webhooks ---

func (c *Client) Webhooks(ctx context.Context, s Session, botID int64) (WebhookList, error) {
	var out WebhookList
	_, err := c.do(ctx, s, http.MethodGet, fmt.Sprintf("/api/v1/bots/%d/webhooks", botID), nil, &out)
	return out, err
}

func (c *Client) CreateWebhook(ctx context.Context, s Session, botID int64, in WebhookCreate) error {
	_, err := c.do(ctx, s, http.MethodPost, fmt.Sprintf("/api/v1/bots/%d/webhooks", botID), in, nil)
	return err
}

func (c *Client) UpdateWebhook(ctx context.Context, s Session, botID, id int64, in WebhookUpdate) error {
	_, err := c.do(ctx, s, http.MethodPatch, fmt.Sprintf("/api/v1/bots/%d/webhooks/%d", botID, id), in, nil)
	return err
}

func (c *Client) DeleteWebhook(ctx context.Context, s Session, botID, id int64) error {
	_, err := c.do(ctx, s, http.MethodDelete, fmt.Sprintf("/api/v1/bots/%d/webhooks/%d", botID, id), nil, nil)
	return err
}

// TestWebhook runs the webhook like a real call (without the key check).
func (c *Client) TestWebhook(ctx context.Context, s Session, botID, id int64, vars map[string]string) error {
	_, err := c.do(ctx, s, http.MethodPost, fmt.Sprintf("/api/v1/bots/%d/webhooks/%d/test", botID, id), map[string]any{"variables": vars}, nil)
	return err
}

// CreateWebhookKey makes a new API key. Its value comes back only here.
func (c *Client) CreateWebhookKey(ctx context.Context, s Session, botID int64) (string, error) {
	var out struct {
		APIKey string `json:"apiKey"`
	}
	_, err := c.do(ctx, s, http.MethodPost, fmt.Sprintf("/api/v1/bots/%d/webhook-key", botID), nil, &out)
	return out.APIKey, err
}

// --- module settings (shared/module-settings) ---

// ModuleConfigRaw reads bot_modules.config of a module into out (any JSON shape).
func (c *Client) ModuleConfigRaw(ctx context.Context, s Session, botID int64, module string, out any) error {
	_, err := c.do(ctx, s, http.MethodGet, fmt.Sprintf("/api/v1/bots/%d/modules/%s/config", botID, url.PathEscape(module)), nil, out)
	return err
}

// SetModuleConfigRaw replaces the config; the API validates it against the schema.
func (c *Client) SetModuleConfigRaw(ctx context.Context, s Session, botID int64, module string, in, out any) error {
	_, err := c.do(ctx, s, http.MethodPut, fmt.Sprintf("/api/v1/bots/%d/modules/%s/config", botID, url.PathEscape(module)), in, out)
	return err
}

// --- account security: sessions and history ---

type AccountSession struct {
	ID         string    `json:"id"`
	Current    bool      `json:"current"`
	CreatedAt  time.Time `json:"createdAt"`
	LastSeenAt time.Time `json:"lastSeenAt"`
	UserAgent  string    `json:"userAgent"`
	IP         string    `json:"ip"`
	// Remember: "stay signed in"; DeviceBound: tied to a browser key.
	Remember    bool      `json:"remember"`
	DeviceBound bool      `json:"deviceBound"`
	ExpiresAt   time.Time `json:"expiresAt"`
}

type SecurityEvent struct {
	ID        string    `json:"id"`
	Type      string    `json:"type"`
	Time      time.Time `json:"time"`
	IP        string    `json:"ip"`
	UserAgent string    `json:"userAgent"`
}

func (c *Client) Sessions(ctx context.Context, s Session) ([]AccountSession, error) {
	var out list[AccountSession]
	_, err := c.do(ctx, s, http.MethodGet, "/api/v1/auth/sessions", nil, &out)
	return out.Items, err
}

func (c *Client) RevokeSession(ctx context.Context, s Session, id string) error {
	_, err := c.do(ctx, s, http.MethodDelete, "/api/v1/auth/sessions/"+url.PathEscape(id), nil, nil)
	return err
}

func (c *Client) RevokeOtherSessions(ctx context.Context, s Session) (int, error) {
	var out struct {
		Revoked int `json:"revoked"`
	}
	_, err := c.do(ctx, s, http.MethodPost, "/api/v1/auth/sessions/revoke-others", nil, &out)
	return out.Revoked, err
}

func (c *Client) SecurityActivity(ctx context.Context, s Session) ([]SecurityEvent, error) {
	var out list[SecurityEvent]
	_, err := c.do(ctx, s, http.MethodGet, "/api/v1/auth/activity", nil, &out)
	return out.Items, err
}

// --- admin: global API secrets and endpoints ---

// GlobalSecret never carries its value: secrets are write-only.
type GlobalSecret struct {
	Key         string `json:"key"`
	Description string `json:"description"`
	// Set: false for a placeholder a plugin install created ([NULL]).
	Set       bool      `json:"set"`
	CreatedAt time.Time `json:"createdAt"`
	UpdatedAt time.Time `json:"updatedAt"`
}

func (c *Client) GlobalSecrets(ctx context.Context, s Session) ([]GlobalSecret, error) {
	var out list[GlobalSecret]
	_, err := c.do(ctx, s, http.MethodGet, "/api/v1/admin/secrets", nil, &out)
	return out.Items, err
}

// SaveGlobalSecret creates or updates a secret; value nil keeps the stored value.
func (c *Client) SaveGlobalSecret(ctx context.Context, s Session, key, description string, value *string) error {
	in := map[string]any{"description": description}
	if value != nil {
		in["value"] = *value
	}
	_, err := c.do(ctx, s, http.MethodPut, "/api/v1/admin/secrets/"+url.PathEscape(key), in, nil)
	return err
}

func (c *Client) DeleteGlobalSecret(ctx context.Context, s Session, key string) error {
	_, err := c.do(ctx, s, http.MethodDelete, "/api/v1/admin/secrets/"+url.PathEscape(key), nil, nil)
	return err
}

// --- own secrets of the signed-in user (User settings → API / Secrets) ---

// UserSecrets lists the signed-in user's secrets; their bots and the plugins
// on them use these.
func (c *Client) UserSecrets(ctx context.Context, s Session) ([]GlobalSecret, error) {
	var out list[GlobalSecret]
	_, err := c.do(ctx, s, http.MethodGet, "/api/v1/me/secrets", nil, &out)
	return out.Items, err
}

// SaveUserSecret creates or updates an own secret; value nil keeps the stored value.
func (c *Client) SaveUserSecret(ctx context.Context, s Session, key, description string, value *string) error {
	in := map[string]any{"description": description}
	if value != nil {
		in["value"] = *value
	}
	_, err := c.do(ctx, s, http.MethodPut, "/api/v1/me/secrets/"+url.PathEscape(key), in, nil)
	return err
}

func (c *Client) DeleteUserSecret(ctx context.Context, s Session, key string) error {
	_, err := c.do(ctx, s, http.MethodDelete, "/api/v1/me/secrets/"+url.PathEscape(key), nil, nil)
	return err
}

// PluginFile is an image of a plugin's files (plugin_files); the name is
// the content hash plus the extension.
type PluginFile struct {
	Name string `json:"name"`
	Mime string `json:"mime"`
	Size int64  `json:"size"`
	// Filename: the original name (files other than images), CreatedAt from the API.
	Filename  string    `json:"filename"`
	CreatedAt time.Time `json:"createdAt"`
}

// PluginFiles lists the files a plugin keeps for a bot.
func (c *Client) PluginFiles(ctx context.Context, s Session, botID int64, pluginID string) ([]PluginFile, error) {
	var out list[PluginFile]
	_, err := c.do(ctx, s, http.MethodGet, fmt.Sprintf("/api/v1/bots/%d/plugins/%s/files", botID, url.PathEscape(pluginID)), nil, &out)
	return out.Items, err
}

// UploadPluginFile stores an image for the plugin's "image" settings fields.
// UploadPluginFile stores an upload; accept "image" or "audio" (filename gives the sound's type).
func (c *Client) UploadPluginFile(ctx context.Context, s Session, botID int64, pluginID string, data []byte, accept, filename string) (PluginFile, error) {
	var out PluginFile
	_, err := c.do(ctx, s, http.MethodPost, fmt.Sprintf("/api/v1/bots/%d/plugins/%s/files", botID, url.PathEscape(pluginID)), map[string]string{"data": base64.StdEncoding.EncodeToString(data), "accept": accept, "filename": filename}, &out)
	return out, err
}

// PluginDownload is one plugin file with its original name and bytes.
type PluginDownload struct {
	Filename string
	Data     []byte
}

// PluginFileDownload reads one file of a plugin for a download.
func (c *Client) PluginFileDownload(ctx context.Context, s Session, botID int64, pluginID, name string) (PluginDownload, error) {
	var out struct {
		Filename string `json:"filename"`
		Data     string `json:"data"`
	}
	if _, err := c.do(ctx, s, http.MethodGet, fmt.Sprintf("/api/v1/bots/%d/plugins/%s/files/%s", botID, url.PathEscape(pluginID), url.PathEscape(name)), nil, &out); err != nil {
		return PluginDownload{}, err
	}
	data, err := base64.StdEncoding.DecodeString(out.Data)
	return PluginDownload{Filename: out.Filename, Data: data}, err
}

// PluginFileData reads one image of a plugin: its type and its bytes.
func (c *Client) PluginFileData(ctx context.Context, s Session, botID int64, pluginID, name string) (string, []byte, error) {
	var out struct {
		Mime string `json:"mime"`
		Data string `json:"data"`
	}
	if _, err := c.do(ctx, s, http.MethodGet, fmt.Sprintf("/api/v1/bots/%d/plugins/%s/files/%s", botID, url.PathEscape(pluginID), url.PathEscape(name)), nil, &out); err != nil {
		return "", nil, err
	}
	data, err := base64.StdEncoding.DecodeString(out.Data)
	return out.Mime, data, err
}

// LegalInfo: operator details of the public Terms and Privacy pages.
// AdminEmail (read only) is the fallback contact.
type LegalInfo struct {
	Operator   string `json:"operator"`
	Address    string `json:"address"`
	Email      string `json:"email"`
	SourceURL  string `json:"sourceUrl"`
	AdminEmail string `json:"adminEmail,omitempty"`
}

// Legal reads the operator details without a session (public pages).
func (c *Client) Legal(ctx context.Context) (LegalInfo, error) {
	var out LegalInfo
	_, err := c.do(ctx, Session{}, http.MethodGet, "/api/v1/legal", nil, &out)
	return out, err
}

// AdminLegal reads the operator details for the admin form.
func (c *Client) AdminLegal(ctx context.Context, s Session) (LegalInfo, error) {
	var out LegalInfo
	_, err := c.do(ctx, s, http.MethodGet, "/api/v1/admin/legal", nil, &out)
	return out, err
}

// SaveLegal stores the operator details.
func (c *Client) SaveLegal(ctx context.Context, s Session, in LegalInfo) (LegalInfo, error) {
	var out LegalInfo
	_, err := c.do(ctx, s, http.MethodPut, "/api/v1/admin/legal", map[string]string{"operator": in.Operator, "address": in.Address, "email": in.Email, "sourceUrl": in.SourceURL}, &out)
	return out, err
}

// InviteSettings: the custom invite link (<domain>/invite/<application ID>).
// Mode "private": only signed-in dashboard users get the Discord link;
// "public": everyone.
type InviteSettings struct {
	Enabled bool   `json:"enabled"`
	Mode    string `json:"mode"`
}

// InviteBot is the public face of a bot on its invite page.
type InviteBot struct {
	Name          string  `json:"name"`
	AvatarURL     *string `json:"avatarUrl"`
	ApplicationID string  `json:"applicationId"`
	// InvitesClosed: the bot leaves every server that is not allowed.
	InvitesClosed bool `json:"invitesClosed"`
}

// InvitePageData is what the public invite page needs.
type InvitePageData struct {
	InviteSettings
	Bot InviteBot `json:"bot"`
}

// InvitePage reads the invite page of one bot without a session; 404 when
// the custom link is off or no bot has the application ID.
func (c *Client) InvitePage(ctx context.Context, appID string) (InvitePageData, error) {
	var out InvitePageData
	_, err := c.do(ctx, Session{}, http.MethodGet, "/api/v1/invite/"+url.PathEscape(appID), nil, &out)
	return out, err
}

func (c *Client) InviteSettings(ctx context.Context, s Session) (InviteSettings, error) {
	var out InviteSettings
	_, err := c.do(ctx, s, http.MethodGet, "/api/v1/admin/invite-settings", nil, &out)
	return out, err
}

func (c *Client) SaveInviteSettings(ctx context.Context, s Session, in InviteSettings) (InviteSettings, error) {
	var out InviteSettings
	_, err := c.do(ctx, s, http.MethodPut, "/api/v1/admin/invite-settings", in, &out)
	return out, err
}

// AccessGuild is a server of the closed-invites list: allowed, and whether
// the bot is on it now.
type AccessGuild struct {
	ID      string  `json:"id"`
	Name    string  `json:"name"`
	IconURL *string `json:"iconUrl"`
	Allowed bool    `json:"allowed"`
	Current bool    `json:"current"`
}

// GuildAccess: with Closed the bot stays only on allowed servers and leaves others.
type GuildAccess struct {
	Closed bool          `json:"closed"`
	Guilds []AccessGuild `json:"guilds"`
}

func (c *Client) GuildAccess(ctx context.Context, s Session, botID int64) (GuildAccess, error) {
	var out GuildAccess
	_, err := c.do(ctx, s, http.MethodGet, fmt.Sprintf("/api/v1/bots/%d/guild-access", botID), nil, &out)
	return out, err
}

func (c *Client) SaveGuildAccess(ctx context.Context, s Session, botID int64, closed bool, allowed []string) (GuildAccess, error) {
	var out GuildAccess
	if allowed == nil {
		allowed = []string{}
	}
	_, err := c.do(ctx, s, http.MethodPut, fmt.Sprintf("/api/v1/bots/%d/guild-access", botID), map[string]any{"closed": closed, "allowed": allowed}, &out)
	return out, err
}
