package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Discord REST interface (API v10). Checks bot tokens and reads what the
// dashboard shows from Discord: the bot user, its servers, roles and
// channels; changes the bot profile and leaves servers. The gateway
// connection (presence, events, commands) is the NodeCore's job.
//
// Tokens are only sent to discord.com in the Authorization header; they are
// never logged and never part of an error.

const discordAPI = "https://discord.com/api/v10"
const discordCDN = "https://cdn.discordapp.com"

type discordClient struct {
	base string
	http *http.Client

	mu    sync.Mutex
	cache map[string]cachedResponse // GET responses per token and path
}

type cachedResponse struct {
	body    []byte
	expires time.Time
}

// guildCacheTTL keeps server, role and channel lists briefly, so pickers and
// polling do not run into Discord's rate limits.
const guildCacheTTL = 30 * time.Second

func newDiscordClient(base string) *discordClient {
	return &discordClient{base: strings.TrimRight(base, "/"), http: &http.Client{Timeout: 10 * time.Second}, cache: map[string]cachedResponse{}}
}

// discordError carries the dashboard error key for a failed Discord call.
type discordError struct {
	Status int    // HTTP status for the dashboard
	Key    string // i18n key
}

func (e *discordError) Error() string { return e.Key }

func asDiscordError(err error) *discordError {
	var de *discordError
	if errors.As(err, &de) {
		return de
	}
	return &discordError{Status: 502, Key: "error.discord.unavailable"}
}

// do sends one request. A 429 is retried once when Discord asks to wait at
// most 5 seconds; longer waits become error.discord.rate_limited.
func (c *discordClient) do(ctx context.Context, token, method, path string, body any, out any) error {
	var payload []byte
	if body != nil {
		var err error
		if payload, err = json.Marshal(body); err != nil {
			return err
		}
	}
	for attempt := 0; ; attempt++ {
		req, err := http.NewRequestWithContext(ctx, method, c.base+path, bytes.NewReader(payload))
		if err != nil {
			return err
		}
		req.Header.Set("Authorization", "Bot "+token)
		req.Header.Set("User-Agent", "DiscordBot (https://github.com/Kljub/BothubV3, 3.0)")
		if body != nil {
			req.Header.Set("Content-Type", "application/json")
		}
		resp, err := c.http.Do(req)
		if err != nil {
			slog.Warn("discord request failed", "method", method, "path", redactPath(path), "err", err)
			return &discordError{Status: 502, Key: "error.discord.unavailable"}
		}
		data, _ := io.ReadAll(io.LimitReader(resp.Body, 8<<20))
		resp.Body.Close()

		if resp.StatusCode == http.StatusTooManyRequests {
			var rl struct {
				RetryAfter float64 `json:"retry_after"`
			}
			_ = json.Unmarshal(data, &rl)
			if attempt == 0 && rl.RetryAfter > 0 && rl.RetryAfter <= 5 {
				select {
				case <-time.After(time.Duration(rl.RetryAfter*1000) * time.Millisecond):
					continue
				case <-ctx.Done():
					return ctx.Err()
				}
			}
			return &discordError{Status: 429, Key: "error.discord.rate_limited"}
		}
		if resp.StatusCode >= 300 {
			return c.statusError(resp.StatusCode, data, method, path)
		}
		if out != nil && len(data) > 0 {
			return json.Unmarshal(data, out)
		}
		return nil
	}
}

func (c *discordClient) statusError(status int, data []byte, method, path string) error {
	var body struct {
		Code    int    `json:"code"`
		Message string `json:"message"`
	}
	_ = json.Unmarshal(data, &body)
	slog.Info("discord refused request", "method", method, "path", redactPath(path), "status", status, "code", body.Code, "message", body.Message)
	switch {
	case status == 401:
		return &discordError{Status: 422, Key: "error.bot.token_invalid"}
	case status == 403:
		return &discordError{Status: 403, Key: "error.discord.missing_access"}
	case status == 404 && strings.HasPrefix(path, "/guilds/"), status == 404 && strings.HasPrefix(path, "/users/@me/guilds/"):
		return &discordError{Status: 404, Key: "error.guild.not_found"}
	case status == 400 && body.Code == 50035:
		return &discordError{Status: 422, Key: "error.discord.invalid_form"}
	case status >= 500:
		return &discordError{Status: 502, Key: "error.discord.unavailable"}
	}
	return &discordError{Status: 502, Key: "error.discord.request_failed"}
}

