package main

import (
	"encoding/json"
	"net/http"
	"slices"
	"strconv"
	"strings"
	"time"
)

// Command groups (folders on the custom commands page), recently deleted
// commands (kept 30 days) and restoring a saved version.

type cmdGroup struct {
	ID          int64  `json:"id"`
	Name        string `json:"name"`
	Description string `json:"description"`
	Position    int    `json:"position"`
	Commands    int    `json:"commands"`
}

type deletedCmd struct {
	cmd       *customCommand
	deletedAt time.Time
}

const keepDeleted = 30 * 24 * time.Hour

func (s *store) groupsOf(botID int64) []cmdGroup {
	out := []cmdGroup{}
	for _, g := range s.cmdGroups[botID] {
		gg := *g
		gg.Commands = 0
		for _, c := range s.customCmds[botID] {
			if c.GroupID != nil && *c.GroupID == g.ID {
				gg.Commands++
			}
		}
		out = append(out, gg)
	}
	slices.SortStableFunc(out, func(a, b cmdGroup) int { return a.Position - b.Position })
	return out
}

func (s *store) listGroups(w http.ResponseWriter, r *http.Request, b *bot) {
	s.mu.Lock()
	defer s.mu.Unlock()
	writeJSON(w, 200, map[string]any{"items": s.groupsOf(b.ID)})
}

type groupInput struct {
	Name        string `json:"name"`
	Description string `json:"description"`
	Position    int    `json:"position"`
}

func (in *groupInput) valid() bool {
	in.Name, in.Description = strings.TrimSpace(in.Name), strings.TrimSpace(in.Description)
	return in.Name != "" && len([]rune(in.Name)) <= 40 && len([]rune(in.Description)) <= 200 && in.Position >= 0 && in.Position <= 999
}

func (s *store) createGroup(w http.ResponseWriter, r *http.Request, b *bot) {
	var in groupInput
	if !readJSON(w, r, &in) {
		return
	}
	if !in.valid() {
		apiError(w, 422, "error.group.invalid")
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if len(s.cmdGroups[b.ID]) >= 50 {
		apiError(w, 422, "error.group.limit")
		return
	}
	s.groupSeq++
	g := &cmdGroup{ID: s.groupSeq, Name: in.Name, Description: in.Description, Position: in.Position}
	s.cmdGroups[b.ID] = append(s.cmdGroups[b.ID], g)
	writeJSON(w, 201, g)
}

func (s *store) findGroup(b *bot, r *http.Request) *cmdGroup {
	id, _ := strconv.ParseInt(r.PathValue("gid"), 10, 64)
	for _, g := range s.cmdGroups[b.ID] {
		if g.ID == id {
			return g
		}
	}
	return nil
}

func (s *store) updateGroup(w http.ResponseWriter, r *http.Request, b *bot) {
	var in groupInput
	if !readJSON(w, r, &in) {
		return
	}
	if !in.valid() {
		apiError(w, 422, "error.group.invalid")
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	g := s.findGroup(b, r)
	if g == nil {
		apiError(w, 404, "error.group.unknown")
		return
	}
	g.Name, g.Description, g.Position = in.Name, in.Description, in.Position
	writeJSON(w, 200, g)
}

// deleteGroup removes the group; its commands become ungrouped.
func (s *store) deleteGroup(w http.ResponseWriter, r *http.Request, b *bot) {
	s.mu.Lock()
	defer s.mu.Unlock()
	g := s.findGroup(b, r)
	if g == nil {
		apiError(w, 404, "error.group.unknown")
		return
	}
	for _, c := range s.customCmds[b.ID] {
		if c.GroupID != nil && *c.GroupID == g.ID {
			c.GroupID = nil
		}
	}
	s.cmdGroups[b.ID] = slices.DeleteFunc(s.cmdGroups[b.ID], func(x *cmdGroup) bool { return x.ID == g.ID })
	w.WriteHeader(204)
}

// listDeleted returns commands deleted in the last 30 days, newest first.
func (s *store) listDeleted(w http.ResponseWriter, r *http.Request, b *bot) {
	s.mu.Lock()
	defer s.mu.Unlock()
	cutoff := time.Now().Add(-keepDeleted)
	s.deletedCmds[b.ID] = slices.DeleteFunc(s.deletedCmds[b.ID], func(d deletedCmd) bool { return d.deletedAt.Before(cutoff) })
	items := []map[string]any{}
	for i := len(s.deletedCmds[b.ID]) - 1; i >= 0; i-- {
		d := s.deletedCmds[b.ID][i]
		if d.cmd.Kind != kindOf(r) {
			continue
		}
		items = append(items, map[string]any{"id": d.cmd.ID, "name": d.cmd.Name, "description": d.cmd.Description, "deletedAt": d.deletedAt})
	}
	writeJSON(w, 200, map[string]any{"items": items})
}

func (s *store) restoreDeleted(w http.ResponseWriter, r *http.Request, b *bot) {
	id, _ := strconv.ParseInt(r.PathValue("cid"), 10, 64)
	s.mu.Lock()
	defer s.mu.Unlock()
	i := slices.IndexFunc(s.deletedCmds[b.ID], func(d deletedCmd) bool { return d.cmd.ID == id && d.cmd.Kind == kindOf(r) })
	if i < 0 {
		apiError(w, 404, "error.command.unknown")
		return
	}
	c := s.deletedCmds[b.ID][i].cmd
	for _, other := range s.customCmds[b.ID] {
		if c.Kind == "" && other.Kind == "" && other.Name == c.Name {
			apiError(w, 409, "error.command.name_taken")
			return
		}
	}
	if c.GroupID != nil && !slices.ContainsFunc(s.cmdGroups[b.ID], func(g *cmdGroup) bool { return g.ID == *c.GroupID }) {
		c.GroupID = nil
	}
	s.deletedCmds[b.ID] = slices.Delete(s.deletedCmds[b.ID], i, i+1)
	s.customCmds[b.ID] = append(s.customCmds[b.ID], c)
	writeJSON(w, 200, c)
}

// restoreVersion makes a saved version the current graph (a new version).
func (s *store) restoreVersion(w http.ResponseWriter, r *http.Request, b *bot) {
	vid, _ := strconv.ParseInt(r.PathValue("vid"), 10, 64)
	s.mu.Lock()
	defer s.mu.Unlock()
	c := s.findCommand(b, r)
	if c == nil {
		apiError(w, 404, "error.command.unknown")
		return
	}
	for _, v := range c.versions {
		if v.ID == vid {
			c.Graph, c.UpdatedAt = v.Graph, time.Now().UTC()
			c.versionSeq++
			c.versions = append(c.versions, cmdVersion{ID: c.versionSeq, SavedAt: c.UpdatedAt, Nodes: v.Nodes, Graph: v.Graph})
			if len(c.versions) > keepVersions {
				c.versions = c.versions[len(c.versions)-keepVersions:]
			}
			writeJSON(w, 200, c)
			return
		}
	}
	apiError(w, 404, "error.version.unknown")
}

// setCommandGroup is part of PATCH /commands/{cid}: "groupId": id or null.
func (s *store) setCommandGroup(b *bot, c *customCommand, raw json.RawMessage) bool {
	if string(raw) == "null" {
		c.GroupID = nil
		return true
	}
	var id int64
	if json.Unmarshal(raw, &id) != nil || !slices.ContainsFunc(s.cmdGroups[b.ID], func(g *cmdGroup) bool { return g.ID == id }) {
		return false
	}
	c.GroupID = &id
	return true
}
