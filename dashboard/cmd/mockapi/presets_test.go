package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestSeedPresets(t *testing.T) {
	// The Docker build runs the tests without shared/, so the test brings its own file.
	dir := t.TempDir()
	doc := `{"commands":[
		{"module":"moderation","group":"Moderation","name":"purge","description":"Deletes messages","graph":{"schemaVersion":1,"nodes":[{"id":"trigger"}],"edges":[]}},
		{"module":"moderation","group":"Moderation","name":"kick","description":"Kicks","graph":{"schemaVersion":1,"nodes":[{"id":"trigger"},{"id":"error"}],"edges":[]}},
		{"module":"economy","group":"Economy","name":"balance","description":"Balance","graph":{"schemaVersion":1,"nodes":[{"id":"trigger"}],"edges":[]}}
	]}`
	if err := os.WriteFile(filepath.Join(dir, "command-presets.json"), []byte(doc), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("SHARED_DIR", dir)
	s := &store{customCmds: map[int64][]*customCommand{}, cmdGroups: map[int64][]*cmdGroup{}}
	s.presets = loadCommandPresets()
	s.seedPresets(1)
	if got := len(s.customCmds[1]); got != 3 {
		t.Fatalf("commands = %d, want 3", got)
	}
	if got := len(s.cmdGroups[1]); got != 2 {
		t.Fatalf("groups = %d, want 2", got)
	}
	purge := s.customCmds[1][0]
	if purge.Name != "purge" || purge.GroupID == nil || purge.Enabled || len(purge.Graph) == 0 || len(purge.versions) != 1 {
		t.Fatalf("purge copy wrong: %+v", purge)
	}
	if g := s.cmdGroups[1][0]; g.ID != *purge.GroupID || g.Name != "Moderation" {
		t.Fatalf("purge group = %+v", g)
	}
	if kick := s.customCmds[1][1]; *kick.GroupID != *purge.GroupID || kick.versions[0].Nodes != 2 {
		t.Fatalf("kick copy wrong: %+v", kick)
	}
}
