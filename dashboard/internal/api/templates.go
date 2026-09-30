package api

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"time"
)

// Message Builder module: saved messages (message templates).

type MessageTemplate struct {
	ID        int64           `json:"id"`
	Name      string          `json:"name"`
	Message   json.RawMessage `json:"message"`
	CreatedAt time.Time       `json:"createdAt"`
}

func templatesPath(botID int64, rest string) string {
	return fmt.Sprintf("/api/v1/bots/%d/message-templates%s", botID, rest)
}

func (c *Client) MessageTemplates(ctx context.Context, s Session, botID int64) ([]MessageTemplate, error) {
	var out list[MessageTemplate]
	_, err := c.do(ctx, s, http.MethodGet, templatesPath(botID, ""), nil, &out)
	return out.Items, err
}

func (c *Client) MessageTemplate(ctx context.Context, s Session, botID, id int64) (MessageTemplate, error) {
	var out MessageTemplate
	_, err := c.do(ctx, s, http.MethodGet, templatesPath(botID, fmt.Sprintf("/%d", id)), nil, &out)
	return out, err
}

func (c *Client) CreateMessageTemplate(ctx context.Context, s Session, botID int64, name string, message json.RawMessage) (MessageTemplate, error) {
	var out MessageTemplate
	_, err := c.do(ctx, s, http.MethodPost, templatesPath(botID, ""), map[string]any{"name": name, "message": message}, &out)
	return out, err
}

func (c *Client) RenameMessageTemplate(ctx context.Context, s Session, botID, id int64, name string) error {
	_, err := c.do(ctx, s, http.MethodPut, templatesPath(botID, fmt.Sprintf("/%d", id)), map[string]any{"name": name}, nil)
	return err
}

func (c *Client) DeleteMessageTemplate(ctx context.Context, s Session, botID, id int64) error {
	_, err := c.do(ctx, s, http.MethodDelete, templatesPath(botID, fmt.Sprintf("/%d", id)), nil, nil)
	return err
}

// SendMessageTemplate queues sending to a channel (channelID) or a Discord
// webhook (webhookURL); it returns the job ID.
func (c *Client) SendMessageTemplate(ctx context.Context, s Session, botID, id int64, channelID, webhookURL string) (string, error) {
	in := map[string]string{}
	if channelID != "" {
		in["channelId"] = channelID
	}
	if webhookURL != "" {
		in["webhookUrl"] = webhookURL
	}
	var out Job
	_, err := c.do(ctx, s, http.MethodPost, templatesPath(botID, fmt.Sprintf("/%d/send", id)), in, &out)
	return out.ID, err
}

func (c *Client) Job(ctx context.Context, s Session, id string) (Job, error) {
	var out Job
	_, err := c.do(ctx, s, http.MethodGet, "/api/v1/jobs/"+id, nil, &out)
	return out, err
}
