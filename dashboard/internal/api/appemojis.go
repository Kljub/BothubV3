package api

import (
	"context"
	"encoding/base64"
	"fmt"
	"net/http"
	"net/url"
)

// AppEmoji is an emoji of the bot's application (usable on every server).
type AppEmoji struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	Animated bool   `json:"animated"`
	Code     string `json:"code"` // <:name:id>, ready to paste
	URL      string `json:"url"`
}

type AppEmojiList struct {
	Items         []AppEmoji `json:"items"`
	Max           int        `json:"max"`
	ApplicationID string     `json:"applicationId"`
}

func (c *Client) AppEmojis(ctx context.Context, s Session, botID int64) (AppEmojiList, error) {
	var out AppEmojiList
	_, err := c.do(ctx, s, http.MethodGet, fmt.Sprintf("/api/v1/bots/%d/app-emojis", botID), nil, &out)
	return out, err
}

func (c *Client) CreateAppEmoji(ctx context.Context, s Session, botID int64, name string, image []byte) (AppEmoji, error) {
	var out AppEmoji
	in := map[string]string{"name": name, "data": base64.StdEncoding.EncodeToString(image)}
	_, err := c.do(ctx, s, http.MethodPost, fmt.Sprintf("/api/v1/bots/%d/app-emojis", botID), in, &out)
	return out, err
}

func (c *Client) RenameAppEmoji(ctx context.Context, s Session, botID int64, id, name string) error {
	_, err := c.do(ctx, s, http.MethodPatch, fmt.Sprintf("/api/v1/bots/%d/app-emojis/%s", botID, url.PathEscape(id)), map[string]string{"name": name}, nil)
	return err
}

func (c *Client) DeleteAppEmoji(ctx context.Context, s Session, botID int64, id string) error {
	_, err := c.do(ctx, s, http.MethodDelete, fmt.Sprintf("/api/v1/bots/%d/app-emojis/%s", botID, url.PathEscape(id)), nil, nil)
	return err
}
