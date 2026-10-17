package web

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/Kljub/BothubV3/dashboard/internal/api"
)

func TestShareFileChecks(t *testing.T) {
	ok := `{"format":"bothub.commands","version":1,"kind":"commands","items":[{"name":"hello","graph":{}}]}`
	if _, err := parseShareFile([]byte(ok), api.KindCommand); err != nil {
		t.Fatal(err)
	}
	for in, want := range map[string]string{
		`{"format":"other"}`: "cmdshare.import.bad_file",
		`not json`:           "cmdshare.import.bad_file",
		strings.Replace(ok, `"version":1`, `"version":2`, 1):                    "cmdshare.import.newer",
		strings.Replace(ok, `"commands"`, `"events"`, 1):                        "cmdshare.import.wrong_kind",
		`{"format":"bothub.commands","version":1,"kind":"commands","items":[]}`: "cmdshare.import.count",
	} {
		if _, err := parseShareFile([]byte(in), api.KindCommand); err == nil || err.Error() != want {
			t.Errorf("%s: %v, want %s", in, err, want)
		}
	}
}

func TestImportNames(t *testing.T) {
	if importName("hello", 0) != "hello" || importName("hello", 1) != "hello-2" || importName("ticket close", 2) != "ticket close-3" {
		t.Error("suffix")
	}
	long := strings.Repeat("a", 32)
	if got := importName(long, 1); len(got) != 32 || !strings.HasSuffix(got, "-2") {
		t.Errorf("long name: %q", got)
	}
	g := withCommandName(json.RawMessage(`{"nodes":[{"type":"trigger.slash","config":{"command_name":"hello"}},{"type":"action.send_message"}]}`), "hello-2")
	if !strings.Contains(string(g), `"command_name":"hello-2"`) {
		t.Errorf("graph: %s", g)
	}
}
