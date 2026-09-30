package web

import (
	"bytes"
	"html/template"
	"strings"
	"testing"
	"time"

	"github.com/Kljub/BothubV3/dashboard/internal/api"
	"github.com/Kljub/BothubV3/dashboard/ui"
)

// The Data Storage templates render with typical data (catches template
// errors that only show at run time).
func TestDataStorageTemplates(t *testing.T) {
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
	coins := api.DataVariable{ID: 3, Key: "coins", Name: "Coins", Type: "number", Owner: "member", PerServer: true, DefaultValue: "0", Group: "Economy", Values: 1, UsedIn: 2}
	list := dataStorageView{BotID: 1, Total: 1, Shown: 1, Groups: []dataGroup{{Name: "Economy", Vars: []api.DataVariable{coins}}},
		TypeCounts: []dataTypeCount{{Type: "number", Count: 1}}}
	values := dataValuesView{BotID: 1, Var: coins, Sort: "updated", Pages: 2, Prev: 1, Next: 2, NeedServer: true, NeedOwner: true, OwnerIsUser: true,
		Page: api.DataValuePage{Items: []api.DataValue{{ServerID: "100000000000000001", OwnerID: "200000000000000002", Value: "25", UpdatedAt: now}}, Total: 30, Page: 1, PageSize: 25}}
	lookup := dataLookupView{BotID: 1, ID: "200000000000000002", Names: map[int64]string{3: "Coins"},
		Items: []api.DataValue{{VariableID: 3, Key: "coins", ServerID: "100000000000000001", Value: "25", UpdatedAt: now}}}

	cases := []struct {
		name string
		data any
		want []string
	}{
		{"data_storage", list, []string{`{var.coins}`, `hx-get="/bot/1/data/variables/3/values"`, `id="data-dialog"`}},
		{"data_storage_list_fragment", Page{Data: list}, []string{`hx-swap-oob="true"`, `data.shape.member_true`}},
		{"data_storage_form_fragment", Page{Data: dataFormView{BotID: 1, Var: coins, Edit: true, Types: dataTypes}}, []string{`hx-put="/bot/1/data/variables/3"`, `value="number" checked`}},
		{"data_storage_form_fragment", Page{Data: dataFormView{BotID: 1, Var: api.DataVariable{Type: "text", Owner: "shared", PerServer: true}, Types: dataTypes}}, []string{`hx-post="/bot/1/data/variables"`, `name="key"`}},
		{"data_storage_values_fragment", Page{Data: values}, []string{`name="server_id"`, `name="owner_id"`, `&lt;@200000000000000002&gt;`, `2026-09-30 08:00`, `page=2`}},
		{"data_storage_lookup_fragment", Page{Data: lookup}, []string{`Coins`, `{var.coins}`}},
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
