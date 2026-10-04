package web

import (
	"fmt"
	"html"
	"html/template"
	"regexp"
	"strings"
)

// A small Markdown renderer for the docs. Every text is escaped; raw HTML
// is never passed through, so articles written in the dashboard cannot
// inject markup. Supported: # headings (with anchors), paragraphs, lists
// (- * 1.), task-free nested lists by indentation, ``` code blocks,
// > quotes and callouts (> [!NOTE] / [!TIP] / [!WARNING]), tables, ---,
// **bold**, *italic*, `code`, [links](…) and ![images](…) (http(s), / or #
// only), and {{key}} placeholders are left as text.

type mdHeading struct {
	Level int
	ID    string
	Text  string
}

type mdResult struct {
	HTML     template.HTML
	Headings []mdHeading
}

var (
	mdOrdered  = regexp.MustCompile(`^(\s*)(\d{1,3})[.)]\s+(.*)$`)
	mdBullet   = regexp.MustCompile(`^(\s*)[-*+]\s+(.*)$`)
	mdHeadRe   = regexp.MustCompile(`^(#{1,4})\s+(.+?)\s*#*$`)
	mdTableSep = regexp.MustCompile(`^\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?$`)
	mdSlugRe   = regexp.MustCompile(`[^\p{L}\p{N}]+`)
	mdInline   = regexp.MustCompile("(!?\\[[^\\]]*\\]\\([^)\\s]+\\))|(`[^`]+`)|(\\*\\*[^*]+\\*\\*)|(\\*[^*\\s][^*]*\\*)")
	mdLinkRe   = regexp.MustCompile(`^(!?)\[([^\]]*)\]\(([^)\s]+)\)$`)
)

// renderMarkdown turns Markdown into safe HTML.
func renderMarkdown(src string) mdResult {
	r := &mdRenderer{ids: map[string]int{}}
	lines := strings.Split(strings.ReplaceAll(src, "\r\n", "\n"), "\n")
	r.blocks(lines)
	return mdResult{HTML: template.HTML(r.out.String()), Headings: r.headings}
}

type mdRenderer struct {
	out      strings.Builder
	headings []mdHeading
	ids      map[string]int
}

func (r *mdRenderer) blocks(lines []string) {
	for i := 0; i < len(lines); {
		line := lines[i]
		trim := strings.TrimSpace(line)
		switch {
		case trim == "":
			i++
		case strings.HasPrefix(trim, "```"):
			lang := strings.TrimSpace(strings.TrimPrefix(trim, "```"))
			var code []string
			i++
			for i < len(lines) && !strings.HasPrefix(strings.TrimSpace(lines[i]), "```") {
				code = append(code, lines[i])
				i++
			}
			i++ // closing fence
			class := ""
			if regexp.MustCompile(`^[a-z0-9+-]{1,20}$`).MatchString(lang) {
				class = fmt.Sprintf(` class="lang-%s"`, lang)
			}
			fmt.Fprintf(&r.out, "<pre><code%s>%s</code></pre>\n", class, html.EscapeString(strings.Join(code, "\n")))
		case mdHeadRe.MatchString(trim):
			m := mdHeadRe.FindStringSubmatch(trim)
			level := len(m[1])
			id := r.anchor(m[2])
			r.headings = append(r.headings, mdHeading{Level: level, ID: id, Text: plainText(m[2])})
			fmt.Fprintf(&r.out, "<h%d id=\"%s\">%s</h%d>\n", level, id, inline(m[2]), level)
			i++
		case trim == "---" || trim == "***":
			r.out.WriteString("<hr>\n")
			i++
		case strings.HasPrefix(trim, ">"):
			var quote []string
			for i < len(lines) && strings.HasPrefix(strings.TrimSpace(lines[i]), ">") {
				quote = append(quote, strings.TrimPrefix(strings.TrimPrefix(strings.TrimSpace(lines[i]), ">"), " "))
				i++
			}
			kind := ""
			if len(quote) > 0 {
				if m := regexp.MustCompile(`^\[!(NOTE|TIP|WARNING)\]\s*$`).FindStringSubmatch(strings.TrimSpace(quote[0])); m != nil {
					kind = strings.ToLower(m[1])
					quote = quote[1:]
				}
			}
			inner := &mdRenderer{ids: r.ids}
			inner.blocks(quote)
			if kind != "" {
				fmt.Fprintf(&r.out, "<div class=\"doc-callout doc-callout-%s\">%s</div>\n", kind, inner.out.String())
			} else {
				fmt.Fprintf(&r.out, "<blockquote>%s</blockquote>\n", inner.out.String())
			}
		case strings.HasPrefix(trim, "|") && i+1 < len(lines) && mdTableSep.MatchString(strings.TrimSpace(lines[i+1])):
			head := tableCells(trim)
			i += 2
			r.out.WriteString("<div class=\"doc-table\"><table><thead><tr>")
			for _, c := range head {
				fmt.Fprintf(&r.out, "<th>%s</th>", inline(c))
			}
			r.out.WriteString("</tr></thead><tbody>")
			for i < len(lines) && strings.HasPrefix(strings.TrimSpace(lines[i]), "|") {
				r.out.WriteString("<tr>")
				for _, c := range tableCells(strings.TrimSpace(lines[i])) {
					fmt.Fprintf(&r.out, "<td>%s</td>", inline(c))
				}
				r.out.WriteString("</tr>")
				i++
			}
			r.out.WriteString("</tbody></table></div>\n")
		case mdBullet.MatchString(line) || mdOrdered.MatchString(line):
			i = r.list(lines, i, indentOf(line))
		default:
			var para []string
			for i < len(lines) {
				t := strings.TrimSpace(lines[i])
				if t == "" || strings.HasPrefix(t, "```") || mdHeadRe.MatchString(t) || strings.HasPrefix(t, ">") || t == "---" ||
					mdBullet.MatchString(lines[i]) || mdOrdered.MatchString(lines[i]) || (strings.HasPrefix(t, "|") && i+1 < len(lines) && mdTableSep.MatchString(strings.TrimSpace(lines[i+1]))) {
					break
				}
				para = append(para, t)
				i++
			}
			fmt.Fprintf(&r.out, "<p>%s</p>\n", inline(strings.Join(para, " ")))
		}
	}
}

