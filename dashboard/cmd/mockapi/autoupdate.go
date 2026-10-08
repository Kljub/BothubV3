package main

import (
	"context"
	"log/slog"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"
	_ "time/tzdata" // the update hour is local time (TZ); the image has no zoneinfo
)

// Automatic updates and the restart policy (Admin → Server settings).
//
// autoUpdate: "off", "check" (look once a day at autoUpdateHour; admins see
// a warning when commits are waiting) or "install" (also start the update
// right away). The restart policy ("unless-stopped", "always" or "no") is
// set on all containers of this compose project through the Docker socket;
// "always" and "unless-stopped" bring BotHub back after a reboot as soon as
// Docker itself runs. A rebuild takes the policy of the compose file, so the
// gateway puts it back at start and on every tick.

const autoUpdateTick = 5 * time.Minute

// quietCheckEvery: how often the gateway looks for new commits on its own.
const quietCheckEvery = 30 * time.Minute

var restartPolicies = []string{"unless-stopped", "always", "no"}

// updateState is what the last automatic check found.
type updateState struct {
	checkedAt time.Time
	behind    int
	current   string // commit here and the newest one of the last check
	remote    string
	day       string // the local date of the last automatic check
}

// loadServerSettings reads the stored instance settings at start.
func (s *store) loadServerSettings() {
	if s.php == nil {
		return
	}
	in := defaultServerSettings()
	out := struct{ Value *serverSettings }{&in}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := s.php.do(ctx, http.MethodGet, "/internal/settings/server", nil, &out); err != nil {
		slog.Error("mockapi: server settings not loaded", "err", err)
		return
	}
	in.RestartRequired = false
	normalizeServerSettings(&in)
	s.mu.Lock()
	s.srvSettings = in
	s.activePorts = [3]int{in.PublicPort, in.APIPort, in.RedisPort}
	s.mu.Unlock()
}

// normalizeServerSettings fills values older settings did not have.
func normalizeServerSettings(in *serverSettings) {
	if in.AutoUpdate == "" {
		in.AutoUpdate = "off"
	}
	if in.RestartPolicy == "" {
		in.RestartPolicy = "unless-stopped"
	}
}

func (s *store) persistServerSettings(in serverSettings) {
	if s.php == nil {
		return
	}
	in.RestartRequired = false
	go s.phpSync(http.MethodPut, "/internal/settings/server", in)
}

// runAutoUpdates is the background loop: restart policy, daily check, install.
func (s *store) runAutoUpdates() {
	if s.updater == nil {
		return
	}
	for {
		s.autoUpdateTick(time.Now())
		time.Sleep(autoUpdateTick)
	}
}

func (s *store) autoUpdateTick(now time.Time) {
	s.mu.Lock()
	set := s.srvSettings
	due := set.AutoUpdate != "off" && now.Hour() == set.AutoUpdateHour && s.updateState.day != now.Format("2006-01-02")
	if due {
		s.updateState.day = now.Format("2006-01-02")
	}
	// Besides the daily automatic update, a quiet check every 30 minutes
	// keeps "Update available" in the admin sidebar current.
	quiet := !due && now.Sub(s.updateState.checkedAt) >= quietCheckEvery
	s.mu.Unlock()

	ctx, cancel := context.WithTimeout(context.Background(), updateTimeout)
	defer cancel()
	if err := s.updater.applyRestartPolicy(ctx, set.RestartPolicy); err != nil {
		slog.Warn("mockapi: restart policy not applied", "err", err)
	}
	if !due && !quiet {
		return
	}
	res := s.checkForUpdates(ctx)
	s.mu.Lock()
	if res.Error == "" {
		s.updateState.current, s.updateState.remote = res.Current, res.Remote
	}
	if !due {
		s.updateState.checkedAt = now
		if res.Error == "" {
			s.updateState.behind = res.Behind
		}
		s.mu.Unlock()
		return
	}
	s.updateState.checkedAt, s.updateState.behind = now, res.Behind
	if res.Error != "" {
		s.addServerLog(now, "warning", "", "log.server.update_check_failed", "api", "auto", map[string]any{"reason": truncate(res.Error, 200)}, nil)
	} else if res.Behind > 0 {
		s.addServerLog(now, "update", "", "log.server.update_available", "api", "auto", map[string]any{"count": res.Behind}, nil)
	}
	s.mu.Unlock()
	if set.AutoUpdate == "install" && res.Error == "" && res.Behind > 0 {
		if err := s.startUpdate(ctx, "auto"); err != nil {
			slog.Error("mockapi: automatic update failed", "err", err)
		}
	}
}

// applyRestartPolicy sets the policy on every container of this compose
// project whose policy differs.
func (u *updater) applyRestartPolicy(ctx context.Context, policy string) error {
	project, err := u.ownProject(ctx)
	if err != nil || project == "" {
		return err
	}
	var list []struct {
		ID         string
		HostConfig struct{ RestartPolicy struct{ Name string } }
	}
	filter := url.QueryEscape(`{"label":["com.docker.compose.project=` + project + `"]}`)
	if _, err := u.docker(ctx, http.MethodGet, "/containers/json?all=1&filters="+filter, nil, &list); err != nil {
		return err
	}
	for _, c := range list {
		var info struct {
			HostConfig struct{ RestartPolicy struct{ Name string } }
		}
		if _, err := u.docker(ctx, http.MethodGet, "/containers/"+c.ID+"/json", nil, &info); err != nil {
			return err
		}
		if info.HostConfig.RestartPolicy.Name == policy {
			continue
		}
		body := map[string]any{"RestartPolicy": map[string]any{"Name": policy}}
		if _, err := u.docker(ctx, http.MethodPost, "/containers/"+c.ID+"/update", body, nil); err != nil {
			return err
		}
	}
	return nil
}

// ownProject is the compose project of this container (its hostname is the
// container ID).
func (u *updater) ownProject(ctx context.Context) (string, error) {
	host, _ := os.Hostname()
	var self struct {
		Config struct{ Labels map[string]string }
	}
	if _, err := u.docker(ctx, http.MethodGet, "/containers/"+url.PathEscape(host)+"/json", nil, &self); err != nil {
		return "", err
	}
	return self.Config.Labels["com.docker.compose.project"], nil
}

// dockerDesktop: Docker runs in Docker Desktop (it must start with the
// system login for containers to come back after a reboot).
func (u *updater) dockerDesktop(ctx context.Context) bool {
	var info struct{ OperatingSystem string }
	if _, err := u.docker(ctx, http.MethodGet, "/info", nil, &info); err != nil {
		return false
	}
	return strings.Contains(info.OperatingSystem, "Docker Desktop")
}
