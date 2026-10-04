package main

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"
)

// Updates from the git repository (Admin → Server settings → Updates).
// The gateway talks to the Docker Engine through its socket and starts a
// short-lived helper container (docker:cli with git) that runs
//
//	git pull --ff-only && docker compose up -d --build
//
// in the repository. The helper runs on its own, so it finishes even when
// the update restarts the dashboard and this gateway. Needs:
//
//	/var/run/docker.sock   mounted into this container (group via DOCKER_GID)
//	BOTHUB_HOST_DIR        the repository's path on the host, mounted at the
//	                       same path into the helper (so ./data in the compose
//	                       file means the same folder). Docker Desktop on
//	                       Windows: /run/desktop/mnt/host/d/path/to/Bothub
//	BOTHUB_GIT_TOKEN       optional, for a private GitHub repository

const (
	dockerSock    = "/var/run/docker.sock"
	updaterImage  = "docker:cli"
	updaterName   = "bothub-updater"
	checkerName   = "bothub-update-check"
	updateTimeout = 2 * time.Minute
)

type updater struct {
	hostDir string
	token   string
	http    *http.Client
}

func newUpdater() *updater {
	dir := strings.TrimRight(os.Getenv("BOTHUB_HOST_DIR"), "/")
	if dir == "" {
		return nil
	}
	if _, err := os.Stat(dockerSock); err != nil {
		return nil
	}
	tr := &http.Transport{DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
		return (&net.Dialer{}).DialContext(ctx, "unix", dockerSock)
	}}
	return &updater{hostDir: dir, token: os.Getenv("BOTHUB_GIT_TOKEN"), http: &http.Client{Transport: tr, Timeout: 5 * time.Minute}}
}

// docker calls the Engine API; out (optional) gets the JSON answer.
func (u *updater) docker(ctx context.Context, method, path string, body, out any) (int, error) {
	var payload io.Reader
	if body != nil {
		b, _ := json.Marshal(body)
		payload = bytes.NewReader(b)
	}
	req, err := http.NewRequestWithContext(ctx, method, "http://docker"+path, payload)
	if err != nil {
		return 0, err
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := u.http.Do(req)
	if err != nil {
		return 0, err
	}
	defer resp.Body.Close()
	data, _ := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
	if resp.StatusCode >= 400 {
		return resp.StatusCode, fmt.Errorf("docker %s %s: %d %s", method, path, resp.StatusCode, strings.TrimSpace(string(data)))
	}
	if out != nil && len(data) > 0 {
		_ = json.Unmarshal(data, out)
	}
	return resp.StatusCode, nil
}

// script: git with the optional token, then the given commands.
func (u *updater) script(commands string) string {
	auth := ""
	if u.token != "" {
		basic := base64.StdEncoding.EncodeToString([]byte("x-access-token:" + u.token))
		auth = fmt.Sprintf(`git config --global http.https://github.com/.extraheader "Authorization: Basic %s" && `, basic)
	}
	return "set -e; apk add -q --no-cache git >/dev/null; git config --global --add safe.directory '*'; " + auth + "cd '" + strings.ReplaceAll(u.hostDir, "'", "") + "'; " + commands
}

// run starts a helper container; wait: until it ends (answers its output).
func (u *updater) run(ctx context.Context, name, commands string, wait bool) (string, int, error) {
	if _, err := u.docker(ctx, http.MethodPost, "/images/create?fromImage=docker&tag=cli", nil, nil); err != nil {
		return "", 0, err
	}
	_, _ = u.docker(ctx, http.MethodDelete, "/containers/"+name+"?force=true", nil, nil)
	spec := map[string]any{
		"Image": updaterImage, "Cmd": []string{"sh", "-c", u.script(commands)}, "WorkingDir": u.hostDir,
		"Labels":     map[string]string{"bothub.role": "updater"},
		"HostConfig": map[string]any{"Binds": []string{dockerSock + ":" + dockerSock, u.hostDir + ":" + u.hostDir}},
	}
	var created struct{ ID string }
	if _, err := u.docker(ctx, http.MethodPost, "/containers/create?name="+url.QueryEscape(name), spec, &created); err != nil {
		return "", 0, err
	}
	if _, err := u.docker(ctx, http.MethodPost, "/containers/"+created.ID+"/start", nil, nil); err != nil {
		return "", 0, err
	}
	if !wait {
		return "", 0, nil
	}
	var result struct{ StatusCode int }
	if _, err := u.docker(ctx, http.MethodPost, "/containers/"+created.ID+"/wait", nil, &result); err != nil {
		return "", 0, err
	}
	out, _ := u.logs(ctx, created.ID)
	_, _ = u.docker(ctx, http.MethodDelete, "/containers/"+created.ID+"?force=true", nil, nil)
	return out, result.StatusCode, nil
}

// logs reads stdout and stderr of a container (the multiplexed stream).
func (u *updater) logs(ctx context.Context, id string) (string, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, "http://docker/containers/"+id+"/logs?stdout=1&stderr=1&tail=400", nil)
	if err != nil {
		return "", err
	}
	resp, err := u.http.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 2<<20))
	var out strings.Builder
	for len(raw) >= 8 {
		n := int(binary.BigEndian.Uint32(raw[4:8]))
		if raw[0] > 2 || 8+n > len(raw) {
			out.Write(raw) // not multiplexed (TTY)
			break
		}
		out.Write(raw[8 : 8+n])
		raw = raw[8+n:]
	}
	return out.String(), nil
}

