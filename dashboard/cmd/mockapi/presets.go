package main

import (
	"encoding/json"
	"log/slog"
	"os"
	"path/filepath"
	"time"
)

// Module command copies (shared/command-presets.json), seeded as disabled
// custom commands, one group per module, when a bot is added. Same as
// BotCore\CommandPresets::seed in the API. The dashboard finds a copy by
// name and group (gear button on a module command).

type commandPreset struct {
	Group       string          `json:"group"`
	Name        string          `json:"name"`
	Description string          `json:"description"`
	Graph       json.RawMessage `json:"graph"`
}

func loadCommandPresets() []commandPreset {
	raw, err := os.ReadFile(filepath.Join(envOr("SHARED_DIR", "/shared"), "command-presets.json"))
	if err != nil {
		slog.Warn("mockapi: command presets not found", "err", err)
		return nil
	}
	var doc struct {
		Commands []commandPreset `json:"commands"`
	}
	if err := json.Unmarshal(raw, &doc); err != nil {
		slog.Warn("mockapi: command presets invalid", "err", err)
		return nil
	}
	return doc.Commands
}

// seedPresets adds the preset copies to a bot. Caller holds s.mu.
func (s *store) seedPresets(botID int64) {
	groups := map[string]int64{}
	position := len(s.cmdGroups[botID])
	now := time.Now().UTC()
	for _, p := range s.presets {
		gid, ok := groups[p.Group]
		if !ok {
			s.groupSeq++
			gid = s.groupSeq
			s.cmdGroups[botID] = append(s.cmdGroups[botID], &cmdGroup{ID: gid, Name: p.Group, Position: position})
			position++
			groups[p.Group] = gid
		}
		var g struct {
			Nodes []json.RawMessage `json:"nodes"`
		}
		_ = json.Unmarshal(p.Graph, &g)
		s.cmdSeq++
		c := &customCommand{ID: s.cmdSeq, Name: p.Name, Description: p.Description, GroupID: &gid, UpdatedAt: now, Graph: p.Graph, versionSeq: 1}
		c.versions = []cmdVersion{{ID: 1, SavedAt: now, Nodes: len(g.Nodes), Graph: p.Graph}}
		s.customCmds[botID] = append(s.customCmds[botID], c)
	}
}
