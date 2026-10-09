package api

import (
	"context"
	"net/http"
	"time"
)

// RecoveryKey: whether the instance has one (Admin → Security).
type RecoveryKey struct {
	Set       bool       `json:"set"`
	CreatedAt *time.Time `json:"createdAt"`
	CreatedBy string     `json:"createdBy"`
}

func (c *Client) RecoveryKey(ctx context.Context, s Session) (RecoveryKey, error) {
	var out RecoveryKey
	_, err := c.do(ctx, s, http.MethodGet, "/api/v1/admin/recovery-key", nil, &out)
	return out, err
}

// NewRecoveryKey creates a key (an old one stops working); the plain key comes only here.
func (c *Client) NewRecoveryKey(ctx context.Context, s Session) (string, error) {
	var out struct {
		Key string `json:"key"`
	}
	_, err := c.do(ctx, s, http.MethodPost, "/api/v1/admin/recovery-key", map[string]any{}, &out)
	return out.Key, err
}
