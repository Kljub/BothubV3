package web

import "testing"

func TestCdnSize(t *testing.T) {
	banner := "https://cdn.discordapp.com/banners/1/abc.png?size=600"
	cases := []struct {
		in   any
		want string
	}{
		{banner, "https://cdn.discordapp.com/banners/1/abc.png?size=2048"},
		{&banner, "https://cdn.discordapp.com/banners/1/abc.png?size=2048"},
		{"https://cdn.discordapp.com/banners/1/a_x.gif", "https://cdn.discordapp.com/banners/1/a_x.gif?size=2048"},
		{"data:image/png;base64,AAAA", "data:image/png;base64,AAAA"},
		{"https://example.com/b.png?size=10", "https://example.com/b.png?size=10"},
		{(*string)(nil), ""},
	}
	for _, c := range cases {
		if got := cdnSize(c.in, 2048); got != c.want {
			t.Errorf("cdnSize(%v) = %q, want %q", c.in, got, c.want)
		}
	}
}

func TestSelfProcess(t *testing.T) {
	s := newSelfSampler()
	p := s.process()
	if p.Key != "dashboard" || p.Status != "running" || p.PID == 0 || p.MemoryBytes <= 0 {
		t.Fatalf("self process = %+v", p)
	}
	if p.CPUPercent < 0 {
		t.Fatalf("negative CPU: %v", p.CPUPercent)
	}
}
