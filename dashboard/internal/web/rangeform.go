package web

import (
	"fmt"
	"html/template"
	"net/http"
	"net/url"
	"time"
)

// rangeForm is the data for the "range_picker" template.
type rangeForm struct {
	From, To string // datetime-local values, may be empty
	Hint     string // i18n key of the retention note
}

func newRangeForm(from, to, hint string) rangeForm {
	return rangeForm{From: from, To: to, Hint: hint}
}

// customRange reads from/to (datetime-local, server time zone; whole days
// from the picker: 00:00 to 23:59) and checks them. Without values it proposes [now-fallback, now]. The
// end is capped at now. errKey is an i18n key when the range is not usable.
func customRange(r *http.Request, minSpan, fallback time.Duration, tooShortKey string) (from, to time.Time, errKey string) {
	q := r.URL.Query()
	now := time.Now()
	if q.Get("from") == "" && q.Get("to") == "" {
		return now.Add(-fallback), now, ""
	}
	from, errFrom := time.ParseInLocation(inputTime, q.Get("from"), time.Local)
	to, errTo := time.ParseInLocation(inputTime, q.Get("to"), time.Local)
	switch {
	case errFrom != nil || errTo != nil || !from.Before(to):
		return from, to, "error.range.invalid"
	case from.After(now):
		return from, to, "error.range.future"
	case earliest(to, now).Sub(from) < minSpan:
		return from, to, tooShortKey
	}
	// Any day may be picked. Data older than the retention does not exist,
	// so such a range shows an empty chart instead of an error.
	return from, earliest(to, now), ""
}

// rangeQuery is the query string that repeats a range in follow-up requests
// (tile clicks, polling). Built here, so the template may use it unescaped.
func rangeQuery(rng string, from, to time.Time) template.URL {
	if rng != "custom" {
		return template.URL("range=" + url.QueryEscape(rng))
	}
	q := url.Values{"range": {"custom"}, "from": {from.Format(inputTime)}, "to": {to.Format(inputTime)}}
	return template.URL(q.Encode())
}

// rangeLabel writes a custom range out for the chart subtitle.
func rangeLabel(from, to time.Time, locale string) string {
	layout := "Jan 2, 15:04"
	if locale == "de" {
		layout = "02.01. 15:04"
	}
	return fmt.Sprintf("%s – %s", from.Format(layout), to.Format(layout))
}
