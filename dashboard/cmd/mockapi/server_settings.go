package main

import (
	"net/http"
	"regexp"
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
}

var domainPattern = regexp.MustCompile(`^([a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)*[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$`)

func defaultServerSettings() serverSettings {
	return serverSettings{PublicPort: 8080, APIPort: 9000, RedisPort: 6379, SessionHours: 168, MaxUploadMB: 10}
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
	case in.SessionHours < 1 || in.SessionHours > 720 || in.MaxUploadMB < 1 || in.MaxUploadMB > 100:
		apiError(w, 422, "error.validation.failed")
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	portsChanged := in.PublicPort != s.activePorts[0] || in.APIPort != s.activePorts[1] || in.RedisPort != s.activePorts[2]
	in.RestartRequired = portsChanged
	s.srvSettings = in
	writeJSON(w, 200, s.srvSettings)
}
