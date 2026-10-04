package web

import (
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"

	"github.com/Kljub/BothubV3/dashboard/internal/api"
)

func TestModerationFromForm(t *testing.T) {
	form := url.Values{
		"loaded_guild":    {"111"},
		"moderators":      {`{"allowed_roles":[{"id":"10","guild":"111"}],"banned_channels":[{"id":"30","guild":"111"}],"required_permissions":["manage_messages"]}`},
		"admins":          {"not json"},
		"log_enabled":     {"true"},
		"log_channel_111": {"111:20"},
		"dm_mode":         {"text"},
		"dm_message":      {"a\r\nb"},
		"rule_trigger":    {"warnings", "timeouts"},
		"rule_count":      {"3", " 2 "},
		"rule_action":     {"timeout", "ban"},
		"rule_duration":   {"1h", ""},
	}
	r := httptest.NewRequest(http.MethodPut, "/", strings.NewReader(form.Encode()))
	r.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	old := api.ModerationConfig{
		Admins:      api.PermissionsBlock{RequiredPermissions: []string{"administrator"}},
		LogChannels: []api.GuildRef{{ID: "7", Guild: "222"}},
	}
	c := moderationFromForm(r, old)

	// The block is taken as sent (empty lists, not null); unreadable JSON keeps the stored block.
	m := c.Moderators
	if len(m.AllowedRoles) != 1 || m.AllowedRoles[0] != (api.GuildRef{ID: "10", Guild: "111"}) || m.BannedChannels[0].ID != "30" || m.BannedRoles == nil {
		t.Fatalf("moderators = %+v", m)
	}
	if len(c.Admins.RequiredPermissions) != 1 || c.Admins.RequiredPermissions[0] != "administrator" {
		t.Fatalf("admins = %+v", c.Admins)
	}
	// Log channels of servers not on the form (222: left or failed to load) stay.
	if len(c.LogChannels) != 2 || c.LogChannels[1] != (api.GuildRef{ID: "20", Guild: "111"}) {
		t.Fatalf("log channels = %+v", c.LogChannels)
	}
	if !c.LogEnabled || c.DMEnabled || c.DMMode != "text" || c.DMMessage != "a\nb" {
		t.Fatalf("flags = %+v", c)
	}
	want := []api.AutoPunishment{{Trigger: "warnings", Count: 3, Action: "timeout", Duration: "1h"}, {Trigger: "timeouts", Count: 2, Action: "ban"}}
	if len(c.AutoPunishments) != 2 || c.AutoPunishments[0] != want[0] || c.AutoPunishments[1] != want[1] {
		t.Fatalf("rules = %+v", c.AutoPunishments)
	}
}
