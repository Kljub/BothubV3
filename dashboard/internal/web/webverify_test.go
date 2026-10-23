package web

import (
	"strings"
	"testing"

	"github.com/Kljub/BothubV3/dashboard/internal/api"
	"github.com/Kljub/BothubV3/dashboard/ui"
)

func TestVerifyPage(t *testing.T) {
	tpl, err := parseTemplates(ui.FS)
	if err != nil {
		t.Fatal(err)
	}
	set := tpl.sets["verify"]
	if set == nil {
		t.Fatal("no template set for verify.html")
	}
	token := strings.Repeat("a", 43)
	bot := api.VerifyPage{BotName: "Guard <X>", ApplicationID: "123456789012345678", VPNCheck: true}
	for _, c := range []struct {
		v    verifyPageView
		want []string
		not  string
	}{
		{verifyPageView{Token: token, Bot: bot, Lang: "de"}, []string{"Guard &lt;X&gt;", "proxycheck.io", "/privacy?lang=de#web-verify", `href="/verify/` + token + `/start"`}, "verifiziert."},
		{verifyPageView{Token: token, Bot: api.VerifyPage{BotName: "B"}, Lang: "en"}, []string{"Sign in with Discord and verify"}, "proxycheck.io"},
		{verifyPageView{Token: token, Bot: bot, Lang: "en", Result: &api.VerifyResult{Status: "passed"}}, []string{"You are verified"}, "/start"},
		{verifyPageView{Token: token, Bot: bot, Lang: "en", Result: &api.VerifyResult{Status: "review"}}, []string{"server team still checks"}, "/start"},
		{verifyPageView{Token: token, Bot: bot, Lang: "de", Result: &api.VerifyResult{Status: "retry", Reasons: []string{"vpn"}}}, []string{"VPN, Proxy oder Tor erkannt", `href="/verify/` + token + `/start"`}, "Du bist verifiziert"},
		{verifyPageView{Token: token, Bot: bot, Lang: "en", Result: &api.VerifyResult{Status: "blocked"}}, []string{"did not succeed"}, "/start"},
		{verifyPageView{Lang: "en", Error: "expired"}, []string{"expired or was used already"}, "/start"},
		{verifyPageView{Token: token, Bot: bot, Lang: "en", Error: "wrong_account"}, []string{"another Discord account", "/start"}, "You are verified"},
	} {
		var out strings.Builder
		if err := set.ExecuteTemplate(&out, "verify_layout", Page{Data: c.v}); err != nil {
			t.Fatal(err)
		}
		for _, w := range c.want {
			if !strings.Contains(out.String(), w) {
				t.Errorf("%s/%s%s: missing %q", c.v.Lang, c.v.Error, statusOf(c.v), w)
			}
		}
		if strings.Contains(out.String(), c.not) {
			t.Errorf("%s/%s%s: must not contain %q", c.v.Lang, c.v.Error, statusOf(c.v), c.not)
		}
	}
	if !verifyTokenPattern.MatchString(token) || verifyTokenPattern.MatchString("short") || verifyTokenPattern.MatchString(strings.Repeat("a", 42)+"/") {
		t.Fatal("token pattern")
	}
}

func statusOf(v verifyPageView) string {
	if v.Result == nil {
		return ""
	}
	return "/" + v.Result.Status
}

// The Web Verify section is on /privacy once a module added it, and the
// "last updated" date follows it.
func TestLegalPrivacySection(t *testing.T) {
	tpl, err := parseTemplates(ui.FS)
	if err != nil {
		t.Fatal(err)
	}
	set := tpl.sets["legal"]
	for _, lang := range []string{"de", "en"} {
		for _, on := range []bool{false, true} {
			v := legalView{Kind: "privacy", Lang: lang}
			if on {
				v.Disclosures = map[string]api.Disclosure{"webVerify": {Since: "2026-10-22T10:00:00Z", Module: "web-verify"}}
			}
			var out strings.Builder
			if err := set.ExecuteTemplate(&out, "legal_layout", Page{Data: v}); err != nil {
				t.Fatal(err)
			}
			if got := strings.Contains(out.String(), `id="web-verify"`) && strings.Contains(out.String(), "HMAC-SHA-256"); got != on {
				t.Errorf("%s: section shown = %v, want %v", lang, got, on)
			}
		}
	}
}

// Modules with a privacy section warn before their first activation; once
// the section is on /privacy the toggle switches without the dialog.
func TestModuleToggleWarnsAboutPrivacy(t *testing.T) {
	tpl, err := parseTemplates(ui.FS)
	if err != nil {
		t.Fatal(err)
	}
	set := tpl.sets["bot"]
	info := ModuleInfo{Key: "web-verify", Icon: "🌍", PrivacySection: "webVerify"}
	for _, c := range []struct {
		v    moduleView
		warn bool
	}{
		{moduleView{BotID: 1, ModuleInfo: info}, true},
		{moduleView{BotID: 1, ModuleInfo: info, Disclosed: true}, false},
		{moduleView{BotID: 1, ModuleInfo: ModuleInfo{Key: "polls", Icon: "📊"}}, false},
	} {
		var out strings.Builder
		if err := set.ExecuteTemplate(&out, "module_card", c.v); err != nil {
			t.Fatal(err)
		}
		html := out.String()
		got := strings.Contains(html, `data-privacy-warn="privacy-warn-web-verify"`) && strings.Contains(html, `<dialog id="privacy-warn-web-verify"`) && strings.Contains(html, `name="privacy_ack" value="true" disabled`)
		if got != c.warn {
			t.Errorf("%s disclosed=%v: warning = %v, want %v", c.v.Key, c.v.Disclosed, got, c.warn)
		}
	}
}
