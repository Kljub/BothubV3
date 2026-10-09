package main

import (
	"regexp"
	"strconv"
	"strings"
	"time"
)

// Progress of a running update, read from the helper's log (like a game
// launcher shows it): downloading (git pull --progress: objects, size,
// speed) and installing (docker compose --progress plain build steps
// "[service n/m]", then the switch and restart of the services).

type updateProgress struct {
	Phase           string  `json:"phase"` // download, install, done, failed, rolledback
	DownloadPercent int     `json:"downloadPercent"`
	Received        string  `json:"received,omitempty"` // "12.40 MiB"
	Speed           string  `json:"speed,omitempty"`    // "1.20 MiB/s"
	InstallPercent  int     `json:"installPercent"`
	Step            string  `json:"step,omitempty"` // what runs now
	Percent         int     `json:"percent"`        // both together
	ElapsedSeconds  int     `json:"elapsedSeconds"`
	EtaSeconds      int     `json:"etaSeconds"` // -1 = unknown
	weightDownload  float64 // share of the download in the total
}

var (
	gitProgress = regexp.MustCompile(`(Receiving objects|Resolving deltas):\s+(\d+)%(?:\s+\(\d+/\d+\))?(?:,\s+([\d.]+\s+[KMG]iB)(?:\s+\|\s+([\d.]+\s+[KMG]iB/s))?)?`)
	buildStep   = regexp.MustCompile(`\[([a-z0-9_-]+)\s+(\d+)/(\d+)\]`)
	stepLine    = regexp.MustCompile(`^--- (.+) ---$`)
)

// parseUpdateProgress reads the log of the update helper; started is when
// the helper began (zero when unknown), status its Docker state.
func parseUpdateProgress(log string, started, now time.Time, status string, exitCode int) updateProgress {
	p := updateProgress{Phase: "download", EtaSeconds: -1, weightDownload: 0.2}
	// git writes its progress with \r on one line: every update counts.
	lines := strings.FieldsFunc(log, func(r rune) bool { return r == '\n' || r == '\r' })
	receiving, deltas := 0, 0
	pulled := false
	steps := map[string][2]int{}
	switching, restarting, checking, done, rolledBack := false, false, false, false, false
	for _, raw := range lines {
		line := strings.TrimSpace(raw)
		if m := gitProgress.FindStringSubmatch(line); m != nil {
			n, _ := strconv.Atoi(m[2])
			if m[1] == "Receiving objects" {
				receiving = max(receiving, n)
				if m[3] != "" {
					p.Received = m[3]
				}
				if m[4] != "" {
					p.Speed = m[4]
				}
			} else {
				deltas = max(deltas, n)
			}
			continue
		}
		if strings.HasPrefix(line, "Updating ") || strings.HasPrefix(line, "Fast-forward") || strings.HasPrefix(line, "Already up to date") {
			pulled = true
		}
		if m := buildStep.FindStringSubmatch(line); m != nil {
			pulled = true
			n, _ := strconv.Atoi(m[2])
			total, _ := strconv.Atoi(m[3])
			if total > 0 && n <= total && n > steps[m[1]][0] {
				steps[m[1]] = [2]int{n, total}
				p.Step = line
			}
			continue
		}
		if m := stepLine.FindStringSubmatch(line); m != nil {
			pulled = true
			switch {
			case strings.HasPrefix(m[1], "building"), strings.HasPrefix(m[1], "rebuilding"):
				p.Step = m[1]
			case strings.Contains(m[1], "second BotCore"):
				switching = true
				p.Step = m[1]
			case strings.HasPrefix(m[1], "restarting"), strings.HasPrefix(m[1], "stopping"):
				restarting = true
				p.Step = m[1]
			case strings.HasPrefix(m[1], "checking"):
				checking = true
				p.Step = m[1]
			case strings.HasPrefix(m[1], "backing up"), strings.HasPrefix(m[1], "rolling back"), strings.HasPrefix(m[1], "cleaning up"):
				p.Step = m[1]
			case m[1] == "rolled back":
				rolledBack = true
			case m[1] == "done":
				done = true
			}
		}
	}
	// Download: receiving objects, then resolving deltas; a pull without
	// anything to receive (small update) is complete once git moved on.
	p.DownloadPercent = (receiving*8 + deltas*2) / 10
	if pulled {
		p.DownloadPercent = 100
	}
	// Install: build steps (average over the services) up to 80 %, the
	// switch to the second BotCore 85 %, restart 90 %, done 100 %.
	build := 0.0
	if len(steps) > 0 {
		for _, s := range steps {
			build += float64(s[0]) / float64(s[1])
		}
		build /= float64(len(steps))
	}
	install := build * 80
	if switching {
		install = max(install, 85)
	}
	if restarting {
		install = max(install, 90)
	}
	if checking {
		install = max(install, 95)
	}
	if done {
		install = 100
	}
	p.InstallPercent = int(install)
	if pulled {
		p.Phase = "install"
	}
	finished := status == "exited" || status == "dead"
	if finished {
		if exitCode == 0 {
			p.Phase, p.DownloadPercent, p.InstallPercent = "done", 100, 100
		} else if rolledBack {
			p.Phase = "rolledback"
		} else {
			p.Phase = "failed"
		}
	}
	total := p.weightDownload*float64(p.DownloadPercent) + (1-p.weightDownload)*float64(p.InstallPercent)
	p.Percent = int(total)
	if !started.IsZero() && !finished {
		elapsed := now.Sub(started).Seconds()
		p.ElapsedSeconds = int(elapsed)
		// Estimated from the part done so far (needs a few percent to say anything).
		if total >= 3 && total < 100 {
			p.EtaSeconds = int(elapsed * (100 - total) / total)
		}
	}
	return p
}
