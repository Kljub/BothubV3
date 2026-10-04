package web

import (
	"encoding/json"
	"html/template"
	"net/http"
	"strconv"
	"strings"

	"github.com/Kljub/BothubV3/dashboard/internal/api"
)

// Settings page of the moderation module (bot_modules.config). Who counts as
// moderator or admin is a permissions block each (permissions.js); the log
// channel is picked per server. The bot uses the entries of the server a
// command runs in.

var banDeleteOptions = []string{"none", "1h", "6h", "12h", "24h", "3d", "7d"}

// moderationView is the data for the "moderation_settings" template.
type moderationView struct {
	BotID  int64
	Config api.ModerationConfig
	Guilds []moderationGuild
	// Moderators, Admins: the blocks as JSON for the hidden inputs.
	Moderators, Admins string
	// Picker: servers with roles and channels for the pickers.
	Picker        template.JS
	DeleteOptions []string
	NewRule       api.AutoPunishment
}

type moderationGuild struct {
	ID, Name   string
	Roles      []api.GuildRole
	Channels   []api.GuildChannel
	LogChannel string
	Failed     bool // roles or channels could not be loaded (bot offline)
}

func (s *Server) moderationData(r *http.Request, botID int64) (moderationView, error) {
	cfg, err := s.api.ModerationConfig(r.Context(), session(r), botID)
	if err != nil {
		return moderationView{}, err
	}
	v := moderationView{
		BotID: botID, Config: cfg, DeleteOptions: banDeleteOptions,
		Moderators: blockJSON(cfg.Moderators), Admins: blockJSON(cfg.Admins),
		NewRule: api.AutoPunishment{Trigger: "warnings", Count: 3, Action: "timeout", Duration: "1h"},
	}
	// Without a running bot there are no servers; the page still works.
	guilds, _ := s.api.ListGuilds(r.Context(), session(r), botID)
	var picker []settingsGuild
	for _, g := range guilds {
		mg := moderationGuild{ID: g.ID, Name: g.Name}
		roles, rerr := s.api.GuildRoles(r.Context(), session(r), botID, g.ID)
		chans, cerr := s.api.GuildChannels(r.Context(), session(r), botID, g.ID)
		mg.Roles, mg.Channels, mg.Failed = roles, chans, rerr != nil || cerr != nil
		for _, c := range cfg.LogChannels {
			if c.Guild == g.ID {
				mg.LogChannel = c.ID
			}
		}
		v.Guilds = append(v.Guilds, mg)
		pg := settingsGuild{ID: g.ID, Name: g.Name, Roles: roles, Channels: chans}
		if g.IconURL != nil {
			pg.IconURL = *g.IconURL
		}
		picker = append(picker, pg)
	}
	v.Picker = s.pickerData(picker)
	return v, nil
}

func blockJSON(b api.PermissionsBlock) string {
	out, _ := json.Marshal(b)
	return string(out)
}

// blockFromForm reads a block's JSON (permissions.js); unreadable input keeps
// the stored block, the API checks every list.
func blockFromForm(v string, old api.PermissionsBlock) api.PermissionsBlock {
	var b api.PermissionsBlock
	if json.Unmarshal([]byte(v), &b) != nil {
		return old
	}
	for _, l := range []*[]api.GuildRef{&b.AllowedRoles, &b.BannedRoles, &b.BannedChannels} {
		if *l == nil {
			*l = []api.GuildRef{}
		}
	}
	if b.RequiredPermissions == nil {
		b.RequiredPermissions = []string{}
	}
	return b
}

// moderationFromForm reads the settings form. The blocks hold the entries of
// every server. Log channels: only servers whose channels were on the form
// (hidden field loaded_guild) are replaced; entries of other servers (bot
// left, or loading failed) are kept from the stored config.
func moderationFromForm(r *http.Request, old api.ModerationConfig) api.ModerationConfig {
	_ = r.ParseForm()
	f := r.PostForm
	known := map[string]bool{}
	for _, id := range f["loaded_guild"] {
		known[id] = true
	}
	c := api.ModerationConfig{
		Moderators:        blockFromForm(f.Get("moderators"), old.Moderators),
		Admins:            blockFromForm(f.Get("admins"), old.Admins),
		LogEnabled:        f.Get("log_enabled") == "true",
		LogChannels:       []api.GuildRef{},
		PunishmentColor:   f.Get("punishment_color"),
		LogColor:          f.Get("log_color"),
		DMEnabled:         f.Get("dm_enabled") == "true",
		DMMode:            f.Get("dm_mode"),
		DMMessage:         strings.ReplaceAll(f.Get("dm_message"), "\r\n", "\n"),
		BanDeleteMessages: f.Get("ban_delete_messages"),
		AutoPunishments:   []api.AutoPunishment{},
	}
	for _, p := range old.LogChannels {
		if !known[p.Guild] {
			c.LogChannels = append(c.LogChannels, p)
		}
	}
	for _, g := range f["loaded_guild"] {
		// "guild:id" from the picker (of this server only); a bare id from older forms.
		v := f.Get("log_channel_" + g)
		if guild, id, ok := strings.Cut(v, ":"); ok {
			v = id
			if guild != g {
				v = ""
			}
		}
		if v != "" {
			c.LogChannels = append(c.LogChannels, api.GuildRef{ID: v, Guild: g})
		}
	}
	triggers, counts, actions, durations := f["rule_trigger"], f["rule_count"], f["rule_action"], f["rule_duration"]
	for i := range triggers {
		if i >= len(counts) || i >= len(actions) || i >= len(durations) {
			break
		}
		n, _ := strconv.Atoi(strings.TrimSpace(counts[i]))
		c.AutoPunishments = append(c.AutoPunishments, api.AutoPunishment{
			Trigger: triggers[i], Count: n, Action: actions[i], Duration: strings.TrimSpace(durations[i]),
		})
	}
	return c
}

func (s *Server) handleModerationConfig(w http.ResponseWriter, r *http.Request, p Page) {
	id, ok := s.botID(w, r, p)
	if !ok {
		return
	}
	old, err := s.api.ModerationConfig(r.Context(), session(r), id)
	if err != nil {
		s.fail(w, r, p, err)
		return
	}
	if _, err := s.api.SetModerationConfig(r.Context(), session(r), id, moderationFromForm(r, old)); err != nil {
		s.fail(w, r, p, err)
		return
	}
	s.flash(w, p, "moderation.saved")
}
