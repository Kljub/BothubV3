package main

import (
	"net/http"
	"regexp"
	"slices"
	"strconv"
)

// Dashboard preferences per account. ModuleGroups: per bot ID the module
// groups the user closed on the Modules page (open is the default).
type uiPrefs struct {
	ModuleGroups map[string][]string `json:"moduleGroups,omitempty"`
	// BotOrder: the user's order of the bot tiles (and of the bot switch); bots not in it follow by ID.
	BotOrder []int64 `json:"botOrder,omitempty"`
}

// orderBots sorts bots by the user's order; the others keep their order after them.
func orderBots(items []bot, order []int64) []bot {
	pos := map[int64]int{}
	for i, id := range order {
		if _, dup := pos[id]; !dup {
			pos[id] = i
		}
	}
	slices.SortStableFunc(items, func(a, b bot) int {
		pa, oka := pos[a.ID]
		pb, okb := pos[b.ID]
		switch {
		case oka && okb:
			return pa - pb
		case oka:
			return -1
		case okb:
			return 1
		}
		return 0
	})
	return items
}

// putBotOrder stores a new order of some bots (the tiles of one page): they
// take the places those bots had in the current order.
func (s *store) putBotOrder(w http.ResponseWriter, r *http.Request, sid string) {
	var in struct {
		IDs []int64 `json:"ids"`
	}
	if !readJSON(w, r, &in) {
		return
	}
	if len(in.IDs) == 0 || len(in.IDs) > 500 {
		apiError(w, 422, "error.validation.failed")
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	u := s.sessUser(sid)
	if u == nil {
		apiError(w, 401, "error.auth.required")
		return
	}
	var all []bot
	for id := int64(1); id < s.nextID; id++ {
		if b, ok := s.bots[id]; ok {
			if _, _, has := s.botAccess(u, b); has {
				all = append(all, *b)
			}
		}
	}
	all = orderBots(all, u.uiPrefs.BotOrder)
	moved := map[int64]bool{}
	for _, id := range in.IDs {
		moved[id] = true
	}
	next := 0
	order := make([]int64, 0, len(all))
	for _, b := range all {
		if moved[b.ID] && next < len(in.IDs) {
			// skip IDs the user cannot see
			for next < len(in.IDs) && !hasBot(all, in.IDs[next]) {
				next++
			}
			if next < len(in.IDs) {
				order = append(order, in.IDs[next])
				next++
				continue
			}
		}
		order = append(order, b.ID)
	}
	u.uiPrefs.BotOrder = order
	s.persistUser(u)
	writeJSON(w, 200, map[string]any{"order": order})
}

func hasBot(list []bot, id int64) bool {
	for _, b := range list {
		if b.ID == id {
			return true
		}
	}
	return false
}

var groupKey = regexp.MustCompile(`^[a-z]{1,24}$`)

// getModuleGroups: the closed groups of this bot for the signed-in user.
func (s *store) getModuleGroups(w http.ResponseWriter, r *http.Request, b *bot) {
	s.mu.Lock()
	defer s.mu.Unlock()
	closed := []string{}
	if u := s.sessUserFromRequest(r); u != nil {
		closed = append(closed, u.uiPrefs.ModuleGroups[strconv.FormatInt(b.ID, 10)]...)
	}
	writeJSON(w, 200, map[string]any{"closed": closed})
}

func (s *store) putModuleGroups(w http.ResponseWriter, r *http.Request, b *bot) {
	var in struct {
		Closed []string `json:"closed"`
	}
	if !readJSON(w, r, &in) {
		return
	}
	if len(in.Closed) > 30 {
		apiError(w, 422, "error.validation.failed")
		return
	}
	closed := []string{}
	for _, k := range in.Closed {
		if groupKey.MatchString(k) {
			closed = append(closed, k)
		}
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	u := s.sessUserFromRequest(r)
	if u == nil {
		apiError(w, 401, "error.auth.required")
		return
	}
	if u.uiPrefs.ModuleGroups == nil {
		u.uiPrefs.ModuleGroups = map[string][]string{}
	}
	key := strconv.FormatInt(b.ID, 10)
	if len(closed) == 0 {
		delete(u.uiPrefs.ModuleGroups, key)
	} else {
		u.uiPrefs.ModuleGroups[key] = closed
	}
	// Bots that no longer exist are forgotten on the way.
	for k := range u.uiPrefs.ModuleGroups {
		id, _ := strconv.ParseInt(k, 10, 64)
		if _, ok := s.bots[id]; !ok {
			delete(u.uiPrefs.ModuleGroups, k)
		}
	}
	s.persistUser(u)
	writeJSON(w, 200, map[string]any{"closed": closed})
}
