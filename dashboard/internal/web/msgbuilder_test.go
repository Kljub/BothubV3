package web

import (
	"bytes"
	"encoding/json"
	"html/template"
	"strings"
	"testing"
	"time"

	"github.com/Kljub/BothubV3/dashboard/internal/api"
	"github.com/Kljub/BothubV3/dashboard/ui"
)

func TestTemplateSummary(t *testing.T) {
	cases := []struct {
		raw     string
		summary string
		v2      bool
		embeds  int
	}{
		{`{"mode":"normal","content":"Hello\nworld","embeds":[]}`, "Hello", false, 0},
		{`{"mode":"normal","content":"","embeds":[{"title":"Rules"},{}]}`, "Rules", false, 2},
		{`{"mode":"v2","components":[{"type":"separator"},{"type":"text","content":"Hi v2"}]}`, "Hi v2", true, 0},
		{`{"mode":"normal"}`, "", false, 0},
	}
	for _, c := range cases {
		s, v2, n := templateSummary(json.RawMessage(c.raw))
		if s != c.summary || v2 != c.v2 || n != c.embeds {
			t.Errorf("%s: got %q %v %d", c.raw, s, v2, n)
		}
	}
}

func TestMessageBuilderTemplates(t *testing.T) {
	tpl, err := parseTemplates(ui.FS)
	if err != nil {
		t.Fatal(err)
	}
	set, err := tpl.sets["module_item"].Clone()
	if err != nil {
		t.Fatal(err)
	}
	set.Funcs(template.FuncMap{"t": func(key string, _ ...any) string { return key }})
	now := time.Date(2026, 9, 30, 8, 0, 0, 0, time.UTC)
	view := msgBuilderView{BotID: 1, BotName: "Njetflix", Max: 100, Texts: "{}",
		Items: []msgTemplateRow{{ID: 4, Name: "Welcome", Summary: "Hello", Embeds: 1, CreatedAt: now}}}
	errKey := "error.run.channel_not_found"
	cases := []struct {
		name string
		data any
		want []string
	}{
		{"message_builder", view, []string{`data-msgb-edit="4"`, `/bot/1/message-templates/4/send`, `id="msgb-name-dialog"`, `message-page.js`}},
		{"message_builder_list_fragment", Page{Data: view}, []string{`hx-swap-oob="true"`, `msgb.embeds`}},
		{"message_builder_send_fragment", Page{Data: msgSendView{BotID: 1, Template: api.MessageTemplate{ID: 4, Name: "Welcome"}, Guilds: []api.Guild{{ID: "1", Name: "Home"}}}}, []string{`<option value="1">Home</option>`, `name="webhook_url"`}},
		{"message_builder_channels_fragment", Page{Data: msgChannelsView{Channels: []api.GuildChannel{{ID: "9", Name: "general"}}}}, []string{`#general`}},
		{"message_builder_job_fragment", Page{Data: msgJobView{BotID: 1, Job: api.Job{ID: "abc", Status: "queued"}}}, []string{`/bot/1/message-jobs/abc`}},
		{"message_builder_job_fragment", Page{Data: msgJobView{BotID: 1, Job: api.Job{Status: "failed", ErrorKey: &errKey}, Done: true}}, []string{`alert-error`, errKey}},
	}
	for _, c := range cases {
		var buf bytes.Buffer
		if err := set.ExecuteTemplate(&buf, c.name, c.data); err != nil {
			t.Fatalf("%s: %v", c.name, err)
		}
		for _, w := range c.want {
			if !strings.Contains(buf.String(), w) {
				t.Errorf("%s: missing %q", c.name, w)
			}
		}
	}
}
