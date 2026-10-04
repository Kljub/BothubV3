package web

import (
	"encoding/json"
	"fmt"
	"html/template"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"sort"
	"strconv"
	"strings"

	"github.com/Kljub/BothubV3/dashboard/internal/api"
)

// Docs: the shipped guides (shared/docs: categories.json and
// <lang>/<category>/<NN>-<slug>.md with a title/summary front matter), a
// module reference built from the module catalog, its settings schemas,
// commands, builder blocks and texts (always up to date), and articles
// written in the dashboard (API /docs). An own article with the slug of a
// shipped one replaces it. Markdown is rendered escaped (markdown.go).

// DocsLibrary is the content of shared/docs.
type DocsLibrary struct {
	Categories []docCategoryDef
	// files[lang][category] = articles in order
	files map[string]map[string][]docFile
}

type docCategoryDef struct {
	Slug        string            `json:"slug"`
	Icon        string            `json:"icon"`
	Title       map[string]string `json:"title"`
	Sort        int               `json:"sort"`
	Generated   string            `json:"generated"`   // "modules": the module reference
	NewestFirst bool              `json:"newestFirst"` // updates: newest article on top
}

type docFile struct {
	Slug, Title, Summary, Body string
	Order                      string
}

var docFileName = regexp.MustCompile(`^(\d+(?:-\d+)*)-([a-z][a-z0-9-]*)\.md$`)

// LoadDocs reads shared/docs; a missing directory gives empty docs.
func LoadDocs(dir string) (DocsLibrary, error) {
	lib := DocsLibrary{files: map[string]map[string][]docFile{}}
	raw, err := os.ReadFile(filepath.Join(dir, "categories.json"))
	if os.IsNotExist(err) {
		return lib, nil
	}
	if err != nil {
		return lib, fmt.Errorf("read docs categories: %w", err)
	}
	if err := json.Unmarshal(raw, &lib.Categories); err != nil {
		return lib, fmt.Errorf("docs categories: %w", err)
	}
	langs, _ := os.ReadDir(dir)
	for _, l := range langs {
		if !l.IsDir() {
			continue
		}
		lib.files[l.Name()] = map[string][]docFile{}
		for _, c := range lib.Categories {
			paths, _ := filepath.Glob(filepath.Join(dir, l.Name(), c.Slug, "*.md"))
			sort.Strings(paths)
			for _, p := range paths {
				m := docFileName.FindStringSubmatch(filepath.Base(p))
				if m == nil {
					return lib, fmt.Errorf("docs file name %s: want <order>-<slug>.md", p)
				}
				body, err := os.ReadFile(p)
				if err != nil {
					return lib, err
				}
				f := parseFrontMatter(string(body))
				f.Slug, f.Order = m[2], m[1]
				if f.Title == "" {
					return lib, fmt.Errorf("docs file %s: title missing", p)
				}
				lib.files[l.Name()][c.Slug] = append(lib.files[l.Name()][c.Slug], f)
			}
			if c.NewestFirst {
				list := lib.files[l.Name()][c.Slug]
				slices.Reverse(list)
			}
		}
	}
	slices.SortStableFunc(lib.Categories, func(a, b docCategoryDef) int { return a.Sort - b.Sort })
	return lib, nil
}

// parseFrontMatter: "---\ntitle: …\nsummary: …\n---\nbody".
func parseFrontMatter(src string) docFile {
	src = strings.ReplaceAll(src, "\r\n", "\n")
	var f docFile
	if !strings.HasPrefix(src, "---\n") {
		f.Body = src
		return f
	}
	end := strings.Index(src[4:], "\n---")
	if end < 0 {
		f.Body = src
		return f
	}
	for _, line := range strings.Split(src[4:4+end], "\n") {
		k, v, ok := strings.Cut(line, ":")
		if !ok {
			continue
		}
		v = strings.Trim(strings.TrimSpace(v), `"`)
		switch strings.TrimSpace(k) {
		case "title":
			f.Title = v
		case "summary":
			f.Summary = v
		}
	}
	f.Body = strings.TrimLeft(src[4+end+4:], "\n")
	return f
}

// --- the docs a user sees ---

