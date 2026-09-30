package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
)

const goodToken = "good.token.value"

// fakeDiscord answers like Discord for one valid bot token.
func fakeDiscord(t *testing.T, calls *atomic.Int32) *httptest.Server {
	t.Helper()
	limited := atomic.Bool{}
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		if r.Header.Get("Authorization") != "Bot "+goodToken {
			w.WriteHeader(401)
			_, _ = w.Write([]byte(`{"message":"401: Unauthorized","code":0}`))
			return
		}
		send := func(v any) { _ = json.NewEncoder(w).Encode(v) }
		switch {
		case r.Method == "GET" && r.URL.Path == "/users/@me":
			send(map[string]any{"id": "111111111111111111", "username": "helper", "global_name": "Helper", "avatar": "a_abc", "banner": nil, "bot": true})
		case r.Method == "GET" && r.URL.Path == "/applications/@me":
			send(map[string]any{"id": "222222222222222222", "name": "Helper", "description": "Hi", "flags": 1 << 14})
		case r.Method == "GET" && r.URL.Path == "/users/@me/guilds":
			if !limited.Swap(true) {
				w.WriteHeader(429)
				_, _ = w.Write([]byte(`{"message":"You are being rate limited.","retry_after":0.05,"global":false}`))
				return
			}
			send([]map[string]any{{"id": "333333333333333333", "name": "Test", "icon": "ic", "approximate_member_count": 7}})
		case r.Method == "GET" && r.URL.Path == "/guilds/333333333333333333/roles":
			send([]map[string]any{
				{"id": "333333333333333333", "name": "@everyone", "color": 0, "position": 0},
				{"id": "444444444444444444", "name": "Mod", "color": 0x3498db, "position": 2},
				{"id": "555555555555555555", "name": "Member", "color": 0, "position": 1, "managed": false},
			})
		case r.Method == "GET" && r.URL.Path == "/guilds/999999999999999999/channels":
			w.WriteHeader(404)
			_, _ = w.Write([]byte(`{"message":"Unknown Guild","code":10004}`))
		case r.Method == "PATCH" && r.URL.Path == "/users/@me":
			w.WriteHeader(400)
			_, _ = w.Write([]byte(`{"message":"Invalid Form Body","code":50035}`))
		default:
			w.WriteHeader(404)
		}
	}))
}

func TestCheckToken(t *testing.T) {
	var calls atomic.Int32
	srv := fakeDiscord(t, &calls)
	defer srv.Close()
	c := newDiscordClient(srv.URL)
	ctx := context.Background()

	id, err := c.checkToken(ctx, "Bot "+goodToken+"\n")
	if err != nil {
		t.Fatalf("valid token rejected: %v", err)
	}
	if id.User.Username != "helper" || id.Application.ID != "222222222222222222" {
		t.Fatalf("identity = %+v", id)
	}
	if got := avatarURL(id.User); !strings.HasSuffix(got, "/avatars/111111111111111111/a_abc.gif?size=256") {
		t.Fatalf("animated avatar url = %s", got)
	}
	if got := missingIntents(id.Application.Flags); strings.Join(got, ",") != "GUILD_PRESENCES,MESSAGE_CONTENT" {
		t.Fatalf("missing intents = %v", got)
	}

	for _, bad := range []string{"", "wrong.token", "with space"} {
		_, err := c.checkToken(ctx, bad)
		if de := asDiscordError(err); de.Key != "error.bot.token_invalid" || de.Status != 422 {
			t.Fatalf("token %q: got %+v", bad, de)
		}
	}
}

func TestGuildsRetryAndCache(t *testing.T) {
	var calls atomic.Int32
	srv := fakeDiscord(t, &calls)
	defer srv.Close()
	c := newDiscordClient(srv.URL)
	ctx := context.Background()

	guilds, err := c.guilds(ctx, goodToken)
	if err != nil || len(guilds) != 1 || guilds[0].MemberCount != 7 {
		t.Fatalf("guilds = %+v, %v", guilds, err)
	}
	if calls.Load() != 2 {
		t.Fatalf("expected one retry after 429, calls = %d", calls.Load())
	}
	if _, err := c.guilds(ctx, goodToken); err != nil || calls.Load() != 2 {
		t.Fatalf("second call should come from the cache (calls %d, err %v)", calls.Load(), err)
	}
	c.forget(goodToken)
	if _, err := c.guilds(ctx, goodToken); err != nil || calls.Load() != 3 {
		t.Fatalf("forget should drop the cache (calls %d)", calls.Load())
	}
	if url := guildIconURL(guilds[0]); url == nil || !strings.Contains(*url, "/icons/333333333333333333/ic.png") {
		t.Fatalf("icon url = %v", url)
	}
}

func TestErrorsMapToDashboardKeys(t *testing.T) {
	var calls atomic.Int32
	srv := fakeDiscord(t, &calls)
	defer srv.Close()
	c := newDiscordClient(srv.URL)
	ctx := context.Background()

	_, err := c.channels(ctx, goodToken, "999999999999999999")
	if de := asDiscordError(err); de.Key != "error.guild.not_found" || de.Status != 404 {
		t.Fatalf("unknown guild: %+v", de)
	}
	_, err = c.updateUser(ctx, goodToken, map[string]any{"avatar": "data:image/png;base64,xx"})
	if de := asDiscordError(err); de.Key != "error.discord.invalid_form" {
		t.Fatalf("invalid form: %+v", de)
	}
	_, err = newDiscordClient("http://127.0.0.1:1").me(ctx, goodToken)
	if de := asDiscordError(err); de.Key != "error.discord.unavailable" || de.Status != 502 {
		t.Fatalf("unreachable: %+v", de)
	}
	if strings.Contains(asDiscordError(err).Error(), goodToken) {
		t.Fatal("error text contains the token")
	}
}

func TestRolesAndColors(t *testing.T) {
	var calls atomic.Int32
	srv := fakeDiscord(t, &calls)
	defer srv.Close()
	roles, err := newDiscordClient(srv.URL).roles(context.Background(), goodToken, "333333333333333333")
	if err != nil || len(roles) != 3 {
		t.Fatalf("roles = %v, %v", roles, err)
	}
	if roleColor(0x3498db) != "#3498db" || roleColor(0) != nil {
		t.Fatal("role colors")
	}
	if channelTypes[15] != "forum" || channelTypes[4] != "category" {
		t.Fatal("channel types")
	}
}
