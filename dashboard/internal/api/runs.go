package api

import (
	"context"
	"fmt"
	"net/http"
	"net/url"
	"time"
)

// Playbacks and errors: runs of commands and custom events recorded by the bot.

// RunHint is the plain-language reason of a failed block (shared/run-errors.json).
type RunHint struct {
	Key    string            `json:"key"`
	Params map[string]string `json:"params"`
	Text   string            `json:"text"`
	Fix    string            `json:"fix"`
}

type Run struct {
	ID          int64     `json:"id"`
	CommandID   int64     `json:"command_id"`
	CommandName string    `json:"command_name"`
	CommandKind string    `json:"command_kind"`
	Time        time.Time `json:"time"`
	Source      string    `json:"source"`
	UserID      *string   `json:"user_id"`
	UserName    *string   `json:"user_name"`
	GuildName   *string   `json:"guild_name"`
	ChannelName *string   `json:"channel_name"`
	OK          bool      `json:"ok"`
	ErrorNode   *string   `json:"error_node"`
	ErrorKey    *string   `json:"error_key"`
	ErrorHint   *RunHint  `json:"error_hint"`
	ErrorText   *string   `json:"error_text"`
	Muted       bool      `json:"muted"`
	Fixed       bool      `json:"fixed"`
}

// RunErrors lists the failed runs of the last 7 days that are not dismissed.
func (c *Client) RunErrors(ctx context.Context, s Session, botID int64, withMuted bool) ([]Run, error) {
	q := url.Values{"errors": {"1"}, "limit": {"200"}}
	if withMuted {
		q.Set("muted", "1")
	}
	var out list[Run]
	_, err := c.do(ctx, s, http.MethodGet, fmt.Sprintf("/api/v1/bots/%d/runs?%s", botID, q.Encode()), nil, &out)
	return out.Items, err
}

func (c *Client) DismissRun(ctx context.Context, s Session, botID, runID int64) error {
	_, err := c.do(ctx, s, http.MethodPost, fmt.Sprintf("/api/v1/bots/%d/runs/%d/dismiss", botID, runID), map[string]any{}, nil)
	return err
}

func (c *Client) DismissAllRuns(ctx context.Context, s Session, botID int64) error {
	_, err := c.do(ctx, s, http.MethodPost, fmt.Sprintf("/api/v1/bots/%d/runs/dismiss-all", botID), map[string]any{}, nil)
	return err
}

func (c *Client) MuteRun(ctx context.Context, s Session, botID, runID int64, muted bool) error {
	_, err := c.do(ctx, s, http.MethodPost, fmt.Sprintf("/api/v1/bots/%d/runs/%d/mute", botID, runID), map[string]bool{"muted": muted}, nil)
	return err
}