// docEntry is one article in the sidebar and in lists.
type docEntry struct {
	Category, Slug, Title, Summary string
	URL                            string
	Own                            bool  // written in the dashboard
	ID                             int64 // own: its ID (edit link)
	Draft                          bool
	Active                         bool
	Group                          string // module reference: its module category
	body                           string
}

type docCategoryView struct {
	Slug, Icon, Title string
	Own               bool // an own category (editable)
	Entries           []docEntry
	Active            bool
}

// docsFor merges shipped, generated and own docs for a locale. drafts: own
// drafts are listed too (for the editor list).
func (s *Server) docsFor(locale string, own api.DocsList, drafts bool) []docCategoryView {
	var out []docCategoryView
	index := map[string]int{}
	for _, c := range s.docs.Categories {
		title := c.Title[locale]
		if title == "" {
			title = c.Title["en"]
		}
		v := docCategoryView{Slug: c.Slug, Icon: c.Icon, Title: title}
		if c.Generated == "modules" {
			v.Entries = s.moduleEntries(locale)
		} else {
			files := s.docs.files[locale][c.Slug]
			if len(files) == 0 {
				files = s.docs.files["en"][c.Slug]
			}
			for _, f := range files {
				v.Entries = append(v.Entries, docEntry{Category: c.Slug, Slug: f.Slug, Title: f.Title, Summary: f.Summary, URL: "/docs/" + c.Slug + "/" + f.Slug, body: f.Body})
			}
		}
		index[c.Slug] = len(out)
		out = append(out, v)
	}
	for _, c := range own.Categories {
		if _, ok := index[c.Slug]; ok {
			continue
		}
		index[c.Slug] = len(out)
		out = append(out, docCategoryView{Slug: c.Slug, Icon: c.Icon, Title: c.Title, Own: true})
	}
	// Own articles: the one in the user's language, else the one for every language, else any.
	best := map[string]api.DocArticle{}
	rank := func(a api.DocArticle) int {
		switch a.Lang {
		case locale:
			return 3
		case "":
			return 2
		}
		return 1
	}
	for _, a := range own.Articles {
		if !a.Published && !drafts {
			continue
		}
		k := a.Category + "/" + a.Slug
		if cur, ok := best[k]; !ok || rank(a) > rank(cur) {
			best[k] = a
		}
	}
	keys := make([]string, 0, len(best))
	for k := range best {
		keys = append(keys, k)
	}
	sort.Slice(keys, func(i, j int) bool {
		a, b := best[keys[i]], best[keys[j]]
		if a.Sort != b.Sort {
			return a.Sort < b.Sort
		}
		return a.Title < b.Title
	})
	for _, k := range keys {
		a := best[k]
		ci, ok := index[a.Category]
		if !ok {
			continue // a category that no longer exists
		}
		e := docEntry{Category: a.Category, Slug: a.Slug, Title: a.Title, Summary: a.Summary, URL: "/docs/" + a.Category + "/" + a.Slug, Own: true, ID: a.ID, Draft: !a.Published}
		entries := out[ci].Entries
		if i := slices.IndexFunc(entries, func(x docEntry) bool { return x.Slug == a.Slug }); i >= 0 {
			entries[i] = e // replaces the shipped article
		} else if s.docsNewestFirst(a.Category) {
			entries = append([]docEntry{e}, entries...)
		} else {
			entries = append(entries, e)
		}
		out[ci].Entries = entries
	}
	return out
}

func (s *Server) docsNewestFirst(category string) bool {
	for _, c := range s.docs.Categories {
		if c.Slug == category {
			return c.NewestFirst
		}
	}
	return false
}

// moduleEntries: one generated article per module, grouped by module category.
func (s *Server) moduleEntries(locale string) []docEntry {
	var out []docEntry
	for _, cat := range s.modules {
		for _, m := range cat.Modules {
			out = append(out, docEntry{
				Category: "modules", Slug: m.Key, Title: m.Icon + " " + s.i18n.T(locale, "module."+m.Key+".name"),
				Summary: s.i18n.T(locale, "module."+m.Key+".description"), URL: "/docs/modules/" + m.Key,
				Group: s.i18n.T(locale, "module.category."+cat.Key),
			})
		}
	}
	return out
}

// --- module reference ---

