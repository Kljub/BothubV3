package web

import (
	"encoding/json"
	"fmt"
	"os"
)

// EventCategory is one group of event types from shared/events.json.
// Texts: builder.eventcat.<key> and builder.event.<event key>.
type EventCategory struct {
	Key    string      `json:"key"`
	Icon   string      `json:"icon"`
	Events []EventType `json:"events"`
}

// EventType is one Discord event a custom event can react to. Vars are the
// placeholders it gives the blocks.
type EventType struct {
	Key  string   `json:"key"`
	Vars []string `json:"vars"`
	// Soon: the bot does not emit this type yet; shown but not selectable.
	Soon bool `json:"soon,omitempty"`
	// Intent: a privileged intent the event needs (presence, members).
	Intent string `json:"intent,omitempty"`
}

// LoadEvents reads the event catalog (shared/events.json).
func LoadEvents(path string) ([]EventCategory, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read event catalog: %w", err)
	}
	var catalog struct {
		Categories []EventCategory `json:"categories"`
	}
	if err := json.Unmarshal(raw, &catalog); err != nil {
		return nil, fmt.Errorf("event catalog: %w", err)
	}
	return catalog.Categories, nil
}

// eventCategoryOf maps an event type to its category key ("" = unknown).
func (s *Server) eventCategoryOf(eventType string) string {
	for _, c := range s.events {
		for _, e := range c.Events {
			if e.Key == eventType {
				return c.Key
			}
		}
	}
	return ""
}
