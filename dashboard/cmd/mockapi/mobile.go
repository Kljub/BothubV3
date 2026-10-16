package main

import (
	"crypto/ecdsa"
	"crypto/sha256"
	"encoding/base64"
	"math/big"
	"net/http"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"time"
)

// Mobile app (Android, github.com/Kljub/BotHubAndroitApp): a user controls
// their bots from the phone.
//
// Pairing: the dashboard (Settings → Mobile App) asks for a pairing code and
// shows it with the server address as a QR code. The app scans it, makes a
// P-256 key in the phone's keystore (never leaves the phone) and calls
// POST /api/v1/mobile/pair with the code, a name and the public key. It gets
// a device token. The code works once and for pairingTTL.
//
// Requests: "Authorization: Bearer bhm_…" plus X-BotHub-Time (unix seconds)
// and X-BotHub-Signature (base64url raw r||s ECDSA over
// "bothub-mobile:<time>:<METHOD>:<path?query>"). A copied token alone is
// useless; a signature works once and only within mobileClockSkew. Devices
// reach only the API paths of mobileAllowed (bots, logs, modules, plugins,
// overview, own device); never the admin area or the sign-in settings.
//
// Push: the app stores its push token (FCM) and the events it wants
// (bot_offline, bot_error, update); sending comes with a later version.

const (
	pairingTTL        = 5 * time.Minute
	mobileClockSkew   = 5 * time.Minute
	mobileTokenPrefix = "bhm_"
	mobileSigPrefix   = "bothub-mobile:"
	maxDevicesPerUser = 10
	maxOpenPairings   = 3
)

// mobileDevice: a paired phone. Kept by the SHA-256 of its token.
type mobileDevice struct {
	ID           string   `json:"id"`
	UserID       int64    `json:"userId"`
	Name         string   `json:"name"`
	Platform     string   `json:"platform"`
	AppVersion   string   `json:"appVersion"`
	PublicKey    string   `json:"publicKey"`
	PushToken    string   `json:"pushToken"`
	PushPlatform string   `json:"pushPlatform"`
	Notify       []string `json:"notify"`
	// BotHub Guard (guard.go): second sign-in factor; the secret makes the app's codes.
	Guard       bool      `json:"guard"`
	GuardSecret string    `json:"guardSecret"`
	IP          string    `json:"ip"`
	CreatedAt   time.Time `json:"createdAt"`
	LastSeen    time.Time `json:"lastSeenAt"`
	savedSeen   time.Time
	used        map[string]time.Time // signatures seen within the clock window
}

// mobilePairing: an open pairing code (kept by its hash).
type mobilePairing struct {
	id       string
	userID   int64
	expires  time.Time
	deviceID string // set when a phone used it
}

var notifyEvents = []string{"bot_offline", "bot_error", "update"}

// mobileAllowed: method + path pattern a device may call.
var mobileAllowed = []struct {
	method string
	re     *regexp.Regexp
}{
	{"GET", regexp.MustCompile(`^/api/v1/auth/me$`)},
	{"GET", regexp.MustCompile(`^/api/v1/bots$`)},
	{"GET", regexp.MustCompile(`^/api/v1/bots/\d+$`)},
	{"POST", regexp.MustCompile(`^/api/v1/bots/\d+/(start|stop|restart)$`)},
	{"GET", regexp.MustCompile(`^/api/v1/bots/\d+/logs$`)},
	{"GET", regexp.MustCompile(`^/api/v1/bots/\d+/(modules|plugins)$`)},
	{"PUT", regexp.MustCompile(`^/api/v1/bots/\d+/modules/[a-z0-9-]{1,64}$`)},
	{"PATCH", regexp.MustCompile(`^/api/v1/bots/\d+/plugins/[a-z0-9_-]{2,64}$`)},
	{"GET", regexp.MustCompile(`^/api/v1/stats/overview$`)},
	{"GET", regexp.MustCompile(`^/api/v1/mobile/me$`)},
	{"PUT", regexp.MustCompile(`^/api/v1/mobile/push$`)},
	{"DELETE", regexp.MustCompile(`^/api/v1/mobile/device$`)},
	{"GET", regexp.MustCompile(`^/api/v1/mobile/approvals$`)},
	{"POST", regexp.MustCompile(`^/api/v1/mobile/approvals/[0-9a-f]{16}$`)},
}

