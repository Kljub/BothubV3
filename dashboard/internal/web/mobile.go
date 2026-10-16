package web

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"html/template"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/Kljub/BothubV3/dashboard/internal/api"
	"rsc.io/qr"
)

// Settings → Mobile App: pair a phone with the BotHub app
// (github.com/Kljub/BotHubAndroitApp) by QR code, list and remove paired
// phones, choose their push events. The QR code holds
// bothub://pair?server=<dashboard address>&code=<one-time code>; the app
// trades the code at <server>/api/v1/mobile/pair (gateway mobile.go).

const mobileAppURL = "https://github.com/Kljub/BotHubAndroitApp/releases/latest"

var mobileNotify = []string{"bot_offline", "bot_error", "update"}

type mobileDeviceRow struct {
	api.MobileDevice
	LastSeen string
	Created  string
	Events   map[string]bool
}

type mobileView struct {
	Devices []mobileDeviceRow
	Notice  string
	AppURL  string
	Events  []string
	// Pairing: the open code as QR code.
	Pairing *mobilePairingView
}

type mobilePairingView struct {
	ID      string
	KeyID   string
	User    string
	QR      template.URL
	Link    string
	Rotates int // seconds until the next key
	Left    int // minutes the pairing stays open
	Paired  *api.MobileDevice
	Expired bool
}

// pairLink: what the QR code holds: dashboard address, user and the
// validation key of the moment (new every 30 seconds).
func pairLink(server, user, code string) string {
	return "bothub://pair?" + url.Values{"server": {server}, "user": {user}, "code": {code}}.Encode()
}

// pairingView draws the QR code of the current key.
func pairingView(r *http.Request, p api.MobilePairing) (mobilePairingView, error) {
	link := pairLink(baseURL(r), p.User, p.Code)
	code, err := qr.Encode(link, qr.M)
	if err != nil {
		return mobilePairingView{}, fmt.Errorf("qr: %w", err)
	}
	return mobilePairingView{
		ID: p.ID, KeyID: p.KeyID, User: p.User, Link: link,
		QR:      template.URL("data:image/png;base64," + base64.StdEncoding.EncodeToString(code.PNG())),
		Rotates: max(1, int(time.Until(p.RotatesAt).Seconds()+0.5)),
		Left:    max(1, int(time.Until(p.ExpiresAt).Minutes()+0.5)),
	}, nil
}

func (s *Server) renderMobile(w http.ResponseWriter, r *http.Request, p Page, notice string) {
	s.renderMobileAs(w, r, p, notice, "mobile_fragment")
}

// renderMobileAs draws the devices with a fragment (full tab or the account line).
func (s *Server) renderMobileAs(w http.ResponseWriter, r *http.Request, p Page, notice, fragment string) {
	list, err := s.api.MobileDevices(r.Context(), session(r))
	if err != nil {
		s.failTo(w, r, p, err, "#account-flash")
		return
	}
	v := mobileView{Notice: notice, AppURL: mobileAppURL, Events: mobileNotify}
	for _, d := range list {
		row := mobileDeviceRow{MobileDevice: d, LastSeen: formatDateTime(d.LastSeenAt, p.Locale), Created: formatDateTime(d.CreatedAt, p.Locale), Events: map[string]bool{}}
		for _, e := range d.Notify {
			row.Events[e] = true
		}
		v.Devices = append(v.Devices, row)
	}
	s.render(w, http.StatusOK, "error", fragment, withData(p, v))
}

// handleGuard: BotHub Guard switches in the Security tab.
func (s *Server) handleGuard(w http.ResponseWriter, r *http.Request, p Page) {
	s.renderMobileAs(w, r, p, "", "guard_fragment")
}

// handleGuardToggle: Guard on or off for one phone (checkbox state of the request).
func (s *Server) handleGuardToggle(w http.ResponseWriter, r *http.Request, p Page) {
	if err := s.api.SetMobileGuard(r.Context(), session(r), r.PathValue("did"), r.PostFormValue("guard") == "1"); err != nil {
		s.failTo(w, r, p, err, "#account-flash")
		return
	}
	s.renderMobileAs(w, r, p, "settings.guard.saved", "guard_fragment")
}