// list renders a list starting at lines[i] with the given indentation; deeper items nest.
func (r *mdRenderer) list(lines []string, i, indent int) int {
	ordered := mdOrdered.MatchString(lines[i])
	tag := "ul"
	if ordered {
		tag = "ol"
	}
	fmt.Fprintf(&r.out, "<%s>", tag)
	for i < len(lines) {
		line := lines[i]
		if strings.TrimSpace(line) == "" {
			// A blank line ends the list unless the next line is an item of it.
			if i+1 < len(lines) && (mdBullet.MatchString(lines[i+1]) || mdOrdered.MatchString(lines[i+1])) && indentOf(lines[i+1]) >= indent {
				i++
				continue
			}
			break
		}
		var text string
		if m := mdBullet.FindStringSubmatch(line); m != nil && !ordered {
			text = m[2]
		} else if m := mdOrdered.FindStringSubmatch(line); m != nil && ordered {
			text = m[3]
		} else {
			break
		}
		if indentOf(line) != indent {
			break
		}
		r.out.WriteString("<li>")
		r.out.WriteString(string(inline(text)))
		i++
		// Continuation lines and nested lists.
		for i < len(lines) && strings.TrimSpace(lines[i]) != "" {
			next := lines[i]
			if (mdBullet.MatchString(next) || mdOrdered.MatchString(next)) && indentOf(next) > indent {
				i = r.list(lines, i, indentOf(next))
				continue
			}
			if mdBullet.MatchString(next) || mdOrdered.MatchString(next) || indentOf(next) <= indent {
				break
			}
			r.out.WriteString(" " + string(inline(strings.TrimSpace(next))))
			i++
		}
		r.out.WriteString("</li>")
	}
	fmt.Fprintf(&r.out, "</%s>\n", tag)
	return i
}

func indentOf(line string) int {
	return len(strings.ReplaceAll(line, "\t", "    ")) - len(strings.TrimLeft(strings.ReplaceAll(line, "\t", "    "), " "))
}

func tableCells(row string) []string {
	row = strings.TrimSuffix(strings.TrimPrefix(row, "|"), "|")
	cells := strings.Split(row, "|")
	for i, c := range cells {
		cells[i] = strings.TrimSpace(c)
	}
	return cells
}

// anchor: a unique id from a heading ("Erste Schritte" -> "erste-schritte").
func (r *mdRenderer) anchor(text string) string {
	base := strings.Trim(mdSlugRe.ReplaceAllString(strings.ToLower(plainText(text)), "-"), "-")
	if base == "" {
		base = "section"
	}
	r.ids[base]++
	if n := r.ids[base]; n > 1 {
		return fmt.Sprintf("%s-%d", base, n)
	}
	return base
}

// plainText: a heading without its Markdown marks.
func plainText(s string) string {
	return strings.NewReplacer("**", "", "`", "", "*", "").Replace(s)
}

// safeURL: only http(s), site paths and anchors; anything else (javascript:, data:) is dropped.
func safeURL(u string) (string, bool) {
	l := strings.ToLower(u)
	if strings.HasPrefix(l, "https://") || strings.HasPrefix(l, "http://") || (strings.HasPrefix(u, "/") && !strings.HasPrefix(u, "//")) || strings.HasPrefix(u, "#") {
		return u, true
	}
	return "", false
}

// inline renders the marks of one line; the text between them is escaped.
func inline(s string) template.HTML {
	var b strings.Builder
	last := 0
	for _, m := range mdInline.FindAllStringIndex(s, -1) {
		b.WriteString(html.EscapeString(s[last:m[0]]))
		tok := s[m[0]:m[1]]
		switch {
		case strings.HasPrefix(tok, "`"):
			fmt.Fprintf(&b, "<code>%s</code>", html.EscapeString(strings.Trim(tok, "`")))
		case strings.HasPrefix(tok, "**"):
			fmt.Fprintf(&b, "<strong>%s</strong>", inline(strings.Trim(tok, "*")))
		case strings.HasPrefix(tok, "*"):
			fmt.Fprintf(&b, "<em>%s</em>", inline(strings.Trim(tok, "*")))
		default:
			lm := mdLinkRe.FindStringSubmatch(tok)
			u, ok := safeURL(lm[3])
			switch {
			case !ok:
				b.WriteString(html.EscapeString(lm[2]))
			case lm[1] == "!":
				fmt.Fprintf(&b, `<img src="%s" alt="%s" loading="lazy">`, html.EscapeString(u), html.EscapeString(lm[2]))
			case strings.HasPrefix(u, "http"):
				fmt.Fprintf(&b, `<a href="%s" target="_blank" rel="noopener noreferrer">%s</a>`, html.EscapeString(u), inline(lm[2]))
			default:
				fmt.Fprintf(&b, `<a href="%s">%s</a>`, html.EscapeString(u), inline(lm[2]))
			}
		}
		last = m[1]
	}
	b.WriteString(html.EscapeString(s[last:]))
	return template.HTML(b.String())
}
