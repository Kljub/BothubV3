package web

import (
	"bytes"
	"html/template"
	"strings"
	"testing"

	"github.com/Kljub/BothubV3/dashboard/internal/api"
	"github.com/Kljub/BothubV3/dashboard/ui"
)

func TestBotBackupTemplates(t *testing.T) {
	tpl, err := parseTemplates(ui.FS)
	if err != nil {
		t.Fatal(err)
	}
	set, err := tpl.sets["bot"].Clone()
	if err != nil {
		t.Fatal(err)
	}
	set.Funcs(template.FuncMap{"t": func(key string, _ ...any) string { return key }, "bytes": func(b int64) string { return "1 KB" }})
	when := "2026-10-01T08:00:00Z"
	view := botBackupView{BotID: 3, BotName: `Bot "X"`, Items: []api.BotBackup{
		{ID: "7", Kind: "backup", Name: `Before "update"`, CreatedAt: &when, Size: 1200},
		{ID: "builtin:starter", Kind: "builtin", Name: "Starter"},
	}}
	var buf bytes.Buffer
	if err := set.ExecuteTemplate(&buf, "bot_backup", view); err != nil {
		t.Fatal(err)
	}
	out := buf.String()
	for _, want := range []string{`href="/bot/3/backup/download"`, `hx-encoding="multipart/form-data"`, `name="id" value="builtin:starter"`, `hx-delete="/bot/3/backups/7"`, `backup.kind.builtin`, `value="Before &#34;update&#34;"`} {
		if !strings.Contains(out, want) {
			t.Errorf("missing %q", want)
		}
	}
	if strings.Contains(out, `hx-delete="/bot/3/backups/builtin:starter"`) {
		t.Error("ready-made templates must not have a delete button")
	}
}
