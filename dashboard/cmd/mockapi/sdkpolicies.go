package main

import (
	"encoding/json"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"slices"
)

// SDK policies (admin > SDK Policies): global on/off per SDK permission of
// shared/sdk-permissions.json. With the PHP API the requests go there;
// without it the switches live in memory.

type sdkPolicy struct {
	Permission  string   `json:"permission"`
	Group       string   `json:"group"`
	Module      string   `json:"module"`
	Risk        string   `json:"risk"`
	Calls       []string `json:"calls"`
	Implemented int      `json:"implemented"`
	Mode        string   `json:"mode"` // allow, default, deny
	Enabled     bool     `json:"enabled"`
	Default     bool     `json:"default"`
}

func (s *store) sdkPolicyList() []sdkPolicy {
	raw, err := os.ReadFile(filepath.Join(envOr("SHARED_DIR", "/shared"), "sdk-permissions.json"))
	var doc struct {
		Permissions []struct {
			Key         string   `json:"key"`
			Group       string   `json:"group"`
			Module      string   `json:"module"`
			Risk        string   `json:"risk"`
			Calls       []string `json:"calls"`
			Implemented []string `json:"implemented"`
		} `json:"permissions"`
	}
	if err != nil || json.Unmarshal(raw, &doc) != nil {
		return []sdkPolicy{}
	}
	out := []sdkPolicy{}
	for _, p := range doc.Permissions {
		def := p.Risk == "low"
		on, ok := s.sdkPolicies[p.Key]
		mode := "default"
		switch {
		case !ok:
			on = def
		case on:
			mode = "allow"
		default:
			mode = "deny"
		}
		n := 0
		for _, c := range p.Calls {
			if slices.Contains(p.Implemented, c) {
				n++
			}
		}
		out = append(out, sdkPolicy{Permission: p.Key, Group: p.Group, Module: p.Module, Risk: p.Risk, Calls: p.Calls, Implemented: n, Mode: mode, Enabled: on, Default: def})
	}
	return out
}

func (s *store) listSdkPolicies(w http.ResponseWriter, r *http.Request, _ string) {
	if s.php != nil {
		s.forward(w, r, nil)
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	writeJSON(w, 200, map[string]any{"items": s.sdkPolicyList()})
}

func (s *store) setSdkPolicy(w http.ResponseWriter, r *http.Request, _ string) {
	var in struct {
		Mode string `json:"mode"`
	}
	body, err := io.ReadAll(io.LimitReader(r.Body, 1<<16))
	if err != nil || json.Unmarshal(body, &in) != nil || !slices.Contains([]string{"allow", "default", "deny"}, in.Mode) {
		apiError(w, 422, "error.validation.failed")
		return
	}
	if s.php != nil {
		s.forward(w, r, body)
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	perm := r.PathValue("perm")
	if !slices.ContainsFunc(s.sdkPolicyList(), func(p sdkPolicy) bool { return p.Permission == perm }) {
		apiError(w, 404, "error.sdk.unknown_permission")
		return
	}
	if s.sdkPolicies == nil {
		s.sdkPolicies = map[string]bool{}
	}
	if in.Mode == "default" {
		delete(s.sdkPolicies, perm)
	} else {
		s.sdkPolicies[perm] = in.Mode == "allow"
	}
	writeJSON(w, 200, map[string]any{"items": s.sdkPolicyList()})
}
