package web

import "testing"

func TestBuilderCookie(t *testing.T) {
	c := builderCookie{Bot: 3, ID: 2594, Module: "moderation"}
	if got := parseBuilderCookie(c.String()); got != c {
		t.Fatalf("round trip = %+v", got)
	}
	for _, bad := range []string{"", "x", "1", "a.2.", "0.5.", "1.-2."} {
		if got := parseBuilderCookie(bad); got.ID != 0 {
			t.Errorf("%q = %+v", bad, got)
		}
	}
}
