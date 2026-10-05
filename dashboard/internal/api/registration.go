package api

import (
	"context"
	"net/http"
)

// Self-registration (Admin → Invite Policies → Registration).

type RegistrationRole struct {
	ID   int64  `json:"id"`
	Key  string `json:"key"`
	Name string `json:"name"`
}

type Registration struct {
	Enabled bool               `json:"enabled"`
	RoleID  int64              `json:"roleId"`
	Roles   []RegistrationRole `json:"roles,omitempty"` // roles new accounts may get
}

// RegistrationOpen is public: whether the login page offers "Create account".
func (c *Client) RegistrationOpen(ctx context.Context) bool {
	var out struct {
		Enabled bool `json:"enabled"`
	}
	if _, err := c.do(ctx, Session{}, http.MethodGet, "/api/v1/auth/registration", nil, &out); err != nil {
		return false
	}
	return out.Enabled
}

func (c *Client) Registration(ctx context.Context, s Session) (Registration, error) {
	var out Registration
	_, err := c.do(ctx, s, http.MethodGet, "/api/v1/admin/registration", nil, &out)
	return out, err
}

func (c *Client) SaveRegistration(ctx context.Context, s Session, in Registration) error {
	_, err := c.do(ctx, s, http.MethodPut, "/api/v1/admin/registration", map[string]any{"enabled": in.Enabled, "roleId": in.RoleID}, nil)
	return err
}

// Register makes an account and signs it in (the session cookie comes in Response).
func (c *Client) Register(ctx context.Context, username, password, email string, opts LoginOptions) (Response, error) {
	in := map[string]any{"username": username, "password": password, "email": email, "remember": opts.Remember, "deviceKey": opts.DeviceKey}
	return c.do(ctx, Session{}, http.MethodPost, "/api/v1/auth/register", in, nil)
}