// handleMobileList: the paired phones in the Account tab (under the e-mail address).
func (s *Server) handleMobileList(w http.ResponseWriter, r *http.Request, p Page) {
	s.renderMobileAs(w, r, p, "", "mobile_list_fragment")
}

func (s *Server) handleMobile(w http.ResponseWriter, r *http.Request, p Page) {
	s.renderMobile(w, r, p, "")
}

// handleMobilePair: a new code, shown as QR code (the fragment polls its state).
func (s *Server) handleMobilePair(w http.ResponseWriter, r *http.Request, p Page) {
	pair, err := s.api.StartMobilePairing(r.Context(), session(r))
	if err != nil {
		s.failTo(w, r, p, err, "#account-flash")
		return
	}
	v, err := pairingView(r, pair)
	if err != nil {
		s.failTo(w, r, p, err, "#account-flash")
		return
	}
	s.render(w, http.StatusOK, "error", "mobile_pairing_fragment", withData(p, v))
}

// handleMobilePairState: polled every 2 seconds while the QR code shows.
func (s *Server) handleMobilePairState(w http.ResponseWriter, r *http.Request, p Page) {
	st, err := s.api.MobilePairingState(r.Context(), session(r), r.PathValue("pid"))
	if err != nil {
		s.failTo(w, r, p, err, "#account-flash")
		return
	}
	if !st.Paired && !st.Expired {
		if st.KeyID == r.URL.Query().Get("k") {
			w.WriteHeader(http.StatusNoContent) // same key: htmx keeps the QR code
			return
		}
		// A new key: the QR code is drawn again.
		v, err := pairingView(r, st.MobilePairing)
		if err != nil {
			s.failTo(w, r, p, err, "#account-flash")
			return
		}
		s.render(w, http.StatusOK, "error", "mobile_pairing_fragment", withData(p, v))
		return
	}
	v := mobilePairingView{ID: r.PathValue("pid"), Paired: st.Device, Expired: st.Expired}
	if st.Paired {
		w.Header().Set("HX-Trigger", "mobile-paired")
	}
	s.render(w, http.StatusOK, "error", "mobile_pairing_fragment", withData(p, v))
}

// handleMobileUpdate: rename a phone or set its push events (form of one row).
func (s *Server) handleMobileUpdate(w http.ResponseWriter, r *http.Request, p Page) {
	_ = r.ParseForm()
	var name *string
	if r.Form.Has("name") {
		n := strings.TrimSpace(r.FormValue("name"))
		name = &n
	}
	notify := []string{}
	for _, e := range mobileNotify {
		if r.FormValue("notify_"+e) != "" {
			notify = append(notify, e)
		}
	}
	if err := s.api.UpdateMobileDevice(r.Context(), session(r), r.PathValue("did"), name, &notify); err != nil {
		s.failTo(w, r, p, err, "#account-flash")
		return
	}
	s.renderMobile(w, r, p, "settings.mobile.saved")
}

func (s *Server) handleMobileDelete(w http.ResponseWriter, r *http.Request, p Page) {
	if err := s.api.DeleteMobileDevice(r.Context(), session(r), r.PathValue("did")); err != nil {
		s.failTo(w, r, p, err, "#account-flash")
		return
	}
	s.renderMobile(w, r, p, "settings.mobile.removed")
}

// mobileTextPrefixes: the texts the app needs (log lines, errors, states,
// module names); everything else stays in the dashboard.
var mobileTextPrefixes = []string{"log.", "error.", "bot.status.", "plugins.tasks.state.", "module."}

// handleMobileTexts: public, cacheable. The app shows log lines and errors
// in the user's language with the dashboard's own texts.
func (s *Server) handleMobileTexts(w http.ResponseWriter, r *http.Request) {
	lang := r.PathValue("lang")
	if !s.i18n.Has(lang) {
		lang = "en"
	}
	out := map[string]string{}
	for _, k := range s.i18n.Keys(lang) {
		for _, p := range mobileTextPrefixes {
			if strings.HasPrefix(k, p) {
				if v, ok := s.i18n.Lookup(lang, k); ok {
					out[k] = v
				}
				break
			}
		}
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "public, max-age=3600")
	_ = json.NewEncoder(w).Encode(out)
}
