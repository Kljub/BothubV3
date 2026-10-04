package web

import (
	"net/http"
	"net/url"
	"strings"
)

// Device check: a session bound to a browser key (WebCrypto, see app.js)
// proves now and then that the browser still holds the key. When the proof
// ran out, pages come here; app.js signs the gateway's challenge through the
// /api proxy and goes back to Next.

type deviceCheckView struct {
	Next string
}

func (s *Server) handleDeviceCheck(w http.ResponseWriter, r *http.Request) {
	s.render(w, http.StatusOK, "device_check", "auth_layout", withData(s.pageFor(r, nil), deviceCheckView{Next: safeNext(r.URL.Query().Get("next"))}))
}

// returnPath is where a request should go back to after the device check:
// the page itself, or for htmx the page the browser shows.
func returnPath(r *http.Request) string {
	if isHTMX(r) {
		if u, err := url.Parse(r.Header.Get("HX-Current-URL")); err == nil {
			return safeNext(u.RequestURI())
		}
		return "/"
	}
	if r.Method != http.MethodGet {
		return "/"
	}
	return safeNext(r.URL.RequestURI())
}

// safeNext keeps only local paths (no other hosts, no "//" or "/\\").
func safeNext(next string) string {
	if !strings.HasPrefix(next, "/") || strings.HasPrefix(next, "//") || strings.HasPrefix(next, "/\\") || strings.HasPrefix(next, "/device-check") {
		return "/"
	}
	return next
}
