package api

import (
	"context"
	"net/http"
	"net/url"
	"time"
)

// Mobile app: phones paired with the account (gateway mobile.go).

// MobileDevice is a paired phone (never its token or key).
type MobileDevice struct {
	ID         string    `json:"id"`
	Name       string    `json:"name"`
	Platform   string    `json:"platform"`
	AppVersion string    `json:"appVersion"`
	IP         string    `json:"ip"`
	Push       bool      `json:"push"`
	Notify     []string  `json:"notify"`
	Guard      bool      `json:"guard"`
	CreatedAt  time.Time `json:"createdAt"`
	LastSeenAt time.Time `json:"lastSeenAt"`
}

// MobilePairing is an open pairing code for the QR code.
type MobilePairing struct {
	ID        string    `json:"id"`
	Code      string    `json:"code"`
	ExpiresAt time.Time `json:"expiresAt"`
}

// MobilePairingStatus tells whether a phone used the code.
type MobilePairingStatus struct {
	Paired    bool          `json:"paired"`
	Expired   bool          `json:"expired"`
	ExpiresAt time.Time     `json:"expiresAt"`
	Device    *MobileDevice `json:"device"`
}

func (c *Client) MobileDevices(ctx context.Context, s Session) ([]MobileDevice, error) {
	var out list[MobileDevice]
	_, err := c.do(ctx, s, http.MethodGet, "/api/v1/account/devices", nil, &out)
	return out.Items, err
}

func (c *Client) StartMobilePairing(ctx context.Context, s Session) (MobilePairing, error) {
	var out MobilePairing
	_, err := c.do(ctx, s, http.MethodPost, "/api/v1/account/devices/pairing", map[string]any{}, &out)
	return out, err
}

func (c *Client) MobilePairingState(ctx context.Context, s Session, id string) (MobilePairingStatus, error) {
	var out MobilePairingStatus
	_, err := c.do(ctx, s, http.MethodGet, "/api/v1/account/devices/pairing/"+url.PathEscape(id), nil, &out)
	return out, err
}

func (c *Client) UpdateMobileDevice(ctx context.Context, s Session, id string, name *string, notify *[]string) error {
	body := map[string]any{}
	if name != nil {
		body["name"] = *name
	}
	if notify != nil {
		body["notify"] = *notify
	}
	_, err := c.do(ctx, s, http.MethodPatch, "/api/v1/account/devices/"+url.PathEscape(id), body, nil)
	return err
}

// SetMobileGuard switches BotHub Guard (sign-in approval) on or off for a phone.
func (c *Client) SetMobileGuard(ctx context.Context, s Session, id string, on bool) error {
	_, err := c.do(ctx, s, http.MethodPatch, "/api/v1/account/devices/"+url.PathEscape(id), map[string]any{"guard": on}, nil)
	return err
}

func (c *Client) DeleteMobileDevice(ctx context.Context, s Session, id string) error {
	_, err := c.do(ctx, s, http.MethodDelete, "/api/v1/account/devices/"+url.PathEscape(id), nil, nil)
	return err
}
