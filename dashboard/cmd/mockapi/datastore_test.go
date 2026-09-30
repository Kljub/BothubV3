package main

import (
	"encoding/json"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestKeyFromName(t *testing.T) {
	for in, want := range map[string]string{"Daily Coins": "daily_coins", "  XP!! ": "xp", "2nd place": "nd_place", "Ärger": "rger"} {
		if got := keyFromName(in); got != want {
			t.Errorf("keyFromName(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestValidDataValue(t *testing.T) {
	cases := []struct {
		typ, v string
		ok     bool
	}{
		{"number", "12.5", true}, {"number", "abc", false}, {"number", "NaN", false}, {"number", "Inf", false}, {"number", "1e999", false}, {"number", "-3e2", true},
		{"list", `["a", 1]`, true}, {"list", `[{"a":1}]`, false},
		{"object", `{"a":"b"}`, true}, {"object", `[1]`, false},
		{"object_list", `[{"a":1}]`, true}, {"object_list", `{"a":1}`, false},
		{"text", "anything", true}, {"number", "", true},
	}
	for _, c := range cases {
		if got := validDataValue(c.typ, c.v); got != c.ok {
			t.Errorf("validDataValue(%s, %q) = %v", c.typ, c.v, got)
		}
	}
}

func TestDataStorageFlow(t *testing.T) {
	s := &store{customCmds: map[int64][]*customCommand{}}
	b := &bot{ID: 1}
	call := func(h botHandler, method, target, body string, vid string) (int, map[string]any) {
		r := httptest.NewRequest(method, target, strings.NewReader(body))
		r.Header.Set("Content-Type", "application/json")
		r.SetPathValue("vid", vid)
		w := httptest.NewRecorder()
		h(w, r, b)
		var out map[string]any
		_ = json.Unmarshal(w.Body.Bytes(), &out)
		return w.Code, out
	}

	code, v := call(s.createDataVariable, "POST", "/", `{"name":"Coins","type":"number","owner":"member","perServer":true,"defaultValue":"0"}`, "")
	if code != 201 || v["key"] != "coins" {
		t.Fatalf("create = %d %v", code, v)
	}
	if code, _ := call(s.createDataVariable, "POST", "/", `{"name":"coins","type":"text","owner":"shared","perServer":false}`, ""); code != 409 {
		t.Fatalf("duplicate key = %d, want 409", code)
	}
	// A member value needs a server and a member ID; numbers only.
	if code, _ := call(s.setDataValue, "PUT", "/", `{"ownerId":"123456789012345678","value":"5"}`, "1"); code != 422 {
		t.Fatalf("missing server = %d, want 422", code)
	}
	if code, _ := call(s.setDataValue, "PUT", "/", `{"serverId":"223456789012345678","ownerId":"123456789012345678","value":"x"}`, "1"); code != 422 {
		t.Fatalf("text in number = %d, want 422", code)
	}
	if code, _ := call(s.setDataValue, "PUT", "/", `{"serverId":"223456789012345678","ownerId":"123456789012345678","value":"5"}`, "1"); code != 200 {
		t.Fatalf("set = %d", code)
	}
	code, list := call(s.listDataValues, "GET", "/?q=1234", "", "1")
	if code != 200 || list["total"].(float64) != 1 {
		t.Fatalf("list = %d %v", code, list)
	}
	code, look := call(s.lookupDataValues, "GET", "/?id=123456789012345678", "", "")
	if code != 200 || len(look["items"].([]any)) != 1 {
		t.Fatalf("lookup = %d %v", code, look)
	}

	// Used in: a command that references {var.coins}.
	s.customCmds[1] = []*customCommand{{Graph: json.RawMessage(`{"nodes":[{"config":{"text":"You have {var.coins}"}}]}`)}}
	_, all := call(s.listDataVariables, "GET", "/", "", "")
	first := all["items"].([]any)[0].(map[string]any)
	if first["usedIn"].(float64) != 1 || first["values"].(float64) != 1 {
		t.Fatalf("variable = %v", first)
	}

	// Changing the owner drops the stored values.
	if code, _ := call(s.updateDataVariable, "PUT", "/", `{"name":"Coins","type":"number","owner":"shared","perServer":true}`, "1"); code != 200 {
		t.Fatalf("update = %d", code)
	}
	if n := len(s.data.values[1]); n != 0 {
		t.Fatalf("values after owner change = %d, want 0", n)
	}
	if code, _ := call(s.deleteDataVariable, "DELETE", "/", "", "1"); code != 204 {
		t.Fatalf("delete = %d", code)
	}
}
