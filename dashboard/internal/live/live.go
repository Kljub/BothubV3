// Package live forwards the notes of the Redis channel bothub:live (the bot
// publishes them, e.g. "status of bot 12 changed") to every subscriber, the
// open browser tabs of the dashboard. It speaks just enough of the Redis
// protocol (RESP) for AUTH and SUBSCRIBE and reconnects on its own.
package live

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Channel is the Redis channel the bot publishes on.
const Channel = "bothub:live"

// Hub fans the notes out to the subscribers. The zero Hub is not usable;
// New makes one, Run connects it.
type Hub struct {
	mu   sync.Mutex
	subs map[chan []byte]struct{}
	up   bool
}

func New() *Hub { return &Hub{subs: map[chan []byte]struct{}{}} }

// Subscribe returns a channel with the notes and a function that ends the
// subscription. A slow subscriber misses notes instead of holding up others.
func (h *Hub) Subscribe() (<-chan []byte, func()) {
	ch := make(chan []byte, 16)
	h.mu.Lock()
	h.subs[ch] = struct{}{}
	h.mu.Unlock()
	return ch, func() {
		h.mu.Lock()
		delete(h.subs, ch)
		h.mu.Unlock()
	}
}

// Connected reports whether the hub is subscribed to Redis right now.
func (h *Hub) Connected() bool {
	if h == nil {
		return false
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.up
}

// Publish hands a note to every subscriber (tests and the Redis reader).
func (h *Hub) Publish(note []byte) {
	h.mu.Lock()
	defer h.mu.Unlock()
	for ch := range h.subs {
		select {
		case ch <- note:
		default:
		}
	}
}

func (h *Hub) setUp(up bool) {
	h.mu.Lock()
	h.up = up
	h.mu.Unlock()
}

// Run subscribes to Channel on the Redis server of rawURL
// (redis://[user]:[password]@host:port) until ctx ends, reconnecting after
// errors with a growing pause (1 s up to 30 s).
func (h *Hub) Run(ctx context.Context, rawURL string) {
	wait := time.Second
	for ctx.Err() == nil {
		start := time.Now()
		err := h.listen(ctx, rawURL)
		h.setUp(false)
		if ctx.Err() != nil {
			return
		}
		if time.Since(start) > time.Minute {
			wait = time.Second
		}
		slog.Warn("live updates: redis connection lost", "err", err, "retry", wait)
		select {
		case <-ctx.Done():
			return
		case <-time.After(wait):
		}
		wait = min(wait*2, 30*time.Second)
	}
}

func (h *Hub) listen(ctx context.Context, rawURL string) error {
	u, err := url.Parse(rawURL)
	if err != nil {
		return err
	}
	host := u.Host
	if u.Port() == "" {
		host = net.JoinHostPort(u.Hostname(), "6379")
	}
	var d net.Dialer
	conn, err := d.DialContext(ctx, "tcp", host)
	if err != nil {
		return err
	}
	defer conn.Close()
	stop := context.AfterFunc(ctx, func() { conn.Close() })
	defer stop()

	r := bufio.NewReader(conn)
	if pass, ok := u.User.Password(); ok && pass != "" {
		args := []string{"AUTH", pass}
		if name := u.User.Username(); name != "" {
			args = []string{"AUTH", name, pass}
		}
		if err := send(conn, args...); err != nil {
			return err
		}
		if _, err := readReply(r); err != nil {
			return fmt.Errorf("auth: %w", err)
		}
	}
	if err := send(conn, "SUBSCRIBE", Channel); err != nil {
		return err
	}
	for {
		reply, err := readReply(r)
		if err != nil {
			return err
		}
		parts, _ := reply.([]any)
		if len(parts) < 3 {
			continue
		}
		switch kind, _ := parts[0].(string); kind {
		case "subscribe":
			h.setUp(true)
			slog.Info("live updates: subscribed", "channel", Channel)
		case "message":
			if note, ok := parts[2].(string); ok {
				h.Publish([]byte(note))
			}
		}
	}
}

func send(w io.Writer, args ...string) error {
	var b strings.Builder
	fmt.Fprintf(&b, "*%d\r\n", len(args))
	for _, a := range args {
		fmt.Fprintf(&b, "$%d\r\n%s\r\n", len(a), a)
	}
	_, err := io.WriteString(w, b.String())
	return err
}

// readReply reads one RESP value: simple string, error, integer, bulk
// string (string, nil for null) or array ([]any).
func readReply(r *bufio.Reader) (any, error) {
	line, err := r.ReadString('\n')
	if err != nil {
		return nil, err
	}
	line = strings.TrimSuffix(line, "\r\n")
	if line == "" {
		return nil, errors.New("redis: empty reply")
	}
	switch line[0] {
	case '+':
		return line[1:], nil
	case '-':
		return nil, errors.New("redis: " + line[1:])
	case ':':
		return strconv.ParseInt(line[1:], 10, 64)
	case '$':
		n, err := strconv.Atoi(line[1:])
		if err != nil || n < 0 {
			return nil, err
		}
		if n > 1<<20 {
			return nil, errors.New("redis: reply too large")
		}
		buf := make([]byte, n+2)
		if _, err := io.ReadFull(r, buf); err != nil {
			return nil, err
		}
		return string(buf[:n]), nil
	case '*':
		n, err := strconv.Atoi(line[1:])
		if err != nil || n < 0 {
			return nil, err
		}
		if n > 64 {
			return nil, errors.New("redis: reply too large")
		}
		out := make([]any, n)
		for i := range out {
			if out[i], err = readReply(r); err != nil {
				return nil, err
			}
		}
		return out, nil
	}
	return nil, fmt.Errorf("redis: unexpected reply %q", line)
}
