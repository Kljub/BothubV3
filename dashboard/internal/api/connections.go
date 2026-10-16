package api

import (
	"context"
	"fmt"
	"net/http"
	"net/url"
)

// Auto Assign Roles ("connection-roles"): the bot's Discord sign-in for
// members (client secret write-only) and the members who linked their
// connections (Steam, GitHub, Twitch …).

// ConnectionsApp is the sign-in setup of a bot; never the client secret.
type ConnectionsApp struct {
	Configured    bool    `json:"configured"`
	ApplicationID string  `json:"applicationId"`
	PublicURL     string  `json:"publicUrl"`
	RedirectURI   string  `json:"redirectUri"`
	LinkURL       string  `json:"linkUrl"`
	Linked        int     `json:"linked"`
	UpdatedAt     *string `json:"updatedAt"`
}

// MemberConnection is one connection of a linked member.
type MemberConnection struct {
	Type     string `json:"type"`
	Name     string `json:"name"`
	Verified bool   `json:"verified"`
}

// LinkedMember is a member who linked their connections.
type LinkedMember struct {
	UserID      string             `json:"userId"`
	UserName    string             `json:"userName"`
	Connections []MemberConnection `json:"connections"`
	LinkedAt    string             `json:"linkedAt"`
	CheckedAt   string             `json:"checkedAt"`
}

// ConnectPage is the public data of /connect/<application ID>.
type ConnectPage struct {
	BotName       string   `json:"botName"`
	AvatarURL     *string  `json:"avatarUrl"`
	ApplicationID string   `json:"applicationId"`
	Scopes        []string `json:"scopes"`
}

// ConnectResult is what the member sees after the sign-in.
type ConnectResult struct {
	BotName     string             `json:"botName"`
	UserName    string             `json:"userName"`
	Connections []MemberConnection `json:"connections"`
}

func (c *Client) ConnectionsApp(ctx context.Context, s Session, botID int64) (ConnectionsApp, error) {
	var out ConnectionsApp
	_, err := c.do(ctx, s, http.MethodGet, fmt.Sprintf("/api/v1/bots/%d/connections", botID), nil, &out)
	return out, err
}

// SaveConnectionsApp stores the client secret (empty: keep it) and the dashboard address.
func (c *Client) SaveConnectionsApp(ctx context.Context, s Session, botID int64, secret, publicURL string) (ConnectionsApp, error) {
	var out ConnectionsApp
	_, err := c.do(ctx, s, http.MethodPut, fmt.Sprintf("/api/v1/bots/%d/connections", botID), map[string]string{"clientSecret": secret, "publicUrl": publicURL}, &out)
	return out, err
}

func (c *Client) RemoveConnectionsApp(ctx context.Context, s Session, botID int64) error {
	_, err := c.do(ctx, s, http.MethodDelete, fmt.Sprintf("/api/v1/bots/%d/connections", botID), nil, nil)
	return err
}

func (c *Client) LinkedMembers(ctx context.Context, s Session, botID int64) ([]LinkedMember, error) {
	var out struct {
		Items []LinkedMember `json:"items"`
	}
	_, err := c.do(ctx, s, http.MethodGet, fmt.Sprintf("/api/v1/bots/%d/connections/members", botID), nil, &out)
	return out.Items, err
}

func (c *Client) UnlinkMember(ctx context.Context, s Session, botID int64, userID string) error {
	_, err := c.do(ctx, s, http.MethodDelete, fmt.Sprintf("/api/v1/bots/%d/connections/members/%s", botID, url.PathEscape(userID)), nil, nil)
	return err
}

// ConnectPageData is public: the bot's name and avatar for the member page.
func (c *Client) ConnectPageData(ctx context.Context, appID string) (ConnectPage, error) {
	var out ConnectPage
	_, err := c.do(ctx, Session{}, http.MethodGet, "/api/v1/connect/"+url.PathEscape(appID), nil, &out)
	return out, err
}

// ConnectLink trades the code of the member's Discord sign-in (public; the code is the proof).
func (c *Client) ConnectLink(ctx context.Context, appID, code, redirectURI string) (ConnectResult, error) {
	var out ConnectResult
	_, err := c.do(ctx, Session{}, http.MethodPost, "/api/v1/connect/"+url.PathEscape(appID)+"/link", map[string]string{"code": code, "redirectUri": redirectURI}, &out)
	return out, err
}
