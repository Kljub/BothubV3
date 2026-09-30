package web

import (
	"net/http"
	"regexp"
	"slices"
	"strconv"
	"strings"

	"github.com/Kljub/BothubV3/dashboard/internal/api"
)

// Timed events module page: the bot's time zone and default server, a form
// for new timed events and the list of existing ones. A timed event starts
// the custom events of type "timed" that picked it in the builder.

// timeZones offered on the page ("" = the server's TZ).
var timeZones = []string{
	"UTC",
	"Europe/London", "Europe/Dublin", "Europe/Lisbon",
	"Europe/Berlin", "Europe/Amsterdam", "Europe/Brussels", "Europe/Paris", "Europe/Madrid", "Europe/Rome",
	"Europe/Vienna", "Europe/Zurich", "Europe/Prague", "Europe/Warsaw", "Europe/Stockholm", "Europe/Copenhagen", "Europe/Oslo",
	"Europe/Athens", "Europe/Bucharest", "Europe/Helsinki", "Europe/Kyiv", "Europe/Istanbul", "Europe/Moscow",
	"America/New_York", "America/Chicago", "America/Denver", "America/Phoenix", "America/Los_Angeles", "America/Anchorage",
	"America/Toronto", "America/Mexico_City", "America/Bogota", "America/Lima", "America/Santiago", "America/Sao_Paulo", "America/Argentina/Buenos_Aires",
	"Pacific/Honolulu", "Atlantic/Azores",
	"Africa/Casablanca", "Africa/Lagos", "Africa/Cairo", "Africa/Johannesburg", "Africa/Nairobi",
	"Asia/Dubai", "Asia/Tehran", "Asia/Karachi", "Asia/Kolkata", "Asia/Kathmandu", "Asia/Dhaka", "Asia/Bangkok", "Asia/Jakarta",
	"Asia/Singapore", "Asia/Hong_Kong", "Asia/Shanghai", "Asia/Taipei", "Asia/Manila", "Asia/Seoul", "Asia/Tokyo",
	"Australia/Perth", "Australia/Adelaide", "Australia/Brisbane", "Australia/Sydney", "Australia/Melbourne", "Pacific/Auckland",
}

// weekdayOrder is Monday first; values are 0 = Sunday … 6 = Saturday.
var weekdayOrder = []int{1, 2, 3, 4, 5, 6, 0}

type timedView struct {
	BotID         int64
	Settings      api.TimedSettings
	DefaultServer string // Settings.DefaultServerID without the pointer, for the template
	Events        []timedEventView
	Guilds        []api.Guild
	Zones         []string
	Weekdays      []int
	New           timedEventView // defaults of the "new timed event" form
}

type timedEventView struct {
	api.TimedEvent
	Days, Hours, Minutes, Seconds int
	TimesText                     string
	On                            map[int]bool // weekdays
}

func eventView(e api.TimedEvent) timedEventView {
	v := timedEventView{TimedEvent: e, On: map[int]bool{}}
	if e.IntervalSeconds != nil {
		n := *e.IntervalSeconds
		v.Days, n = n/86400, n%86400
		v.Hours, n = n/3600, n%3600
		v.Minutes, v.Seconds = n/60, n%60
	}
	short := make([]string, len(e.Times))
	for i, t := range e.Times {
		short[i] = strings.TrimSuffix(t, ":00")
		if len(short[i]) < 5 {
			short[i] = t
		}
	}
	v.TimesText = strings.Join(short, ", ")
	for _, d := range e.Weekdays {
		v.On[d] = true
	}
	return v
}

func (s *Server) timedData(r *http.Request, botID int64) (timedView, error) {
	events, err := s.api.TimedEvents(r.Context(), session(r), botID)
	if err != nil {
		return timedView{}, err
	}
	settings, err := s.api.TimedSettings(r.Context(), session(r), botID)
	if err != nil {
		return timedView{}, err
	}
	// Without a running bot there are no servers; the page still works.
	guilds, _ := s.api.ListGuilds(r.Context(), session(r), botID)
	v := timedView{BotID: botID, Settings: settings, Guilds: guilds, Zones: timeZones, Weekdays: weekdayOrder}
	if settings.DefaultServerID != nil {
		v.DefaultServer = *settings.DefaultServerID
	}
	if settings.Timezone != "" && !slices.Contains(timeZones, settings.Timezone) {
		v.Zones = append([]string{settings.Timezone}, timeZones...)
	}
	for _, e := range events {
		v.Events = append(v.Events, eventView(e))
	}
	sec := 60
	v.New = eventView(api.TimedEvent{Kind: "interval", IntervalSeconds: &sec, Enabled: true})
	return v, nil
}

