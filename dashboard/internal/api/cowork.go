package api

import (
	"context"
	"fmt"
	"net/http"
	"net/url"
)

// Co-Work: the people who work on a bot, invites, saved roles, activity.

type CoworkMember struct {
	UserID      int64    `json:"userId"`
	Username    string   `json:"username"`
	Role        string   `json:"role"` // owner, viewer, operator, builder, admin, custom
	Permissions []string `json:"permissions"`
	Owner       bool     `json:"owner"`
}

type CoworkInvite struct {
	ID          int64    `json:"id"`
	Kind        string   `json:"kind"` // link, user
	Role        string   `json:"role"`
	RoleName    string   `json:"roleName"`
	Permissions []string `json:"permissions"`
	Username    *string  `json:"username"`
	CreatedAt   string   `json:"createdAt"`
	ExpiresAt   *string  `json:"expiresAt"`
	MaxUses     int      `json:"maxUses"`
	Uses        int      `json:"uses"`
	Token       string   `json:"token,omitempty"` // only right after creating a link
	BotName     string   `json:"botName,omitempty"`
	ByName      *string  `json:"byName,omitempty"`
}

type CoworkRole struct {
	ID          int64    `json:"id"`
	Name        string   `json:"name"`
	Permissions []string `json:"permissions"`
}

type CoworkActivity struct {
	Time   string         `json:"time"`
	Key    string         `json:"key"`
	Params map[string]any `json:"params"`
	User   *string        `json:"user"`
}

type CoworkPage struct {
	Members       []CoworkMember   `json:"members"`
	Invites       []CoworkInvite   `json:"invites"`
	Roles         []CoworkRole     `json:"roles"`
	Activity      []CoworkActivity `json:"activity"`
	Permissions   []string         `json:"permissions"`
	MyRole        string           `json:"myRole"`
	MyPermissions []string         `json:"myPermissions"`
}

func (c *Client) Cowork(ctx context.Context, s Session, botID int64) (CoworkPage, error) {
	var out CoworkPage
	_, err := c.do(ctx, s, http.MethodGet, fmt.Sprintf("/api/v1/bots/%d/cowork", botID), nil, &out)
	return out, err
}

// SetBotMember: user = ID or user name.
func (c *Client) SetBotMember(ctx context.Context, s Session, botID int64, user, role string, perms []string) error {
	_, err := c.do(ctx, s, http.MethodPut, fmt.Sprintf("/api/v1/bots/%d/members/%s", botID, url.PathEscape(user)), map[string]any{"role": role, "permissions": perms}, nil)
	return err
}

func (c *Client) RemoveBotMember(ctx context.Context, s Session, botID, userID int64) error {
	_, err := c.do(ctx, s, http.MethodDelete, fmt.Sprintf("/api/v1/bots/%d/members/%d", botID, userID), nil, nil)
	return err
}

// CreateInvite: kind link or user (username); expiresIn seconds, 0 = never.
func (c *Client) CreateInvite(ctx context.Context, s Session, botID int64, in map[string]any) (CoworkInvite, error) {
	var out CoworkInvite
	_, err := c.do(ctx, s, http.MethodPost, fmt.Sprintf("/api/v1/bots/%d/cowork/invites", botID), in, &out)
	return out, err
}

func (c *Client) RevokeInvite(ctx context.Context, s Session, botID, id int64) error {
	_, err := c.do(ctx, s, http.MethodDelete, fmt.Sprintf("/api/v1/bots/%d/cowork/invites/%d", botID, id), nil, nil)
	return err
}

func (c *Client) SaveCoworkRole(ctx context.Context, s Session, botID int64, name string, perms []string) error {
	_, err := c.do(ctx, s, http.MethodPost, fmt.Sprintf("/api/v1/bots/%d/cowork/roles", botID), map[string]any{"name": name, "permissions": perms}, nil)
	return err
}

func (c *Client) DeleteCoworkRole(ctx context.Context, s Session, botID, id int64) error {
	_, err := c.do(ctx, s, http.MethodDelete, fmt.Sprintf("/api/v1/bots/%d/cowork/roles/%d", botID, id), nil, nil)
	return err
}

// MyInvites: invites addressed to the signed-in user.
func (c *Client) MyInvites(ctx context.Context, s Session) ([]CoworkInvite, error) {
	var out list[CoworkInvite]
	_, err := c.do(ctx, s, http.MethodGet, "/api/v1/invites", nil, &out)
	return out.Items, err
}

// AcceptInvite by link token or invite ID; answers the bot ID.
func (c *Client) AcceptInvite(ctx context.Context, s Session, token string, id int64) (int64, error) {
	var out struct {
		BotID int64 `json:"botId"`
	}
	body := map[string]any{"id": id}
	if token != "" {
		body = map[string]any{"token": token}
	}
	_, err := c.do(ctx, s, http.MethodPost, "/api/v1/invites/accept", body, &out)
	return out.BotID, err
}

func (c *Client) DeclineInvite(ctx context.Context, s Session, id int64) error {
	_, err := c.do(ctx, s, http.MethodPost, fmt.Sprintf("/api/v1/invites/%d/decline", id), nil, nil)
	return err
}
