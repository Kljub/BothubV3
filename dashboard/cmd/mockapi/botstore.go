package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"time"
)

// Bot storage in the PHP API (internal endpoints /internal/bots). The mock
// keeps login and the Discord checks; bots, their encrypted tokens and the
// start/stop jobs live in the API, so they survive restarts and reach the
// NodeCore. Active when ENV BOTHUB_INTERNAL_KEY is set; without it the mock
// keeps bots in memory as before.

type phpBots struct {
	base string
	key  string
	http *http.Client
}

func newPHPBots() *phpBots {
	key := envOr("BOTHUB_INTERNAL_KEY", "")
	if key == "" {
		return nil
	}
	return &phpBots{base: envOr("PHP_API_URL", "http://api:9000"), key: key, http: &http.Client{Timeout: 10 * time.Second}}
}

// phpError is an error answer of the API ({"error":{"key":...}}).
type phpError struct {
	Status int
	Key    string
}

func (e *phpError) Error() string { return e.Key }

func asPHPError(err error) *phpError {
	var pe *phpError
	if errors.As(err, &pe) {
		return pe
	}
	return &phpError{Status: 502, Key: "error.api.unreachable"}
}

func (p *phpBots) do(ctx context.Context, method, path string, body, out any) error {
	var payload io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			return err
		}
		payload = bytes.NewReader(b)
	}
	req, err := http.NewRequestWithContext(ctx, method, p.base+path, payload)
	if err != nil {
		return err
	}
	req.Header.Set("X-BotHub-Internal", p.key)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := p.http.Do(req)
	if err != nil {
		return &phpError{Status: 502, Key: "error.api.unreachable"}
	}
	defer resp.Body.Close()
	data, _ := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
	if resp.StatusCode >= 300 {
		var e struct {
			Error struct {
				Key string `json:"key"`
			} `json:"error"`
		}
		_ = json.Unmarshal(data, &e)
		if e.Error.Key == "" {
			e.Error.Key = "error.api.unreachable"
		}
		return &phpError{Status: resp.StatusCode, Key: e.Error.Key}
	}
	if out != nil && len(data) > 0 {
		return json.Unmarshal(data, out)
	}
	return nil
}

func (p *phpBots) list(ctx context.Context) ([]bot, error) {
	var out struct {
		Items []bot `json:"items"`
	}
	err := p.do(ctx, http.MethodGet, "/internal/bots", nil, &out)
	return out.Items, err
}

func (p *phpBots) get(ctx context.Context, id int64) (bot, error) {
	var out bot
	err := p.do(ctx, http.MethodGet, fmt.Sprintf("/internal/bots/%d", id), nil, &out)
	return out, err
}

func (p *phpBots) token(ctx context.Context, id int64) (string, error) {
	var out struct {
		Token string `json:"token"`
	}
	err := p.do(ctx, http.MethodGet, fmt.Sprintf("/internal/bots/%d/token", id), nil, &out)
	return out.Token, err
}

func (p *phpBots) create(ctx context.Context, in map[string]any) (bot, error) {
	var out bot
	err := p.do(ctx, http.MethodPost, "/internal/bots", in, &out)
	return out, err
}

func (p *phpBots) update(ctx context.Context, id int64, in map[string]any) (bot, error) {
	var out bot
	err := p.do(ctx, http.MethodPatch, fmt.Sprintf("/internal/bots/%d", id), in, &out)
	return out, err
}

func (p *phpBots) remove(ctx context.Context, id int64) error {
	return p.do(ctx, http.MethodDelete, fmt.Sprintf("/internal/bots/%d", id), nil, nil)
}

func (p *phpBots) job(ctx context.Context, id int64, action string) (map[string]any, error) {
	var out map[string]any
	err := p.do(ctx, http.MethodPost, fmt.Sprintf("/internal/bots/%d/%s", id, action), nil, &out)
	return out, err
}

// syncBots replaces the in-memory bots with the API's, keeping known tokens
// and fetching missing ones. Caller must not hold s.mu.
func (s *store) syncBots(ctx context.Context) error {
	list, err := s.php.list(ctx)
	if err != nil {
		return err
	}
	s.mu.Lock()
	known := map[int64]string{}
	for id, b := range s.bots {
		known[id] = b.token
	}
	s.mu.Unlock()
	next := map[int64]*bot{}
	var maxID int64
	for i := range list {
		b := list[i]
		b.token = known[b.ID]
		if b.token == "" && b.TokenSet {
			if t, err := s.php.token(ctx, b.ID); err == nil {
				b.token = t
			}
		}
		next[b.ID] = &b
		maxID = max(maxID, b.ID)
	}
	s.mu.Lock()
	// Keep pointers stable for handlers that hold one: update in place.
	for id, b := range next {
		if old, ok := s.bots[id]; ok {
			token := b.token
			*old = *b
			old.token = token
		} else {
			s.bots[id] = b
		}
	}
	for id := range s.bots {
		if _, ok := next[id]; !ok {
			delete(s.bots, id)
		}
	}
	s.nextID = max(s.nextID, maxID+1)
	s.mu.Unlock()
	return nil
}