func mobileMayCall(method, path string) bool {
	for _, a := range mobileAllowed {
		if a.method == method && a.re.MatchString(path) {
			return true
		}
	}
	return false
}

// mobileSigned: the signature of a request with the device's public key.
func mobileSigned(keyB64, stamp, method, uri, sigB64 string) bool {
	k, err := parseDeviceKey(keyB64)
	if err != nil {
		return false
	}
	sig, err := base64.RawURLEncoding.DecodeString(sigB64)
	if err != nil || len(sig) != 64 {
		return false
	}
	digest := sha256.Sum256([]byte(mobileSigPrefix + stamp + ":" + method + ":" + uri))
	return ecdsa.Verify(k, digest[:], new(big.Int).SetBytes(sig[:32]), new(big.Int).SetBytes(sig[32:]))
}

// mobileAuth checks a device request. handled false: no device token (the
// cookie session applies); ok false: refused (the answer is written).
func (s *store) mobileAuth(w http.ResponseWriter, r *http.Request) (dev *mobileDevice, ok, handled bool) {
	h := r.Header.Get("Authorization")
	if !strings.HasPrefix(h, "Bearer "+mobileTokenPrefix) {
		return nil, false, false
	}
	key := sessionKey(strings.TrimPrefix(h, "Bearer "))
	stamp := r.Header.Get("X-BotHub-Time")
	sig := r.Header.Get("X-BotHub-Signature")
	s.mu.Lock()
	defer s.mu.Unlock()
	d := s.devices[key]
	if d == nil {
		apiError(w, 401, "error.mobile.unpaired")
		return nil, false, true
	}
	u := s.userByID(d.UserID)
	if u == nil || s.roleKey(u.RoleID) == "banned" {
		s.dropDevice(key)
		apiError(w, 401, "error.mobile.unpaired")
		return nil, false, true
	}
	sec, err := strconv.ParseInt(stamp, 10, 64)
	now := time.Now()
	if err != nil || now.Sub(time.Unix(sec, 0)).Abs() > mobileClockSkew {
		apiError(w, 401, "error.mobile.clock")
		return nil, false, true
	}
	if _, seen := d.used[sig]; seen || !mobileSigned(d.PublicKey, stamp, r.Method, r.URL.RequestURI(), sig) {
		apiError(w, 401, "error.mobile.signature")
		return nil, false, true
	}
	if !mobileMayCall(r.Method, r.URL.Path) {
		apiError(w, 403, "error.mobile.not_allowed")
		return nil, false, true
	}
	if d.used == nil {
		d.used = map[string]time.Time{}
	}
	for k, t := range d.used {
		if now.Sub(t) > 2*mobileClockSkew {
			delete(d.used, k)
		}
	}
	d.used[sig] = now
	d.LastSeen, d.IP = now.UTC(), clientIP(r)
	if d.LastSeen.Sub(d.savedSeen) >= sessionPersistEvery {
		s.persistDevice(key, d)
	}
	return d, true, true
}

// deviceOf: the device of a "mobile:<id>" session ID. Caller holds s.mu.
func (s *store) deviceOf(sid string) (string, *mobileDevice) {
	id, ok := strings.CutPrefix(sid, "mobile:")
	if !ok {
		return "", nil
	}
	for key, d := range s.devices {
		if d.ID == id {
			return key, d
		}
	}
	return "", nil
}

// --- persistence (PHP /internal/accounts/devices) ---

func (s *store) persistDevice(key string, d *mobileDevice) {
	d.savedSeen = d.LastSeen
	if s.php == nil {
		return
	}
	body := map[string]any{
		"id": d.ID, "userId": d.UserID, "name": d.Name, "platform": d.Platform, "appVersion": d.AppVersion, "publicKey": d.PublicKey,
		"pushToken": d.PushToken, "pushPlatform": d.PushPlatform, "notify": d.Notify, "ip": d.IP, "guard": d.Guard, "guardSecret": d.GuardSecret,
		"createdAt": d.CreatedAt.UTC().Format(time.RFC3339), "lastSeenAt": d.LastSeen.UTC().Format(time.RFC3339),
	}
	go s.phpSync(http.MethodPut, "/internal/accounts/devices/"+key, body)
}

// dropDevice unpairs a phone. Caller holds s.mu.
func (s *store) dropDevice(key string) {
	if _, ok := s.devices[key]; !ok {
		return
	}
	delete(s.devices, key)
	s.phpDelete("/internal/accounts/devices/" + key)
}