// redactPath drops the query string for logs (paths never hold tokens).
func redactPath(p string) string {
	if i := strings.IndexByte(p, '?'); i >= 0 {
		return p[:i]
	}
	return p
}

// cachedGet serves GETs from the short cache (per token and path).
func (c *discordClient) cachedGet(ctx context.Context, token, path string, out any) error {
	key := cacheKey(token, path)
	c.mu.Lock()
	hit, ok := c.cache[key]
	c.mu.Unlock()
	if ok && time.Now().Before(hit.expires) {
		return json.Unmarshal(hit.body, out)
	}
	var raw json.RawMessage
	if err := c.do(ctx, token, http.MethodGet, path, nil, &raw); err != nil {
		return err
	}
	c.mu.Lock()
	c.cache[key] = cachedResponse{body: raw, expires: time.Now().Add(guildCacheTTL)}
	c.mu.Unlock()
	return json.Unmarshal(raw, out)
}

// forget drops cached responses of one token (after a change).
func (c *discordClient) forget(token string) {
	prefix := cacheKey(token, "")
	c.mu.Lock()
	defer c.mu.Unlock()
	for k := range c.cache {
		if strings.HasPrefix(k, prefix) {
			delete(c.cache, k)
		}
	}
}

// cacheKey uses a hash of the token, so the token itself is not a map key.
func cacheKey(token, path string) string {
	return fmt.Sprintf("%x|%s", fnv64(token), path)
}

func fnv64(s string) uint64 {
	h := uint64(14695981039346656037)
	for i := 0; i < len(s); i++ {
		h ^= uint64(s[i])
		h *= 1099511628211
	}
	return h
}

// --- Discord objects ---

type discordUser struct {
	ID         string  `json:"id"`
	Username   string  `json:"username"`
	GlobalName *string `json:"global_name"`
	Avatar     *string `json:"avatar"`
	Banner     *string `json:"banner"`
	Bot        bool    `json:"bot"`
}

type discordApplication struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	Description string `json:"description"`
	Flags       int64  `json:"flags"`
}

type discordGuild struct {
	ID          string  `json:"id"`
	Name        string  `json:"name"`
	Icon        *string `json:"icon"`
	MemberCount int     `json:"approximate_member_count"`
}

type discordRole struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	Color    int    `json:"color"`
	Position int    `json:"position"`
	Managed  bool   `json:"managed"`
}

type discordChannel struct {
	ID       string  `json:"id"`
	Name     string  `json:"name"`
	Type     int     `json:"type"`
	ParentID *string `json:"parent_id"`
	Position int     `json:"position"`
}

// Application flags: privileged gateway intents enabled in the developer portal.
const (
	flagPresenceIntent       = 1 << 12
	flagPresenceIntentLtd    = 1 << 13
	flagMembersIntent        = 1 << 14
	flagMembersIntentLtd     = 1 << 15
	flagMessageContentIntent = 1 << 18
	flagMessageContentLtd    = 1 << 19
)

// botIdentity is what a valid token tells about its bot.
type botIdentity struct {
	User        discordUser
	Application discordApplication
}

// checkToken validates a bot token and reads the bot and its application.
func (c *discordClient) checkToken(ctx context.Context, token string) (botIdentity, error) {
	token = strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(token), "Bot "))
	if token == "" || strings.ContainsAny(token, " \t\r\n") || len(token) > 200 {
		return botIdentity{}, &discordError{Status: 422, Key: "error.bot.token_invalid"}
	}
	var id botIdentity
	if err := c.do(ctx, token, http.MethodGet, "/users/@me", nil, &id.User); err != nil {
		return id, err
	}
	if !id.User.Bot {
		return id, &discordError{Status: 422, Key: "error.bot.token_invalid"}
	}
	if err := c.do(ctx, token, http.MethodGet, "/applications/@me", nil, &id.Application); err != nil {
		return id, err
	}
	return id, nil
}

