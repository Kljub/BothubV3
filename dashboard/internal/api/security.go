package api

import (
	"context"
	"net/http"
)

// Security Policies (Admin → Security Policies).

type SecurityPolicy struct {
	IPBlocklist      []string `json:"ipBlocklist"`
	Require2FAAdmins bool     `json:"require2faAdmins"`
	Require2FAAll    bool     `json:"require2faAll"`
	LoginMaxFailures int      `json:"loginMaxFailures"`
	LoginLockMinutes int      `json:"loginLockMinutes"`
}

// SecuritySettings: the policy and the address the admin is using (never blockable).
type SecuritySettings struct {
	Policy SecurityPolicy `json:"policy"`
	YourIP string         `json:"yourIp"`
}

func (c *Client) Security(ctx context.Context, s Session) (SecuritySettings, error) {
	var out SecuritySettings
	_, err := c.do(ctx, s, http.MethodGet, "/api/v1/admin/security", nil, &out)
	return out, err
}

func (c *Client) SaveSecurity(ctx context.Context, s Session, in SecurityPolicy) error {
	_, err := c.do(ctx, s, http.MethodPut, "/api/v1/admin/security", in, nil)
	return err
}
