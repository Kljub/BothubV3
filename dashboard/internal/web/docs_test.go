package web

import (
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	"github.com/Kljub/BothubV3/dashboard/internal/api"
	"github.com/Kljub/BothubV3/dashboard/internal/i18n"
	"github.com/Kljub/BothubV3/dashboard/ui"
)

func TestMarkdownIsSafe(t *testing.T) {
	src := "# Title\n\nHello **bold** *it* `code` <script>alert(1)</script>\n\n" +
		"[ok](https://example.com) [bad](javascript:alert(1)) ![img](/static/x.png)\n\n" +
		"- one\n- two\n  - nested\n\n1. first\n2. second\n\n" +
		"> [!TIP]\n> Use it\n\n| a | b |\n|---|---|\n| 1 | <b>2</b> |\n\n```js\nlet x = '<b>';\n```\n\n## Section\n### Sub\n## Section"
	md := renderMarkdown(src)
	html := string(md.HTML)
	for _, want := range []string{
		`<h1 id="title">Title</h1>`, "<strong>bold</strong>", "<em>it</em>", "<code>code</code>", "&lt;script&gt;",
		`<a href="https://example.com" target="_blank" rel="noopener noreferrer">ok</a>`, `<img src="/static/x.png"`,
		"<li>two<ul><li>nested</li></ul>", "<ol><li>first</li><li>second</li></ol>",
		`<div class="doc-callout doc-callout-tip"><p>Use it</p>`, "<td>&lt;b&gt;2&lt;/b&gt;</td>", `<pre><code class="lang-js">let x = &#39;&lt;b&gt;&#39;;</code></pre>`,
		`<h2 id="section-2">Section</h2>`,
	} {
		if !strings.Contains(html, want) {
			t.Errorf("missing %q in\n%s", want, html)
		}
	}
	if strings.Contains(html, "javascript:") || strings.Contains(html, "<script>") || strings.Contains(html, "<b>2") {
		t.Errorf("unsafe output:\n%s", html)
	}
	if len(md.Headings) != 4 || md.Headings[2].Level != 3 {
		t.Errorf("headings: %+v", md.Headings)
	}
}

// The shipped docs load, have both languages and render.
func TestShippedDocs(t *testing.T) {
	lib, err := LoadDocs(filepath.Join(sharedDir(), "docs"))
	if err != nil {
		t.Fatal(err)
	}
	if len(lib.Categories) < 5 {
		t.Fatalf("categories: %+v", lib.Categories)
	}
	for _, c := range lib.Categories {
		if c.Generated != "" {
			continue
		}
		en, de := lib.files["en"][c.Slug], lib.files["de"][c.Slug]
		if len(en) == 0 || len(en) != len(de) {
			t.Errorf("category %s: %d English, %d German articles", c.Slug, len(en), len(de))
		}
		for i := range en {
			if i < len(de) && en[i].Slug != de[i].Slug {
				t.Errorf("category %s: article %d is %s in English, %s in German", c.Slug, i, en[i].Slug, de[i].Slug)
			}
			if strings.Contains(string(renderMarkdown(en[i].Body).HTML), "<script") {
				t.Errorf("%s/%s renders a script", c.Slug, en[i].Slug)
			}
		}
	}
}

func docsServer(t *testing.T, own string) *Server {
	t.Helper()
	fake := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/api/v1/docs":
			_, _ = w.Write([]byte(own))
		case "/api/v1/docs/8":
			_, _ = w.Write([]byte(`{"id":8,"category":"getting-started","slug":"welcome","lang":"de","title":"Eigenes Willkommen","content":"Hallo","published":true}`))
		case "/api/v1/docs/7":
			_, _ = w.Write([]byte(`{"id":7,"category":"updates","slug":"news","lang":"","title":"News","content":"# Hi\n\n**new**","published":true,"author":"admin","updatedAt":"2026-10-04T10:00:00Z"}`))
		default:
			w.WriteHeader(http.StatusNotFound)
			_, _ = w.Write([]byte(`{"error":{"key":"error.not_found"}}`))
		}
	}))
	t.Cleanup(fake.Close)
	client, err := api.New(fake.URL)
	if err != nil {
		t.Fatal(err)
	}
	b, err := i18n.Load(ui.FS, "lang")
	if err != nil {
		t.Fatal(err)
	}
	lib, err := LoadDocs(filepath.Join(sharedDir(), "docs"))
	if err != nil {
		t.Fatal(err)
	}
	modules, err := LoadModules(filepath.Join(sharedDir(), "modules.json"))
	if err != nil {
		t.Fatal(err)
	}
	cmds, err := LoadCommands(filepath.Join(sharedDir(), "commands.json"), filepath.Join(sharedDir(), "command-presets.json"))
	if err != nil {
		t.Fatal(err)
	}
	nodes, err := LoadNodeDefs(filepath.Join(sharedDir(), "nodes"))
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv("SHARED_DIR", sharedDir())
	s, err := New(Config{API: client, I18n: b, UI: ui.FS, DefaultLocale: "en", Docs: lib, Modules: modules, Commands: cmds, NodeDefs: nodes})
	if err != nil {
		t.Fatal(err)
	}
	return s
}

func TestDocsPages(t *testing.T) {
	own := `{"articles":[{"id":7,"category":"updates","slug":"news","lang":"","title":"News","published":true},
		{"id":8,"category":"getting-started","slug":"welcome","lang":"de","title":"Eigenes Willkommen","published":true},
		{"id":9,"category":"updates","slug":"draft","lang":"","title":"Draft","published":false}],"categories":[]}`
	s := docsServer(t, own)
	get := func(path, locale string, h func(http.ResponseWriter, *http.Request, Page), values map[string]string) string {
		r := httptest.NewRequest(http.MethodGet, path, nil)
		for k, v := range values {
			r.SetPathValue(k, v)
		}
		w := httptest.NewRecorder()
		h(w, r, Page{Locale: locale})
		if w.Code != http.StatusOK {
			t.Fatalf("%s: status %d\n%s", path, w.Code, w.Body.String())
		}
		return w.Body.String()
	}
	index := get("/docs", "en", s.handleDocs, nil)
	for _, want := range []string{"Getting started", "/docs/modules/economy", `href="/docs/updates/news"`, "/docs/new"} {
		if !strings.Contains(index, want) {
			t.Errorf("index: missing %q", want)
		}
	}
	if strings.Contains(index, "/docs/updates/draft") {
		t.Error("a draft is listed")
	}
	shipped := get("/docs/getting-started/first-bot", "en", s.handleDocArticle, map[string]string{"category": "getting-started", "slug": "first-bot"})
	if !strings.Contains(shipped, "Privileged Gateway Intents") || !strings.Contains(shipped, "docs-toc") {
		t.Error("shipped article: content or table of contents missing")
	}
	replaced := get("/docs/getting-started/welcome", "de", s.handleDocArticle, map[string]string{"category": "getting-started", "slug": "welcome"})
	if !strings.Contains(replaced, "Eigenes Willkommen") {
		t.Error("an own article with the same slug replaces the shipped one")
	}
	module := get("/docs/modules/economy", "en", s.handleDocArticle, map[string]string{"category": "modules", "slug": "economy"})
	for _, want := range []string{"Daily bonus", "/daily", "Bank", `href="/bots/modules/economy"`} {
		if !strings.Contains(module, want) {
			t.Errorf("module reference: missing %q", want)
		}
	}
	search := get("/docs?q=intent", "en", s.handleDocs, nil)
	if !strings.Contains(search, "/docs/getting-started/first-bot") {
		t.Error("search finds the text of articles")
	}
}