func (c *discordClient) guilds(ctx context.Context, token string) ([]discordGuild, error) {
	var out []discordGuild
	err := c.cachedGet(ctx, token, "/users/@me/guilds?with_counts=true&limit=200", &out)
	return out, err
}

func (c *discordClient) roles(ctx context.Context, token, guildID string) ([]discordRole, error) {
	var out []discordRole
	err := c.cachedGet(ctx, token, "/guilds/"+guildID+"/roles", &out)
	return out, err
}

func (c *discordClient) channels(ctx context.Context, token, guildID string) ([]discordChannel, error) {
	var out []discordChannel
	err := c.cachedGet(ctx, token, "/guilds/"+guildID+"/channels", &out)
	return out, err
}

func (c *discordClient) leaveGuild(ctx context.Context, token, guildID string) error {
	defer c.forget(token)
	return c.do(ctx, token, http.MethodDelete, "/users/@me/guilds/"+guildID, nil, nil)
}

// updateUser changes name, avatar or banner (images as data: URLs).
func (c *discordClient) updateUser(ctx context.Context, token string, fields map[string]any) (discordUser, error) {
	var out discordUser
	err := c.do(ctx, token, http.MethodPatch, "/users/@me", fields, &out)
	return out, err
}

// updateDescription sets the "About me" text, which is the application description.
func (c *discordClient) updateDescription(ctx context.Context, token, text string) error {
	return c.do(ctx, token, http.MethodPatch, "/applications/@me", map[string]string{"description": text}, nil)
}

func (c *discordClient) application(ctx context.Context, token string) (discordApplication, error) {
	var out discordApplication
	err := c.do(ctx, token, http.MethodGet, "/applications/@me", nil, &out)
	return out, err
}

func (c *discordClient) me(ctx context.Context, token string) (discordUser, error) {
	var out discordUser
	err := c.do(ctx, token, http.MethodGet, "/users/@me", nil, &out)
	return out, err
}

// --- CDN URLs ---

func avatarURL(u discordUser) string {
	if u.Avatar == nil || *u.Avatar == "" {
		id, _ := strconv.ParseUint(u.ID, 10, 64)
		return fmt.Sprintf("%s/embed/avatars/%d.png", discordCDN, (id>>22)%6)
	}
	return fmt.Sprintf("%s/avatars/%s/%s.%s?size=256", discordCDN, u.ID, *u.Avatar, imageExt(*u.Avatar))
}

func bannerURL(u discordUser) *string {
	if u.Banner == nil || *u.Banner == "" {
		return nil
	}
	url := fmt.Sprintf("%s/banners/%s/%s.%s?size=600", discordCDN, u.ID, *u.Banner, imageExt(*u.Banner))
	return &url
}

func guildIconURL(g discordGuild) *string {
	if g.Icon == nil || *g.Icon == "" {
		return nil
	}
	url := fmt.Sprintf("%s/icons/%s/%s.%s?size=128", discordCDN, g.ID, *g.Icon, imageExt(*g.Icon))
	return &url
}

func imageExt(hash string) string {
	if strings.HasPrefix(hash, "a_") {
		return "gif"
	}
	return "png"
}

// channelTypes maps Discord channel types to the dashboard names.
var channelTypes = map[int]string{0: "text", 2: "voice", 4: "category", 5: "announcement", 13: "stage", 15: "forum", 16: "media"}

func roleColor(c int) any {
	if c == 0 {
		return nil
	}
	return fmt.Sprintf("#%06x", c)
}

// missingIntents lists privileged intents that are off in the developer portal.
func missingIntents(flags int64) []string {
	var out []string
	if flags&(flagMembersIntent|flagMembersIntentLtd) == 0 {
		out = append(out, "GUILD_MEMBERS")
	}
	if flags&(flagPresenceIntent|flagPresenceIntentLtd) == 0 {
		out = append(out, "GUILD_PRESENCES")
	}
	if flags&(flagMessageContentIntent|flagMessageContentLtd) == 0 {
		out = append(out, "MESSAGE_CONTENT")
	}
	return out
}
