package api

import (
	"context"
	"fmt"
	"net/http"
	"net/url"
	"time"
)

// PluginTask is one plugin process of a bot in the task manager.
type PluginTask struct {
	PluginID       string     `json:"pluginId"`
	Name           string     `json:"name"`
	Version        string     `json:"version"`
	State          string     `json:"state"` // starting, running, restarting, stopped, crashed, killed, failed
	PID            *int       `json:"pid"`
	StartedAt      *time.Time `json:"startedAt"`
	Restarts       int        `json:"restarts"` // last 10 minutes
	Calls          int64      `json:"calls"`
	CallsPerMinute int        `json:"callsPerMinute"`
	MemoryBytes    *int64     `json:"memoryBytes"`
	CPUPercent     *float64   `json:"cpuPercent"`
	Reason         *string    `json:"reason"`
}

// PluginTasks is the bot's last report (every 5 s); Running is false while
// the bot does not run.
type PluginTasks struct {
	Running bool         `json:"running"`
	At      *time.Time   `json:"at"`
	Tasks   []PluginTask `json:"tasks"`
}

func (c *Client) PluginTasks(ctx context.Context, s Session, botID int64) (PluginTasks, error) {
	var out PluginTasks
	_, err := c.do(ctx, s, http.MethodGet, fmt.Sprintf("/api/v1/bots/%d/plugin-tasks", botID), nil, &out)
	return out, err
}

// PluginTaskAction ends ("kill") or restarts ("restart") a plugin process.
func (c *Client) PluginTaskAction(ctx context.Context, s Session, botID int64, pluginID, action string) (Job, error) {
	var out Job
	_, err := c.do(ctx, s, http.MethodPost, fmt.Sprintf("/api/v1/bots/%d/plugin-tasks/%s/%s", botID, url.PathEscape(pluginID), url.PathEscape(action)), nil, &out)
	return out, err
}
