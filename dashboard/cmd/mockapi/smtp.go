package main

import (
	"context"
	"crypto/tls"
	"errors"
	"fmt"
	"log/slog"
	"mime"
	"net"
	"net/http"
	"net/mail"
	"net/smtp"
	"strconv"
	"strings"
	"time"
)

// SMTP: the settings are stored through the PHP API (settings key "smtp";
// the password encrypted there) and the test mail is really sent.

const smtpTimeout = 20 * time.Second

// persistSMTP stores the settings; password nil keeps the stored one. Caller holds s.mu.
func (s *store) persistSMTP(password *string) {
	if s.php == nil {
		return
	}
	c := s.smtp
	body := map[string]any{
		"enabled": c.Enabled, "host": c.Host, "port": c.Port, "security": c.Security,
		"username": c.Username, "fromAddress": c.FromAddress, "fromName": c.FromName,
	}
	if password != nil {
		body["password"] = *password
	}
	go s.phpSync(http.MethodPut, "/internal/settings/smtp", body)
}

// loadSMTP reads the stored settings at start.
func (s *store) loadSMTP() {
	if s.php == nil {
		return
	}
	var out struct {
		Value *struct {
			smtpData
			Password string `json:"password"`
		}
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := s.php.do(ctx, http.MethodGet, "/internal/settings/smtp", nil, &out); err != nil {
		slog.Error("mockapi: smtp settings not loaded", "err", err)
		return
	}
	if out.Value == nil || out.Value.Port == 0 {
		return // never saved: the defaults stay
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.smtp = out.Value.smtpData
	s.smtp.password, s.smtp.PasswordSet = out.Value.Password, out.Value.Password != ""
}

// sendMail sends one plain-text mail with the settings.
func sendMail(ctx context.Context, cfg smtpData, to, subject, body string) error {
	if _, err := mail.ParseAddress(to); err != nil {
		return errors.New("invalid recipient address")
	}
	if cfg.Username != "" && cfg.Security == "none" {
		return errors.New("sign-in without encryption is not allowed: choose STARTTLS or TLS")
	}
	addr := net.JoinHostPort(cfg.Host, strconv.Itoa(cfg.Port))
	dialer := &net.Dialer{Timeout: smtpTimeout}
	var conn net.Conn
	var err error
	if cfg.Security == "tls" {
		conn, err = tls.DialWithDialer(dialer, "tcp", addr, &tls.Config{ServerName: cfg.Host, MinVersion: tls.VersionTLS12})
	} else {
		conn, err = dialer.DialContext(ctx, "tcp", addr)
	}
	if err != nil {
		return err
	}
	_ = conn.SetDeadline(time.Now().Add(smtpTimeout))
	c, err := smtp.NewClient(conn, cfg.Host)
	if err != nil {
		conn.Close()
		return err
	}
	defer c.Close()
	if cfg.Security == "starttls" {
		if ok, _ := c.Extension("STARTTLS"); !ok {
			return errors.New("the server does not offer STARTTLS")
		}
		if err := c.StartTLS(&tls.Config{ServerName: cfg.Host, MinVersion: tls.VersionTLS12}); err != nil {
			return err
		}
	}
	if cfg.Username != "" {
		if err := c.Auth(smtp.PlainAuth("", cfg.Username, cfg.password, cfg.Host)); err != nil {
			return err
		}
	}
	if err := c.Mail(cfg.FromAddress); err != nil {
		return err
	}
	if err := c.Rcpt(to); err != nil {
		return err
	}
	w, err := c.Data()
	if err != nil {
		return err
	}
	from := (&mail.Address{Name: cfg.FromName, Address: cfg.FromAddress}).String()
	host := cfg.FromAddress[strings.LastIndexByte(cfg.FromAddress, '@')+1:]
	msg := strings.Join([]string{
		"From: " + from,
		"To: " + to,
		"Subject: " + mime.QEncoding.Encode("utf-8", subject),
		"Date: " + time.Now().Format(time.RFC1123Z),
		fmt.Sprintf("Message-ID: <%s@%s>", randomHex(12), host),
		"MIME-Version: 1.0",
		"Content-Type: text/plain; charset=utf-8",
		"Content-Transfer-Encoding: 8bit",
		"",
		strings.ReplaceAll(body, "\n", "\r\n"),
	}, "\r\n")
	if _, err := w.Write([]byte(msg)); err != nil {
		return err
	}
	if err := w.Close(); err != nil {
		return err
	}
	return c.Quit()
}