// endDevicesOf unpairs every phone of a user (account deleted). Caller holds s.mu.
func (s *store) endDevicesOf(userID int64) {
	for key, d := range s.devices {
		if d.UserID == userID {
			s.dropDevice(key)
		}
	}
}

// deviceView: what the dashboard and the app see of a device (no key, no token).
func deviceView(d *mobileDevice) map[string]any {
	notify := d.Notify
	if notify == nil {
		notify = []string{}
	}
	return map[string]any{
		"id": d.ID, "name": d.Name, "platform": d.Platform, "appVersion": d.AppVersion, "ip": d.IP,
		"push": d.PushToken != "", "notify": notify, "guard": d.Guard, "createdAt": d.CreatedAt, "lastSeenAt": d.LastSeen,
	}
}

// --- dashboard (cookie session) ---

// createPairing: a one-time code for the QR code of the dashboard.
func (s *store) createPairing(w http.ResponseWriter, r *http.Request, sid string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	u := s.sessUser(sid)
	now := time.Now()
	open, devices := 0, 0
	for k, p := range s.pairings {
		if now.After(p.expires) {
			delete(s.pairings, k)
		} else if p.userID == u.ID && p.deviceID == "" {
			open++
		}
	}
	for _, d := range s.devices {
		if d.UserID == u.ID {
			devices++
		}
	}
	if devices >= maxDevicesPerUser {
		apiError(w, 409, "error.mobile.too_many_devices")
		return
	}
	if open >= maxOpenPairings {
		apiError(w, 429, "error.mobile.too_many_pairings")
		return
	}
	code := randomHex(24)
	p := &mobilePairing{id: randomHex(8), userID: u.ID, expires: now.Add(pairingTTL)}
	s.pairings[sessionKey(code)] = p
	writeJSON(w, 201, map[string]any{"id": p.id, "code": code, "expiresAt": p.expires.UTC()})
}

// pairingStatus: whether a phone used the code (the dashboard polls it).
func (s *store) pairingStatus(w http.ResponseWriter, r *http.Request, sid string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	u := s.sessUser(sid)
	for _, p := range s.pairings {
		if p.id != r.PathValue("pid") || p.userID != u.ID {
			continue
		}
		out := map[string]any{"paired": p.deviceID != "", "expired": p.deviceID == "" && time.Now().After(p.expires), "expiresAt": p.expires.UTC()}
		for _, d := range s.devices {
			if d.ID == p.deviceID {
				out["device"] = deviceView(d)
			}
		}
		writeJSON(w, 200, out)
		return
	}
	apiError(w, 404, "error.not_found")
}

func (s *store) listDevices(w http.ResponseWriter, r *http.Request, sid string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	u := s.sessUser(sid)
	items := []map[string]any{}
	for _, d := range s.devices {
		if d.UserID == u.ID {
			items = append(items, deviceView(d))
		}
	}
	slices.SortFunc(items, func(a, b map[string]any) int { return b["createdAt"].(time.Time).Compare(a["createdAt"].(time.Time)) })
	writeJSON(w, 200, map[string]any{"items": items})
}

