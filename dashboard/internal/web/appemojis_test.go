package web

import "testing"

func TestEmojiName(t *testing.T) {
	for in, want := range map[string]string{
		"party-parrot.gif": "party_parrot",
		"pics/Pepe Hi.png": "Pepe_Hi",
		"x.png":            "x_",
		"äöü.webp":         "__",
		"a_very_long_name_that_goes_on_and_on_forever.png": "a_very_long_name_that_goes_on_an",
	} {
		if got := emojiName(in); got != want {
			t.Errorf("emojiName(%q) = %q, want %q", in, got, want)
		}
	}
}
