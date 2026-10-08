package main

import (
	"testing"
	"time"
)

func TestUpdateProgress(t *testing.T) {
	start := time.Date(2026, 10, 8, 20, 0, 0, 0, time.UTC)
	p := parseUpdateProgress("Update by admin\nfrom x (main)\nReceiving objects:  45% (90/200), 1.20 MiB | 600.00 KiB/s\r", start, start.Add(10*time.Second), "running", 0)
	if p.Phase != "download" || p.DownloadPercent != 36 || p.Received != "1.20 MiB" || p.Speed != "600.00 KiB/s" || p.InstallPercent != 0 {
		t.Fatalf("download: %+v", p)
	}
	log := "Receiving objects: 100% (200/200), 2.50 MiB | 1.10 MiB/s, done.\rResolving deltas: 100% (50/50), done.\nUpdating a1..b2\nFast-forward\n--- building ---\n#5 [bot 3/8] RUN npm ci\n#9 [app 4/4] COPY . .\n"
	p = parseUpdateProgress(log, start, start.Add(60*time.Second), "running", 0)
	if p.Phase != "install" || p.DownloadPercent != 100 || p.InstallPercent != int((3.0/8+1)/2*80) || p.EtaSeconds <= 0 {
		t.Fatalf("install: %+v", p)
	}
	p = parseUpdateProgress(log+"--- restarting ---\n", start, start.Add(90*time.Second), "running", 0)
	if p.InstallPercent != 90 {
		t.Fatalf("restart: %+v", p)
	}
	p = parseUpdateProgress(log+"--- done ---\n", start, start.Add(95*time.Second), "exited", 0)
	if p.Phase != "done" || p.Percent != 100 {
		t.Fatalf("done: %+v", p)
	}
	if p = parseUpdateProgress(log, start, start, "exited", 1); p.Phase != "failed" {
		t.Fatalf("failed: %+v", p)
	}
}
