package web

import (
	"strings"
	"testing"

	"github.com/Kljub/BothubV3/dashboard/ui"
)

func TestLegalPages(t *testing.T) {
	tpl, err := parseTemplates(ui.FS)
	if err != nil {
		t.Fatal(err)
	}
	set := tpl.sets["legal"]
	if set == nil {
		t.Fatal("no template set for legal.html")
	}
	cases := []struct {
		kind, lang string
		want       []string
	}{
		{"terms", "de", []string{"Nutzungsbedingungen", "Max &lt;Muster&gt;", "Musterweg 1<br>", "mailto:bot@example.org", "nicht von Discord Inc.", "13 Jahre", "nicht kommerzielles Angebot", "Open-Source-Projekt", "https://github.com/Kljub/BothubV3", "nur für Vorsatz und grobe Fahrlässigkeit", "Stand: 4. Oktober 2026"}},
		{"privacy", "de", []string{"Datenschutzerklärung", "Verantwortlicher", "Löschung oder Änderung beantragen", "nicht zum Training von KI-Modellen", "AES-256-GCM"}},
		{"terms", "en", []string{"Terms of Service", "must follow Discord's", "Last updated: October 4, 2026"}},
		{"privacy", "en", []string{"Privacy Policy", "Request deletion or changes", "bot@example.org"}},
	}
	for _, c := range cases {
		v := legalView{Kind: c.kind, Lang: c.lang, Operator: "Max <Muster>", Address: []string{"Musterweg 1", "12345 Berlin"}, Email: "bot@example.org", Source: "https://github.com/Kljub/BothubV3", Updated: formatDateOnly(legalVersion, c.lang)}
		var out strings.Builder
		if err := set.ExecuteTemplate(&out, "legal_layout", Page{Data: v}); err != nil {
			t.Fatalf("%s/%s: %v", c.kind, c.lang, err)
		}
		for _, w := range c.want {
			if !strings.Contains(out.String(), w) {
				t.Errorf("%s/%s: missing %q", c.kind, c.lang, w)
			}
		}
	}
	// Without operator details the pages still render (contact through the operator).
	var out strings.Builder
	if err := set.ExecuteTemplate(&out, "legal_layout", Page{Data: legalView{Kind: "privacy", Lang: "de"}}); err != nil || !strings.Contains(out.String(), "dem Betreiber dieser Installation") {
		t.Fatalf("empty details: %v", err)
	}
}
