package web

import (
	"net/http/httptest"
	"testing"
)

func TestBrowserIPTrustsOnlyLocalProxies(t *testing.T) {
	r := httptest.NewRequest("GET", "/", nil)
	r.RemoteAddr = "203.0.113.9:5000"
	r.Header.Set("X-Forwarded-For", "1.1.1.1")
	if got := browserIP(r); got != "203.0.113.9" {
		t.Fatalf("a client cannot pick its address: %s", got)
	}
	r.RemoteAddr = "172.18.0.1:5000"
	r.Header.Set("X-Forwarded-For", "6.6.6.6, 198.51.100.7")
	if got := browserIP(r); got != "198.51.100.7" {
		t.Fatalf("behind the proxy the address it saw counts: %s", got)
	}
}