type docModuleView struct {
	Key, Icon, Name, Description, Category string
	About                                  []aboutStep
	Settings                               []docSetting
	Commands                               []docCommand
	Blocks                                 []docBlock
}

type docSetting struct {
	Label, Hint, Type string
	Items             []docSetting
}

type docCommand struct{ Usage, Title, Description string }
type docBlock struct{ Label, Description string }

func (s *Server) moduleDoc(locale, key string) (docModuleView, bool) {
	var v docModuleView
	found := false
	for _, cat := range s.modules {
		for _, m := range cat.Modules {
			if m.Key == key {
				v = docModuleView{Key: key, Icon: m.Icon, Category: s.i18n.T(locale, "module.category."+cat.Key)}
				found = true
			}
		}
	}
	if !found {
		return v, false
	}
	v.Name = s.i18n.T(locale, "module."+key+".name")
	v.Description = s.i18n.T(locale, "module."+key+".description")
	v.About = s.moduleAbout(locale, key)
	look := func(k string) string {
		t, _ := s.i18n.Lookup(locale, k)
		return t
	}
	if sc, ok := moduleSchema(key); ok {
		prefix := "modset." + key + "."
		for _, f := range sc.Fields {
			ds := docSetting{Label: look(prefix + f.Key), Hint: look(prefix + f.Key + "_hint"), Type: f.Type}
			if ds.Label == "" {
				ds.Label = f.Key
			}
			for _, it := range f.Item {
				label := look(prefix + f.Key + "." + it.Key)
				if label == "" {
					label = it.Key
				}
				ds.Items = append(ds.Items, docSetting{Label: label, Hint: look(prefix + f.Key + "." + it.Key + "_hint"), Type: it.Type})
			}
			v.Settings = append(v.Settings, ds)
		}
	}
	for _, c := range s.commands[key] {
		dc := docCommand{Usage: c.Usage, Title: look("command." + c.Name + ".title"), Description: look("command." + c.Name + ".description")}
		v.Commands = append(v.Commands, dc)
	}
	for _, raw := range s.nodeDefs {
		var d struct {
			Module         string `json:"module"`
			LabelKey       string `json:"labelKey"`
			DescriptionKey string `json:"descriptionKey"`
		}
		if json.Unmarshal(raw, &d) == nil && d.Module == key {
			v.Blocks = append(v.Blocks, docBlock{Label: look(d.LabelKey), Description: look(d.DescriptionKey)})
		}
	}
	return v, true
}

// --- pages ---

type docsView struct {
	Categories []docCategoryView
	Query      string
	Results    []docEntry
	// one article
	Article  *docArticleView
	Module   *docModuleView
	Category *docCategoryView
	// editor
	Editor     *docEditorView
	Manage     *docManageView
	CanEdit    bool
	OwnFailing bool // own docs could not be loaded (API down): only the shipped ones show
}

type docArticleView struct {
	Entry         docEntry
	CategoryTitle string
	HTML          template.HTML
	Headings      []mdHeading
	Prev, Next    *docEntry
	Updated       string
	Author        string
}

type docEditorView struct {
	Article    api.DocArticle
	Categories []docCategoryView
	Preview    template.HTML
}

type docManageView struct {
	Own        []api.DocCategory
	Articles   []api.DocArticle
	Categories []docCategoryView
}

func (s *Server) ownDocs(r *http.Request) (api.DocsList, bool) {
	list, err := s.api.Docs(r.Context(), session(r))
	if err != nil {
		return api.DocsList{}, false
	}
	return list, true
}

// handleDocs: the start page (categories), a search (?q=), or a category page.
func (s *Server) handleDocs(w http.ResponseWriter, r *http.Request, p Page) {
	own, ok := s.ownDocs(r)
	v := docsView{Categories: s.docsFor(p.Locale, own, false), Query: strings.TrimSpace(r.URL.Query().Get("q")), CanEdit: ok, OwnFailing: !ok}
	if cat := r.PathValue("category"); cat != "" {
		i := slices.IndexFunc(v.Categories, func(c docCategoryView) bool { return c.Slug == cat })
		if i < 0 {
			s.fail(w, r, p, &api.Error{Status: http.StatusNotFound, Key: "error.not_found"})
			return
		}
		v.Categories[i].Active = true
		v.Category = &v.Categories[i]
	}
	if v.Query != "" {
		v.Results = searchDocs(v.Categories, v.Query)
	}
	p.Nav = "docs"
	s.render(w, http.StatusOK, "docs", "layout", withData(p, v))
}

