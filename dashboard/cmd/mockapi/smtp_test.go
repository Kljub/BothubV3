package main

import (
	"bufio"
	"context"
	"net"
	"strconv"
	"strings"
	"testing"
)

// fakeSMTP accepts one mail without encryption and hands its data to got.
func fakeSMTP(t *testing.T, got chan<- string) (string, int) {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ln.Close() })
	go func() {
		conn, err := ln.Accept()
		if err != nil {
			return
		}
		defer conn.Close()
		r, w := bufio.NewReader(conn), conn
		say := func(s string) { _, _ = w.Write([]byte(s + "\r\n")) }
		say("220 fake ESMTP")
		var data strings.Builder
		for {
			line, err := r.ReadString('\n')
			if err != nil {
				return
			}
			cmd := strings.ToUpper(strings.TrimSpace(line))
			switch {
			case strings.HasPrefix(cmd, "EHLO"), strings.HasPrefix(cmd, "HELO"):
				say("250 fake")
			case strings.HasPrefix(cmd, "MAIL"), strings.HasPrefix(cmd, "RCPT"):
				say("250 ok")
			case cmd == "DATA":
				say("354 go on")
				for {
					l, _ := r.ReadString('\n')
					if strings.TrimRight(l, "\r\n") == "." {
						break
					}
					data.WriteString(l)
				}
				say("250 queued")
				got <- data.String()
			case cmd == "QUIT":
				say("221 bye")
				return
			default:
				say("502 no")
			}
		}
	}()
	host, port, _ := net.SplitHostPort(ln.Addr().String())
	p, _ := strconv.Atoi(port)
	return host, p
}

func TestSendMail(t *testing.T) {
	got := make(chan string, 1)
	host, port := fakeSMTP(t, got)
	cfg := smtpData{Enabled: true, Host: host, Port: port, Security: "none", FromAddress: "bot@example.org", FromName: "BotHub"}
	if err := sendMail(context.Background(), cfg, "me@example.org", "BotHub test mail", "Hello"); err != nil {
		t.Fatal(err)
	}
	mail := <-got
	for _, want := range []string{"From: \"BotHub\" <bot@example.org>", "To: me@example.org", "Subject: BotHub test mail", "Hello"} {
		if !strings.Contains(mail, want) {
			t.Errorf("mail lacks %q:\n%s", want, mail)
		}
	}
	// Sign-in without encryption is refused before anything is sent.
	cfg.Username, cfg.password = "u", "p"
	if err := sendMail(context.Background(), cfg, "me@example.org", "x", "y"); err == nil || !strings.Contains(err.Error(), "without encryption") {
		t.Errorf("auth over plain text: %v", err)
	}
	if err := sendMail(context.Background(), cfg, "not an address", "x", "y"); err == nil {
		t.Error("bad recipient accepted")
	}
}