func (s *Server) renderTimed(w http.ResponseWriter, r *http.Request, p Page, botID int64) {
	v, err := s.timedData(r, botID)
	if err != nil {
		s.failTo(w, r, p, err, "#timed-error")
		return
	}
	s.render(w, http.StatusOK, "module_item", "timed_events_fragment", withData(p, v))
}

var timeOfDay = regexp.MustCompile(`^([01]?\d|2[0-3]):[0-5]\d(:[0-5]\d)?$`)

// timedFromForm reads the form of one timed event. Unparsable times are
// passed on as they are, so the API answers with its validation key.
func timedFromForm(r *http.Request) api.TimedEvent {
	_ = r.ParseForm()
	num := func(k string) int { n, _ := strconv.Atoi(strings.TrimSpace(r.PostFormValue(k))); return max(n, 0) }
	e := api.TimedEvent{
		Name:     strings.TrimSpace(r.PostFormValue("name")),
		Kind:     r.PostFormValue("kind"),
		Enabled:  r.PostFormValue("enabled") == "true",
		Times:    []string{},
		Weekdays: []int{},
	}
	if e.Kind == "interval" {
		sec := num("days")*86400 + num("hours")*3600 + num("minutes")*60 + num("seconds")
		e.IntervalSeconds = &sec
	} else {
		for _, t := range strings.FieldsFunc(r.PostFormValue("times"), func(c rune) bool { return c == ',' || c == ' ' || c == '\n' || c == ';' }) {
			if timeOfDay.MatchString(t) && len(t) == 4 {
				t = "0" + t // 8:00 -> 08:00
			}
			e.Times = append(e.Times, t)
		}
	}
	for _, d := range r.PostForm["weekday"] {
		if n, err := strconv.Atoi(d); err == nil {
			e.Weekdays = append(e.Weekdays, n)
		}
	}
	return e
}

func (s *Server) handleTimedCreate(w http.ResponseWriter, r *http.Request, p Page) {
	id, ok := s.botID(w, r, p)
	if !ok {
		return
	}
	if err := s.api.CreateTimedEvent(r.Context(), session(r), id, timedFromForm(r)); err != nil {
		s.failTo(w, r, p, err, "#timed-error")
		return
	}
	s.renderTimed(w, r, p, id)
}

func (s *Server) handleTimedUpdate(w http.ResponseWriter, r *http.Request, p Page) {
	id, ok := s.botID(w, r, p)
	if !ok {
		return
	}
	e := timedFromForm(r)
	e.ID, _ = strconv.ParseInt(r.PathValue("tid"), 10, 64)
	if err := s.api.UpdateTimedEvent(r.Context(), session(r), id, e); err != nil {
		s.failTo(w, r, p, err, "#timed-error")
		return
	}
	s.renderTimed(w, r, p, id)
}

func (s *Server) handleTimedDelete(w http.ResponseWriter, r *http.Request, p Page) {
	id, ok := s.botID(w, r, p)
	if !ok {
		return
	}
	tid, _ := strconv.ParseInt(r.PathValue("tid"), 10, 64)
	if err := s.api.DeleteTimedEvent(r.Context(), session(r), id, tid); err != nil {
		s.failTo(w, r, p, err, "#timed-error")
		return
	}
	s.renderTimed(w, r, p, id)
}

func (s *Server) handleTimedSettings(w http.ResponseWriter, r *http.Request, p Page) {
	id, ok := s.botID(w, r, p)
	if !ok {
		return
	}
	server := r.PostFormValue("default_server")
	in := api.TimedSettings{Timezone: r.PostFormValue("timezone"), DefaultServerID: &server}
	if err := s.api.SetTimedSettings(r.Context(), session(r), id, in); err != nil {
		s.failTo(w, r, p, err, "#timed-error")
		return
	}
	s.renderTimed(w, r, p, id)
}
