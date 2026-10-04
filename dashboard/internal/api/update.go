package api

import (
	"context"
	"net/http"
)

// Updates from the git repository (gateway updater).

type UpdateRun struct {
	Status     string `json:"status"` // created, running, exited
	ExitCode   int    `json:"exitCode"`
	FinishedAt string `json:"finishedAt"`
	Log        string `json:"log"`
}

type UpdateInfo struct {
	Configured bool       `json:"configured"`
	HostDir    string     `json:"hostDir"`
	Run        *UpdateRun `json:"run"`
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
