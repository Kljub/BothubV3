package api

import (
	"context"
	"net/http"
	"net/url"
)

// SdkPolicy is one SDK permission with its global switch (admin > SDK Policies).
type SdkPolicy struct {
	Permission  string   `json:"permission"`
	Group       string   `json:"group"`
	Module      string   `json:"module"` // modules.<module>.*: the module ("all" = every module) // main group on the policies page (members, messages, …)
	Risk        string   `json:"risk"`   // low, medium, high
	Calls       []string `json:"calls"`
	Implemented int      `json:"implemented"`
	Mode        string   `json:"mode"`    // allow, default, deny
	Enabled     bool     `json:"enabled"` // what applies now
	Default     bool     `json:"default"`
}

func (c *Client) SdkPolicies(ctx context.Context, s Session) ([]SdkPolicy, error) {
	var out list[SdkPolicy]
	_, err := c.do(ctx, s, http.MethodGet, "/api/v1/admin/sdk-policies", nil, &out)
	return out.Items, err
}

// SetSdkPolicy sets allow (always on), deny (always off) or default (by risk).
func (c *Client) SetSdkPolicy(ctx context.Context, s Session, permission, mode string) ([]SdkPolicy, error) {
	var out list[SdkPolicy]
	_, err := c.do(ctx, s, http.MethodPut, "/api/v1/admin/sdk-policies/"+url.PathEscape(permission), map[string]string{"mode": mode}, &out)
	return out.Items, err
}
