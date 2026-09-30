package web

import (
	"io/fs"
	"regexp"
	"strings"
	"testing"

	"github.com/Kljub/BothubV3/dashboard/internal/api"
	"github.com/Kljub/BothubV3/dashboard/internal/i18n"
	"github.com/Kljub/BothubV3/dashboard/ui"
)

// Every locale must have exactly the keys of the fallback locale.
func TestLocalesHaveSameKeys(t *testing.T) {
	b, err := i18n.Load(ui.FS, "lang")
	if err != nil {
		t.Fatal(err)
	}
	want := map[string]bool{}
	for _, k := range b.Keys(i18n.Fallback) {
		want[k] = true
	}
	for _, loc := range b.Locales() {
		got := map[string]bool{}
		for _, k := range b.Keys(loc) {
			got[k] = true
			if !want[k] {
				t.Errorf("%s: extra key %q", loc, k)
			}
		}
		for k := range want {
			if !got[k] {
				t.Errorf("%s: missing key %q", loc, k)
			}
		}
	}
}

// Every literal key used in a template must exist in the fallback locale.
func TestTemplateKeysExist(t *testing.T) {
	b, err := i18n.Load(ui.FS, "lang")
	if err != nil {
		t.Fatal(err)
	}
	have := map[string]bool{}
	for _, k := range b.Keys(i18n.Fallback) {
		have[k] = true
	}
	re := regexp.MustCompile(`\{\{-?\s*t\s+"([^"]+)"`)
	err = fs.WalkDir(ui.FS, "templates", func(p string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return err
		}
		src, err := fs.ReadFile(ui.FS, p)
		if err != nil {
			return err
		}
		for _, m := range re.FindAllStringSubmatch(string(src), -1) {
			if !have[m[1]] {
				t.Errorf("%s: key %q missing in %s.json", p, m[1], i18n.Fallback)
			}
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
}

func TestTemplatesParse(t *testing.T) {
	if _, err := parseTemplates(ui.FS); err != nil {
		t.Fatal(err)
	}
}

// New registers all routes; conflicting patterns panic here instead of at startup.
func TestRoutesRegister(t *testing.T) {
	client, err := api.New("http://127.0.0.1:1")
	if err != nil {
		t.Fatal(err)
	}
	b, err := i18n.Load(ui.FS, "lang")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := New(Config{API: client, I18n: b, UI: ui.FS, DefaultLocale: "en"}); err != nil {
		t.Fatal(err)
	}
}

// globalComponents are the stylesheets whose classes module and plugin content
// may use (see ui/DESIGN.md). Page parts (sidebar, tiles, …) are not in here.
var globalComponents = []string{
	"bh-base", "bh-form", "bh-button", "bh-toggle", "bh-chip",
	"bh-card", "bh-section", "bh-datepicker", "bh-pagination", "bh-command", "bh-gauge", "bh-badge", "bh-alert", "bh-table", "bh-utilities",
}

// Module and plugin content may only use the global component classes.
func TestContentUsesOnlyComponents(t *testing.T) {
	allowed := map[string]bool{}
	for _, name := range globalComponents {
		css, err := fs.ReadFile(ui.FS, "static/css/components/"+name+".css")
		if err != nil {
			t.Fatal(err)
		}
		for _, m := range regexp.MustCompile(`\.([a-zA-Z][\w-]*)`).FindAllStringSubmatch(string(css), -1) {
			allowed[m[1]] = true
		}
	}
	actions := regexp.MustCompile(`\{\{.*?\}\}`)
	classAttr := regexp.MustCompile(`class="([^"]*)"`)
	for _, dir := range []string{"templates/modules", "templates/plugins"} {
		files, _ := fs.Glob(ui.FS, dir+"/*.html")
		for _, f := range files {
			src, err := fs.ReadFile(ui.FS, f)
			if err != nil {
				t.Fatal(err)
			}
			for _, m := range classAttr.FindAllStringSubmatch(string(src), -1) {
				for _, class := range strings.Fields(actions.ReplaceAllString(m[1], " ")) {
					if !allowed[class] {
						t.Errorf("%s: class %q is not a global component (ui/DESIGN.md)", f, class)
					}
				}
			}
			if strings.Contains(string(src), "style=") || strings.Contains(string(src), "<style") {
				t.Errorf("%s: inline styles are not allowed", f)
			}
		}
	}
}

// Every component file is imported by bothub.css and every import exists.
func TestMainCSSImportsAllComponents(t *testing.T) {
	main, err := fs.ReadFile(ui.FS, "static/css/bothub.css")
	if err != nil {
		t.Fatal(err)
	}
	imported := map[string]bool{}
	for _, m := range regexp.MustCompile(`@import url\('\./components/([\w-]+)\.css'\)`).FindAllStringSubmatch(string(main), -1) {
		imported[m[1]] = true
		if _, err := fs.Stat(ui.FS, "static/css/components/"+m[1]+".css"); err != nil {
			t.Errorf("bothub.css imports missing file %s.css", m[1])
		}
	}
	files, _ := fs.Glob(ui.FS, "static/css/components/*.css")
	for _, f := range files {
		name := strings.TrimSuffix(f[strings.LastIndex(f, "/")+1:], ".css")
		if !imported[name] {
			t.Errorf("%s is not imported by bothub.css", f)
		}
	}
}

// Every script and stylesheet the layout loads must be embedded. The Docker
// build runs this test, so a file dropped by .dockerignore fails the build.
func TestLayoutAssetsEmbedded(t *testing.T) {
	src, err := fs.ReadFile(ui.FS, "templates/layout.html")
	if err != nil {
		t.Fatal(err)
	}
	refs := regexp.MustCompile(`(?:src|href)="/static/([^"?]+)`).FindAllStringSubmatch(string(src), -1)
	if len(refs) == 0 {
		t.Fatal("no static assets found in layout.html")
	}
	for _, m := range refs {
		if _, err := fs.Stat(ui.FS, "static/"+m[1]); err != nil {
			t.Errorf("layout.html loads /static/%s, but it is not embedded", m[1])
		}
	}
}

func TestBotGridPaging(t *testing.T) {
	bots := make([]api.Bot, 30)
	for i := range bots {
		bots[i].ID = int64(i + 1)
	}
	g := botGrid(bots, 2)
	if g.Pages != 3 || g.Page != 2 || len(g.Bots) != botsPerPage || g.Bots[0].ID != botsPerPage+1 {
		t.Fatalf("page 2: got pages=%d page=%d n=%d first=%d", g.Pages, g.Page, len(g.Bots), g.Bots[0].ID)
	}
	if g := botGrid(bots, 99); g.Page != 3 || len(g.Bots) != 30-2*botsPerPage {
		t.Fatalf("clamp: got page=%d n=%d", g.Page, len(g.Bots))
	}
	if g := botGrid(nil, 1); g.Pages != 1 || len(g.Bots) != 0 {
		t.Fatalf("empty: got pages=%d", g.Pages)
	}
	if got := pager(5, 9, "/x", "#x").Items; len(got) != 7 || got[1] != 0 || got[5] != 0 {
		t.Fatalf("pager items: %v", got)
	}
}
