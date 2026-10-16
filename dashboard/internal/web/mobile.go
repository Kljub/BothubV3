package web

import (
	"encoding/base64"
	"fmt"
	"html/template"
	"net/http"
	"net/url"
	"strings"

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
	ID        string
	QR        template.URL
	Link      string
	ExpiresIn int // seconds
	Paired    *api.MobileDevice
	Expired   bool
}

// pairLink: what the QR code holds.
func pairLink(server, code string) string {
	return "bothub://pair?" + url.Values{"server": {server}, "code": {code}}.Encode()
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
	link := pairLink(baseURL(r), pair.Code)
	code, err := qr.Encode(link, qr.M)
	if err != nil {
		s.failTo(w, r, p, fmt.Errorf("qr: %w", err), "#account-flash")
		return
	}
	v := mobilePairingView{ID: pair.ID, QR: template.URL("data:image/png;base64," + base64.StdEncoding.EncodeToString(code.PNG())), Link: link, ExpiresIn: 300}
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
		w.WriteHeader(http.StatusNoContent) // htmx keeps the QR code
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
