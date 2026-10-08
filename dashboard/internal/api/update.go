package api

import (
	"context"
	"net/http"
	"time"
)

// Updates from the git repository (gateway updater).

type UpdateRun struct {
	Status     string `json:"status"` // created, running, exited
	ExitCode   int    `json:"exitCode"`
	FinishedAt string `json:"finishedAt"`
	Log        string `json:"log"`
	// Progress read from the log (download, install, time left).
	Progress *UpdateProgress `json:"progress"`
}

type UpdateProgress struct {
	Phase           string `json:"phase"` // download, install, done, failed
	DownloadPercent int    `json:"downloadPercent"`
	Received        string `json:"received"`
	Speed           string `json:"speed"`
	InstallPercent  int    `json:"installPercent"`
	Step            string `json:"step"`
	Percent         int    `json:"percent"`
	ElapsedSeconds  int    `json:"elapsedSeconds"`
	EtaSeconds      int    `json:"etaSeconds"`
}

type UpdateInfo struct {
	Configured    bool             `json:"configured"`
	HostDir       string           `json:"hostDir"`
	Repo          string           `json:"repo"`
	Branch        string           `json:"branch"`
	DockerDesktop bool             `json:"dockerDesktop"`
	Run           *UpdateRun       `json:"run"`
	LastCheck     *UpdateLastCheck `json:"lastCheck"`
}

// UpdateLastCheck: the gateway's last check (manual, daily or quiet every 6 hours).
type UpdateLastCheck struct {
	At      time.Time `json:"at"`
	Behind  int       `json:"behind"`
	Current string    `json:"current"`
	Remote  string    `json:"remote"`
}

type UpdateCheck struct {
	Configured bool     `json:"configured"`
	Current    string   `json:"current"`
	Remote     string   `json:"remote"`
	Behind     int      `json:"behind"`
	Commits    []string `json:"commits"`
	Error      string   `json:"error"`
}

func (c *Client) UpdateInfo(ctx context.Context, s Session) (UpdateInfo, error) {
	var out UpdateInfo
	_, err := c.do(ctx, s, http.MethodGet, "/api/v1/admin/update", nil, &out)
	return out, err
}

func (c *Client) CheckUpdate(ctx context.Context, s Session) (UpdateCheck, error) {
	var out UpdateCheck
	_, err := c.do(ctx, s, http.MethodPost, "/api/v1/admin/update/check", nil, &out)
	return out, err
}

func (c *Client) RunUpdate(ctx context.Context, s Session) error {
	_, err := c.do(ctx, s, http.MethodPost, "/api/v1/admin/update/run", nil, nil)
	return err
}
