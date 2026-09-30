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
		"loaded_guild":        {"111"},
		"default_permissions": {"true"},
		"moderator_roles":     {"111:10", "999:11", "bad"},
		"log_enabled":         {"true"},
		"log_channel_111":     {"20"},
		"dm_mode":             {"text"},
		"dm_message":          {"a\r\nb"},
		"rule_trigger":        {"warnings", "timeouts"},
		"rule_count":          {"3", " 2 "},
		"rule_action":         {"timeout", "ban"},
		"rule_duration":       {"1h", ""},
	}
	r := httptest.NewRequest(http.MethodPut, "/", strings.NewReader(form.Encode()))
	r.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	old := api.ModerationConfig{
		ModeratorRoles: []api.GuildRef{{ID: "5", Guild: "222"}, {ID: "6", Guild: "111"}},
		LogChannels:    []api.GuildRef{{ID: "7", Guild: "222"}},
	}
	c := moderationFromForm(r, old)

	// Entries of servers not on the form (222: left or failed to load) stay; unknown servers in the form are dropped.
	if len(c.ModeratorRoles) != 2 || c.ModeratorRoles[0].ID != "5" || c.ModeratorRoles[1] != (api.GuildRef{ID: "10", Guild: "111"}) {
		t.Fatalf("moderator roles = %+v", c.ModeratorRoles)
	}
	if len(c.AdminRoles) != 0 || c.AdminRoles == nil {
		t.Fatalf("admin roles must be an empty list, got %#v", c.AdminRoles)
	}
	if len(c.LogChannels) != 2 || c.LogChannels[1] != (api.GuildRef{ID: "20", Guild: "111"}) {
		t.Fatalf("log channels = %+v", c.LogChannels)
	}
	if !c.DefaultPermissions || !c.LogEnabled || c.DMEnabled || c.DMMode != "text" || c.DMMessage != "a\nb" {
		t.Fatalf("flags = %+v", c)
	}
	want := []api.AutoPunishment{{Trigger: "warnings", Count: 3, Action: "timeout", Duration: "1h"}, {Trigger: "timeouts", Count: 2, Action: "ban"}}
	if len(c.AutoPunishments) != 2 || c.AutoPunishments[0] != want[0] || c.AutoPunishments[1] != want[1] {
		t.Fatalf("rules = %+v", c.AutoPunishments)
	}
}