// --- routes ---

type updateCheck struct {
	Configured bool     `json:"configured"`
	Current    string   `json:"current,omitempty"`
	Remote     string   `json:"remote,omitempty"`
	Behind     int      `json:"behind"`
	Commits    []string `json:"commits"`
	Error      string   `json:"error,omitempty"`
}

// getUpdate: whether updates can run here, and the state of the last run.
func (s *store) getUpdate(w http.ResponseWriter, r *http.Request, _ string) {
	if s.updater == nil {
		writeJSON(w, 200, map[string]any{"configured": false})
		return
	}
	var info struct {
		State struct {
			Status   string `json:"Status"`
			ExitCode int    `json:"ExitCode"`
			Finished string `json:"FinishedAt"`
		}
	}
	out := map[string]any{"configured": true, "hostDir": s.updater.hostDir}
	if code, err := s.updater.docker(r.Context(), http.MethodGet, "/containers/"+updaterName+"/json", nil, &info); err == nil && code == 200 {
		logs, _ := s.updater.logs(r.Context(), updaterName)
		out["run"] = map[string]any{"status": info.State.Status, "exitCode": info.State.ExitCode, "finishedAt": info.State.Finished, "log": logs}
	}
	writeJSON(w, 200, out)
}

// checkUpdate: git fetch, then which commits are new.
func (s *store) checkUpdate(w http.ResponseWriter, r *http.Request, _ string) {
	if s.updater == nil {
		writeJSON(w, 200, updateCheck{})
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), updateTimeout)
	defer cancel()
	out, code, err := s.updater.run(ctx, checkerName,
		`git fetch -q && echo "HEAD=$(git rev-parse --short HEAD)" && echo "REMOTE=$(git rev-parse --short @{u})" && echo "BEHIND=$(git rev-list --count HEAD..@{u})" && git log --format='LOG=%h %s' HEAD..@{u} | head -30`, true)
	res := updateCheck{Configured: true, Commits: []string{}}
	switch {
	case err != nil:
		res.Error = err.Error()
	case code != 0:
		res.Error = strings.TrimSpace(lastLines(out, 6))
		if strings.Contains(res.Error, "could not read Username") && s.updater.token == "" {
			res.Error += " (private repository: set BOTHUB_GIT_TOKEN)"
		}
	default:
		for _, line := range strings.Split(out, "\n") {
			k, v, _ := strings.Cut(strings.TrimSpace(line), "=")
			switch k {
			case "HEAD":
				res.Current = v
			case "REMOTE":
				res.Remote = v
			case "BEHIND":
				fmt.Sscanf(v, "%d", &res.Behind)
			case "LOG":
				res.Commits = append(res.Commits, v)
			}
		}
	}
	writeJSON(w, 200, res)
}

// runUpdate starts the helper that pulls and rebuilds; it runs on its own.
func (s *store) runUpdate(w http.ResponseWriter, r *http.Request, _ string) {
	if s.updater == nil {
		apiError(w, 409, "error.update.not_configured")
		return
	}
	var info struct{ State struct{ Running bool } }
	if code, err := s.updater.docker(r.Context(), http.MethodGet, "/containers/"+updaterName+"/json", nil, &info); err == nil && code == 200 && info.State.Running {
		apiError(w, 409, "error.update.running")
		return
	}
	user := s.requestUserName(r)
	if _, _, err := s.updater.run(r.Context(), updaterName, `echo "Update by `+strings.ReplaceAll(user, `"`, "")+` at $(date -u +%FT%TZ)"; git pull --ff-only && echo "--- rebuilding ---" && docker compose up -d --build --remove-orphans && echo "--- done ---"`, false); err != nil {
		apiErrorParams(w, 502, "error.update.failed", map[string]any{"reason": truncate(err.Error(), 200)})
		return
	}
	s.mu.Lock()
	s.addServerLog(time.Now(), "change", "", "log.server.update_started", "api", user, nil, nil)
	s.mu.Unlock()
	writeJSON(w, 202, map[string]any{"started": true})
}

func lastLines(s string, n int) string {
	lines := strings.Split(strings.TrimRight(s, "\n"), "\n")
	if len(lines) > n {
		lines = lines[len(lines)-n:]
	}
	return strings.Join(lines, "\n")
}
