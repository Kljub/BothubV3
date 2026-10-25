package main

import (
	"encoding/json"
	"testing"
)

// A bot from PHP with an empty count list ([] in PHP) still reads.
func TestBotWithEmptyCountGroups(t *testing.T) {
	for _, raw := range []string{
		`{"id":1,"commandCounts":{"slash":3,"user":0,"message":0,"groups":[]}}`,
		`{"id":1,"commandCounts":{"slash":3,"groups":{"moderation":2}}}`,
		`{"id":1,"commandCounts":null}`,
	} {
		var b bot
		if err := json.Unmarshal([]byte(raw), &b); err != nil {
			t.Fatalf("%s: %v", raw, err)
		}
	}
	var b bot
	_ = json.Unmarshal([]byte(`{"commandCounts":{"slash":3,"groups":{"moderation":2}}}`), &b)
	if b.CommandCounts.Slash != 3 || b.CommandCounts.Groups["moderation"] != 2 {
		t.Fatalf("counts: %+v", b.CommandCounts)
	}
}
