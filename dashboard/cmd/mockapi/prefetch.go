package main

import (
	"context"
	"fmt"
	"log/slog"
	"net/http"
	"strings"
	"time"
)

// Background preparation of updates: as soon as a check finds new commits,
// a helper container builds the images of the new version next to the
// running BotHub (a git worktree of FETCH_HEAD in the helper's /tmp, the
// same compose project name, so the images get the same names). Nothing
// restarts. The update itself then finds every layer in the build cache and
// only restarts the services: a click on "Update" (or auto-update "instant")
// takes moments instead of a full build.

const prefetchName = "bothub-update-prefetch"

// prefetchState: what the last preparation did (part of updateState).
type prefetchState struct {
	remote string // the commit being or last prepared
	status string // running, ready, failed
	at     time.Time
}

// startPrefetch builds the images of remote in the background. Caller does not hold s.mu.
func (s *store) startPrefetch(ctx context.Context, remote string) {
	failed := func(err error) {
		// "instant" then installs without preparation (the update builds itself).
		slog.Warn("mockapi: update not prepared", "err", err)
		s.mu.Lock()
		s.updateState.prefetch = prefetchState{remote: remote, status: "failed", at: time.Now()}
		s.mu.Unlock()
	}
	project, err := s.updater.ownProject(ctx)
	if err != nil || project == "" || !safeRef.MatchString(project) {
		failed(fmt.Errorf("compose project %q: %v", project, err))
		return
	}
	host := strings.ReplaceAll(s.updater.hostDir, "'", "")
	script := `git worktree prune; git fetch -q "$SRC" "$REF"; R=$(git rev-parse --short FETCH_HEAD); echo "PREFETCH=$R"; ` +
		`rm -rf /tmp/pf; git worktree add -f --detach /tmp/pf FETCH_HEAD >/dev/null; cp '` + host + `/.env' /tmp/pf/ 2>/dev/null || true; cd /tmp/pf; ` +
		`docker compose -p '` + project + `' --progress plain build; cd /; git -C '` + host + `' worktree remove --force /tmp/pf; echo "PREFETCHED=$R"`
	if _, _, err := s.updater.run(ctx, prefetchName, script, false); err != nil {
		failed(err)
		return
	}
	s.mu.Lock()
	s.updateState.prefetch = prefetchState{remote: remote, status: "running", at: time.Now()}
	s.mu.Unlock()
}

// prefetchTick: the state of a running preparation; a new one when the
// check found a commit that is not prepared yet. Caller does not hold s.mu.
func (s *store) prefetchTick(ctx context.Context, behind int, remote string) {
	s.mu.Lock()
	p := s.updateState.prefetch
	s.mu.Unlock()
	if p.status == "running" {
		var info struct {
			State struct {
				Status   string
				ExitCode int
			}
		}
		code, err := s.updater.docker(ctx, http.MethodGet, "/containers/"+prefetchName+"/json", nil, &info)
		if err != nil || code == 200 && info.State.Status == "running" {
			return // docker not reachable now, or still building
		}
		logs, _ := s.updater.logs(ctx, prefetchName)
		p.status = "failed"
		if info.State.ExitCode == 0 && strings.Contains(logs, "PREFETCHED="+p.remote) {
			p.status = "ready"
		} else {
			slog.Warn("mockapi: update preparation failed", "log", lastLines(logs, 6))
		}
		_, _ = s.updater.docker(ctx, http.MethodDelete, "/containers/"+prefetchName+"?force=true", nil, nil)
		s.mu.Lock()
		s.updateState.prefetch = p
		s.mu.Unlock()
		return
	}
	if behind > 0 && remote != "" && p.remote != remote && !s.updateRunning(ctx) {
		s.startPrefetch(ctx, remote)
	}
}

// updateRunning: the update helper runs right now.
func (s *store) updateRunning(ctx context.Context) bool {
	var info struct{ State struct{ Running bool } }
	code, err := s.updater.docker(ctx, http.MethodGet, "/containers/"+updaterName+"/json", nil, &info)
	return err == nil && code == 200 && info.State.Running
}

// prefetchView: for the admin page.
func (p prefetchState) view() map[string]any {
	if p.remote == "" {
		return nil
	}
	return map[string]any{"remote": p.remote, "status": p.status, "at": p.at}
}