// searchDocs: titles, summaries and texts of every article (own: title and summary).
func searchDocs(cats []docCategoryView, q string) []docEntry {
	q = strings.ToLower(q)
	var out []docEntry
	for _, c := range cats {
		for _, e := range c.Entries {
			hay := strings.ToLower(e.Title + " " + e.Summary + " " + e.body)
			if e.Category == "modules" {
				hay += " " + strings.ToLower(e.Slug)
			}
			if strings.Contains(hay, q) {
				out = append(out, e)
			}
			if len(out) >= 50 {
				return out
			}
		}
	}
	return out
}

// handleDocArticle: /docs/{category}/{slug} (shipped, own or module reference).
func (s *Server) handleDocArticle(w http.ResponseWriter, r *http.Request, p Page) {
	own, ok := s.ownDocs(r)
	cat, slug := r.PathValue("category"), r.PathValue("slug")
	v := docsView{Categories: s.docsFor(p.Locale, own, false), CanEdit: ok, OwnFailing: !ok}
	p.Nav = "docs"
	ci := slices.IndexFunc(v.Categories, func(c docCategoryView) bool { return c.Slug == cat })
	if ci < 0 {
		s.fail(w, r, p, &api.Error{Status: http.StatusNotFound, Key: "error.not_found"})
		return
	}
	v.Categories[ci].Active = true
	entries := v.Categories[ci].Entries
	ei := slices.IndexFunc(entries, func(e docEntry) bool { return e.Slug == slug })
	if ei < 0 {
		s.fail(w, r, p, &api.Error{Status: http.StatusNotFound, Key: "error.not_found"})
		return
	}
	entries[ei].Active = true
	e := entries[ei]
	av := &docArticleView{Entry: e, CategoryTitle: v.Categories[ci].Icon + " " + v.Categories[ci].Title}
	if ei > 0 {
		av.Prev = &entries[ei-1]
	}
	if ei+1 < len(entries) {
		av.Next = &entries[ei+1]
	}
	switch {
	case cat == "modules" && !e.Own:
		m, found := s.moduleDoc(p.Locale, slug)
		if !found {
			s.fail(w, r, p, &api.Error{Status: http.StatusNotFound, Key: "error.not_found"})
			return
		}
		v.Module = &m
	case e.Own:
		a, err := s.api.Doc(r.Context(), session(r), e.ID)
		if err != nil {
			s.fail(w, r, p, err)
			return
		}
		md := renderMarkdown(a.Content)
		av.HTML, av.Headings, av.Author = md.HTML, md.Headings, a.Author
		av.Updated = formatDocDate(a.UpdatedAt, p.Locale)
	default:
		md := renderMarkdown(e.body)
		av.HTML, av.Headings = md.HTML, md.Headings
	}
	v.Article = av
	s.render(w, http.StatusOK, "docs", "layout", withData(p, v))
}

func formatDocDate(iso, locale string) string {
	if len(iso) < 10 {
		return ""
	}
	if locale == "de" {
		return iso[8:10] + "." + iso[5:7] + "." + iso[0:4]
	}
	return iso[0:10]
}

// --- editor ---

func (s *Server) handleDocEditor(w http.ResponseWriter, r *http.Request, p Page) {
	own, ok := s.ownDocs(r)
	if !ok {
		s.fail(w, r, p, &api.Error{Status: http.StatusServiceUnavailable, Key: "error.api.unreachable"})
		return
	}
	ed := &docEditorView{Categories: s.docsFor(p.Locale, own, true), Article: api.DocArticle{Category: r.URL.Query().Get("category"), Sort: 100, Lang: ""}}
	if id, err := strconv.ParseInt(r.PathValue("id"), 10, 64); err == nil && id > 0 {
		a, err := s.api.Doc(r.Context(), session(r), id)
		if err != nil {
			s.fail(w, r, p, err)
			return
		}
		ed.Article = a
		ed.Preview = renderMarkdown(a.Content).HTML
	}
	if ed.Article.Category == "" {
		ed.Article.Category = "updates"
	}
	p.Nav = "docs"
	s.render(w, http.StatusOK, "docs", "layout", withData(p, docsView{Categories: ed.Categories, Editor: ed, CanEdit: true}))
}

