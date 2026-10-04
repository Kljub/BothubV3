package api

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
)

// Bot backups and templates (openapi: /bots/{botId}/backup, /backups, /restore).

type BotBackup struct {
	ID          string  `json:"id"` // number, or builtin:<key>
	Kind        string  `json:"kind"`
	Name        string  `json:"name"`
	Description string  `json:"description"`
	Auto        bool    `json:"auto"`
	CreatedAt   *string `json:"createdAt"`
	Size        int64   `json:"size"`
}

func (c *Client) BotBackups(ctx context.Context, s Session, botID int64) ([]BotBackup, error) {
	var out list[BotBackup]
	_, err := c.do(ctx, s, http.MethodGet, fmt.Sprintf("/api/v1/bots/%d/backups", botID), nil, &out)
	return out.Items, err
}

// BotBackupData is the JSON of the current state (id "") or of a saved entry.
func (c *Client) BotBackupData(ctx context.Context, s Session, botID int64, id string) (json.RawMessage, error) {
	path := fmt.Sprintf("/api/v1/bots/%d/backup", botID)
	if id != "" {
		path = fmt.Sprintf("/api/v1/bots/%d/backups/%s", botID, url.PathEscape(id))
	}
	var out json.RawMessage
	_, err := c.do(ctx, s, http.MethodGet, path, nil, &out)
	return out, err
}

// SaveBotBackup saves the current state; kind "backup" or "template".
func (c *Client) SaveBotBackup(ctx context.Context, s Session, botID int64, kind, name, description string) error {
	_, err := c.do(ctx, s, http.MethodPost, fmt.Sprintf("/api/v1/bots/%d/backups", botID), map[string]string{"kind": kind, "name": name, "description": description}, nil)
	return err
}

func (c *Client) DeleteBotBackup(ctx context.Context, s Session, botID int64, id string) error {
	_, err := c.do(ctx, s, http.MethodDelete, fmt.Sprintf("/api/v1/bots/%d/backups/%s", botID, url.PathEscape(id)), nil, nil)
	return err
}

// RestoreBot loads a saved entry (id) or an uploaded backup (data) into the bot.
func (c *Client) RestoreBot(ctx context.Context, s Session, botID int64, id string, data json.RawMessage, name string) error {
	in := map[string]any{"name": name}
	if id != "" {
		in["id"] = id
	} else {
		in["data"] = data
	}
	_, err := c.do(ctx, s, http.MethodPost, fmt.Sprintf("/api/v1/bots/%d/restore", botID), in, nil)
	return err
}
