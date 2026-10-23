package api

import (
	"context"
	"net/http"
	"net/url"
)

// Web Verify ("web-verify"): the public page /verify/<token> where members
// sign in with the bot's Discord application; the API checks the address
// the page was opened from (sent along as X-BotHub-Client-IP).

// VerifyPage is the public data of /verify/<token>.
type VerifyPage struct {
	BotName       string  `json:"botName"`
	AvatarURL     *string `json:"avatarUrl"`
	ApplicationID string  `json:"applicationId"`
	// VPNCheck: the address goes to proxycheck.io (the page says so).
	VPNCheck bool `json:"vpnCheck"`
}

// VerifyResult is what the member sees after the sign-in: status passed,
// review, blocked or retry; reasons e.g. "vpn", "tor", "alt", "country".
type VerifyResult struct {
	BotName string   `json:"botName"`
	Status  string   `json:"status"`
	Reasons []string `json:"reasons"`
}

// VerifyPageData is public: the link must be open and the module set up.
func (c *Client) VerifyPageData(ctx context.Context, token string) (VerifyPage, error) {
	var out VerifyPage
	_, err := c.do(ctx, Session{}, http.MethodGet, "/api/v1/verify/"+url.PathEscape(token), nil, &out)
	return out, err
}

// VerifyCheck trades the sign-in code and runs the checks (public; the code is the proof).
func (c *Client) VerifyCheck(ctx context.Context, token, code, redirectURI string) (VerifyResult, error) {
	var out VerifyResult
	_, err := c.do(ctx, Session{}, http.MethodPost, "/api/v1/verify/"+url.PathEscape(token)+"/check", map[string]string{"code": code, "redirectUri": redirectURI}, &out)
	return out, err
}