// handleDocPreview renders the editor text (htmx, while typing).
func (s *Server) handleDocPreview(w http.ResponseWriter, r *http.Request, p Page) {
	md := renderMarkdown(r.PostFormValue("content"))
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	_, _ = w.Write([]byte(md.HTML))
}

func (s *Server) handleDocSave(w http.ResponseWriter, r *http.Request, p Page) {
	id, _ := strconv.ParseInt(r.PostFormValue("id"), 10, 64)
	sortOrder, err := strconv.Atoi(strings.TrimSpace(r.PostFormValue("sort")))
	if err != nil {
		sortOrder = 100
	}
	in := api.DocArticle{
		Category: r.PostFormValue("category"), Slug: strings.TrimSpace(r.PostFormValue("slug")), Lang: r.PostFormValue("lang"),
		Title: strings.TrimSpace(r.PostFormValue("title")), Summary: strings.TrimSpace(r.PostFormValue("summary")),
		Content: r.PostFormValue("content"), Published: r.PostFormValue("published") == "true", Sort: sortOrder,
	}
	a, err := s.api.SaveDoc(r.Context(), session(r), id, in)
	if err != nil {
		s.failTo(w, r, p, err, "#doc-editor-error")
		return
	}
	if a.Published {
		redirect(w, r, "/docs/"+a.Category+"/"+a.Slug)
		return
	}
	redirect(w, r, fmt.Sprintf("/docs/edit/%d", a.ID))
}

func (s *Server) handleDocDelete(w http.ResponseWriter, r *http.Request, p Page) {
	id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil {
		s.fail(w, r, p, &api.Error{Status: http.StatusNotFound, Key: "error.not_found"})
		return
	}
	if err := s.api.DeleteDoc(r.Context(), session(r), id); err != nil {
		s.fail(w, r, p, err)
		return
	}
	redirect(w, r, "/docs/manage")
}

// handleDocManage: own articles (drafts too) and own categories.
func (s *Server) handleDocManage(w http.ResponseWriter, r *http.Request, p Page) {
	own, ok := s.ownDocs(r)
	if !ok {
		s.fail(w, r, p, &api.Error{Status: http.StatusServiceUnavailable, Key: "error.api.unreachable"})
		return
	}
	cats := s.docsFor(p.Locale, own, true)
	p.Nav = "docs"
	s.render(w, http.StatusOK, "docs", "layout", withData(p, docsView{Categories: s.docsFor(p.Locale, own, false), CanEdit: true,
		Manage: &docManageView{Own: own.Categories, Articles: own.Articles, Categories: cats}}))
}

func (s *Server) handleDocCategorySave(w http.ResponseWriter, r *http.Request, p Page) {
	sortOrder, err := strconv.Atoi(strings.TrimSpace(r.PostFormValue("sort")))
	if err != nil {
		sortOrder = 100
	}
	slug := strings.ToLower(strings.TrimSpace(r.PostFormValue("slug")))
	if slices.ContainsFunc(s.docs.Categories, func(c docCategoryDef) bool { return c.Slug == slug }) {
		s.failTo(w, r, p, &api.Error{Status: http.StatusConflict, Key: "error.docs.category_shipped"}, "#doc-category-error")
		return
	}
	in := api.DocCategory{Slug: slug, Icon: strings.TrimSpace(r.PostFormValue("icon")), Title: strings.TrimSpace(r.PostFormValue("title")), Sort: sortOrder}
	if err := s.api.SaveDocCategory(r.Context(), session(r), in); err != nil {
		s.failTo(w, r, p, err, "#doc-category-error")
		return
	}
	redirect(w, r, "/docs/manage")
}

func (s *Server) handleDocCategoryDelete(w http.ResponseWriter, r *http.Request, p Page) {
	if err := s.api.DeleteDocCategory(r.Context(), session(r), r.PathValue("slug")); err != nil {
		s.failTo(w, r, p, err, "#doc-category-error")
		return
	}
	redirect(w, r, "/docs/manage")
}
