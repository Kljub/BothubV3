package main

import (
	"net/http"
	"regexp"
	"slices"
	"strings"
)

// Instance settings of the mock API. Ports are stored but "active" only after
// a restart; restartRequired reports that.

type serverSettings struct {
	Domain          string `json:"domain"`
	PublicPort      int    `json:"publicPort"`
	APIPort         int    `json:"apiPort"`
	RedisPort       int    `json:"redisPort"`
	BehindProxy     bool   `json:"behindProxy"`
	SessionHours    int    `json:"sessionHours"`
	MaxUploadMB     int    `json:"maxUploadMb"`
	RestartRequired bool   `json:"restartRequired"`
	// Updates and restarts (autoupdate.go).
	AutoUpdate     string `json:"autoUpdate"`     // off, check, install
	AutoUpdateHour int    `json:"autoUpdateHour"` // 0-23, local time
	RestartPolicy  string `json:"restartPolicy"`  // unless-stopped, always, no
}

var domainPattern = regexp.MustCompile(`^([a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)*[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$`)

// cleanDomain accepts what people paste: "https://Example.com/path" and
// "example.com/" become "example.com".
func cleanDomain(v string) string {
	v = strings.ToLower(strings.TrimSpace(v))
	if i := strings.Index(v, "://"); i >= 0 {
		v = v[i+3:]
	}
	if i := strings.IndexAny(v, "/?#"); i >= 0 {
		v = v[:i]
	}
	return strings.TrimSuffix(v, ".")
}

func defaultServerSettings() serverSettings {
	return serverSettings{PublicPort: 8080, APIPort: 9000, RedisPort: 6379, SessionHours: 168, MaxUploadMB: 10,
		AutoUpdate: "off", AutoUpdateHour: 4, RestartPolicy: "unless-stopped"}
}

func (s *store) getServerSettings(w http.ResponseWriter, r *http.Request, _ string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	writeJSON(w, 200, s.srvSettings)
}

func (s *store) putServerSettings(w http.ResponseWriter, r *http.Request, _ string) {
	var in serverSettings
	if !readJSON(w, r, &in) {
		return
	}
	normalizeServerSettings(&in)
	in.Domain = cleanDomain(in.Domain)
	validPort := func(p int) bool { return p >= 1 && p <= 65535 }
	switch {
	case in.Domain != "" && (len(in.Domain) > 253 || !domainPattern.MatchString(in.Domain)):
		apiError(w, 422, "error.server_settings.domain")
		return
	case !validPort(in.PublicPort) || !validPort(in.APIPort) || !validPort(in.RedisPort):
		apiError(w, 422, "error.server_settings.port")
		return
	case in.PublicPort == in.APIPort || in.PublicPort == in.RedisPort || in.APIPort == in.RedisPort:
		apiError(w, 422, "error.server_settings.port_conflict")
		return
	case in.SessionHours < 1 || in.SessionHours > 720 || in.MaxUploadMB < 1 || in.MaxUploadMB > 100,
		!slices.Contains([]string{"off", "check", "install"}, in.AutoUpdate), in.AutoUpdateHour < 0 || in.AutoUpdateHour > 23,
		!slices.Contains(restartPolicies, in.RestartPolicy):
		apiError(w, 422, "error.validation.failed")
		return
	}
	s.mu.Lock()
	portsChanged := in.PublicPort != s.activePorts[0] || in.APIPort != s.activePorts[1] || in.RedisPort != s.activePorts[2]
	in.RestartRequired = portsChanged
	policyChanged := in.RestartPolicy != s.srvSettings.RestartPolicy
	s.srvSettings = in
	s.persistServerSettings(in)
	s.mu.Unlock()
	if policyChanged && s.updater != nil {
		if err := s.updater.applyRestartPolicy(r.Context(), in.RestartPolicy); err != nil {
			apiErrorParams(w, 502, "error.update.failed", map[string]any{"reason": truncate(err.Error(), 200)})
			return
		}
	}
	writeJSON(w, 200, in)
}
