package live

import (
	"bufio"
	"context"
	"net"
	"strconv"
	"strings"
	"testing"
	"time"
)

// A fake Redis: checks AUTH and SUBSCRIBE, then sends one message.
func TestHubForwardsMessages(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	got := make(chan string, 2)
	go func() {
		c, err := ln.Accept()
		if err != nil {
			return
		}
		defer c.Close()
		r := bufio.NewReader(c)
		for _, want := range []string{"AUTH", "SUBSCRIBE"} {
			v, err := readReply(r)
			if err != nil {
				return
			}
			args := v.([]any)
			got <- strings.Join([]string{args[0].(string), args[len(args)-1].(string)}, " ")
			if want == "AUTH" {
				c.Write([]byte("+OK\r\n"))
			}
		}
		c.Write([]byte("*3\r\n$9\r\nsubscribe\r\n$11\r\nbothub:live\r\n:1\r\n"))
		note := `{"type":"bot.status","botId":12,"status":"stopped"}`
		c.Write([]byte("*3\r\n$7\r\nmessage\r\n$11\r\nbothub:live\r\n$" + strconv.Itoa(len(note)) + "\r\n" + note + "\r\n"))
		time.Sleep(time.Second)
	}()

	h := New()
	notes, cancel := h.Subscribe()
	defer cancel()
	ctx, stop := context.WithCancel(context.Background())
	defer stop()
	go h.Run(ctx, "redis://:secret@"+ln.Addr().String())

	if a := <-got; a != "AUTH secret" {
		t.Fatalf("auth = %q", a)
	}
	if s := <-got; s != "SUBSCRIBE bothub:live" {
		t.Fatalf("subscribe = %q", s)
	}
	select {
	case n := <-notes:
		if !strings.Contains(string(n), `"botId":12`) {
			t.Fatalf("note = %s", n)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("no note")
	}
	if !h.Connected() {
		t.Fatal("not connected after subscribe")
	}
}

func TestSlowSubscriberDoesNotBlock(t *testing.T) {
	h := New()
	_, cancel := h.Subscribe()
	defer cancel()
	for range 100 {
		h.Publish([]byte("x")) // buffer of 16, the rest is dropped
	}
}