// patchDevice renames a device or changes its push events.
func (s *store) patchDevice(w http.ResponseWriter, r *http.Request, sid string) {
	var in struct {
		Name   *string   `json:"name"`
		Notify *[]string `json:"notify"`
		Guard  *bool     `json:"guard"`
	}
	if !readJSON(w, r, &in) {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	u := s.sessUser(sid)
	for key, d := range s.devices {
		if d.ID != r.PathValue("did") || d.UserID != u.ID {
			continue
		}
		if in.Name != nil {
			name := strings.TrimSpace(*in.Name)
			if name == "" || len([]rune(name)) > 40 {
				apiError(w, 422, "error.validation.failed")
				return
			}
			d.Name = name
		}
		if in.Notify != nil {
			n, ok := cleanNotify(*in.Notify)
			if !ok {
				apiError(w, 422, "error.validation.failed")
				return
			}
			d.Notify = n
		}
		if in.Guard != nil {
			d.Guard = *in.Guard
		}
		s.persistDevice(key, d)
		writeJSON(w, 200, deviceView(d))
		return
	}
	apiError(w, 404, "error.not_found")
}

func (s *store) deleteDevice(w http.ResponseWriter, r *http.Request, sid string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	u := s.sessUser(sid)
	for key, d := range s.devices {
		if d.ID == r.PathValue("did") && d.UserID == u.ID {
			s.dropDevice(key)
			w.WriteHeader(204)
			return
		}
	}
	apiError(w, 404, "error.not_found")
}

func cleanNotify(in []string) ([]string, bool) {
	out := []string{}
	for _, e := range in {
		if !slices.Contains(notifyEvents, e) {
			return nil, false
		}
		if !slices.Contains(out, e) {
			out = append(out, e)
		}
	}
	return out, true
}

// --- the app ---

var pairNameRe = regexp.MustCompile(`^[\p{L}\p{N} ._'()-]{1,40}$`)

// pairDevice: the app trades a pairing code for a device token (public;
// the code is the proof). Failures count like failed sign-ins per address.
func (s *store) pairDevice(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Code       string `json:"code"`
		Name       string `json:"name"`
		Platform   string `json:"platform"`
		AppVersion string `json:"appVersion"`
		PublicKey  string `json:"publicKey"`
	}
	if !readJSON(w, r, &in) {
		return
	}
	ip := clientIP(r)
	if s.pairLimit.blocked(ip, "") > 0 {
		apiError(w, 429, "error.auth.too_many_attempts")
		return
	}
	in.Name = strings.TrimSpace(in.Name)
	if _, err := parseDeviceKey(in.PublicKey); err != nil || !pairNameRe.MatchString(in.Name) || (in.Platform != "android" && in.Platform != "ios") || len(in.AppVersion) > 20 {
		apiError(w, 422, "error.validation.failed")
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	p := s.pairings[sessionKey(in.Code)]
	if p == nil || p.deviceID != "" || time.Now().After(p.expires) || s.userByID(p.userID) == nil {
		s.pairLimit.failed(ip, "")
		apiError(w, 404, "error.mobile.code_invalid")
		return
	}
	token := mobileTokenPrefix + randomHex(32)
	now := time.Now().UTC()
	d := &mobileDevice{ID: randomHex(8), UserID: p.userID, Name: in.Name, Platform: in.Platform, AppVersion: in.AppVersion, PublicKey: in.PublicKey,
		Notify: []string{"bot_offline", "bot_error"}, IP: ip, CreatedAt: now, LastSeen: now, GuardSecret: newGuardSecret()}
	key := sessionKey(token)
	s.devices[key] = d
	p.deviceID = d.ID
	s.persistDevice(key, d)
	u := s.userByID(p.userID)
	// The guard secret goes to the app once (its Guard codes); it is never shown again.
	writeJSON(w, 201, map[string]any{"token": token, "guardSecret": d.GuardSecret, "device": deviceView(d), "user": map[string]any{"id": u.ID, "username": u.Username}})
}

// mobileMe: the device and its user (device session).
func (s *store) mobileMe(w http.ResponseWriter, r *http.Request, sid string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	_, d := s.deviceOf(sid)
	u := s.userByID(d.UserID)
	writeJSON(w, 200, map[string]any{"device": deviceView(d), "user": map[string]any{"id": u.ID, "username": u.Username}, "permissions": s.permissionsOf(u)})
}

// mobilePush: the app's push token and the events it wants.
func (s *store) mobilePush(w http.ResponseWriter, r *http.Request, sid string) {
	var in struct {
		Token    string    `json:"token"`
		Platform string    `json:"platform"`
		Notify   *[]string `json:"notify"`
	}
	if !readJSON(w, r, &in) {
		return
	}
	if len(in.Token) > 4096 || (in.Token != "" && in.Platform != "fcm" && in.Platform != "apns") {
		apiError(w, 422, "error.validation.failed")
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	key, d := s.deviceOf(sid)
	d.PushToken, d.PushPlatform = in.Token, in.Platform
	if in.Token == "" {
		d.PushPlatform = ""
	}
	if in.Notify != nil {
		n, ok := cleanNotify(*in.Notify)
		if !ok {
			apiError(w, 422, "error.validation.failed")
			return
		}
		d.Notify = n
	}
	s.persistDevice(key, d)
	writeJSON(w, 200, deviceView(d))
}

// mobileUnpair: the app removes itself.
func (s *store) mobileUnpair(w http.ResponseWriter, r *http.Request, sid string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	key, _ := s.deviceOf(sid)
	s.dropDevice(key)
	w.WriteHeader(204)
}
