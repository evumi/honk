package honk

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"strings"
	"testing"
	"time"
)

// TestGateway runs the SDK against a real gateway. Start one with
// HONK_RELAY_URL=off (and HONK_REGISTER_KEY unset) and point
// HONK_E2E_GATEWAY at it, e.g. http://127.0.0.1:8080. The test registers a
// simulator device (which gets no pushes), plays the app's part through the
// App API and sends as a bot through the SDK.
func TestGateway(t *testing.T) {
	base := os.Getenv("HONK_E2E_GATEWAY")
	if base == "" {
		t.Skip("HONK_E2E_GATEWAY is not set")
	}
	base = strings.TrimRight(base, "/")
	ctx := context.Background()
	app := newAppClient(t, base)

	var created struct {
		Bot struct {
			ID string `json:"id"`
		} `json:"bot"`
		Token string `json:"token"`
	}
	app.do("POST", "/v1/bots", map[string]any{"name": "SDK e2e (Go)"}, &created)
	c := &Client{URL: base, Token: created.Token}

	bot, err := c.Me(ctx)
	if err != nil || bot.ID != created.Bot.ID || bot.Name != "SDK e2e (Go)" {
		t.Fatalf("Me = %+v, %v", bot, err)
	}

	rep, err := c.DryRun(ctx, Message{Body: "x", HTML: `<b onclick="x()">{{s}}</b>`})
	if err != nil || rep.HTML != "<b>{{s}}</b>" || len(rep.Removed) != 1 {
		t.Fatalf("DryRun = %+v, %v", rep, err)
	}

	sent, err := c.Send(ctx, Message{Title: "t", Body: "b", HTML: "<b>{{s}}</b>", Data: map[string]string{"s": "1"}, ID: "e2e", Level: Passive})
	if err != nil || sent.MessageID == 0 || sent.ID != "e2e" || sent.Level != Passive {
		t.Fatalf("Send = %+v, %v", sent, err)
	}
	if err := c.Edit(ctx, ByID("e2e"), map[string]string{"s": "2"}); err != nil {
		t.Fatal(err)
	}
	if err := c.Delete(ctx, ByMessageID(sent.MessageID)); err != nil {
		t.Fatal(err)
	}
	if _, err := c.Send(ctx, Message{}); !IsCode(err, 400) {
		t.Fatalf("empty Send = %v", err)
	}

	// Widget queries through getUpdates.
	card, err := c.Send(ctx, Message{Body: "card", HTML: "<button>go</button>", AllowQueries: true})
	if err != nil {
		t.Fatal(err)
	}
	pctx, stop := context.WithCancel(ctx)
	done := make(chan error, 1)
	go func() {
		done <- c.Poll(pctx, func(_ context.Context, q WidgetQuery) (string, error) {
			if q.MessageID != card.MessageID {
				return "", fmt.Errorf("query for message %d", q.MessageID)
			}
			return "pong:" + q.Data, nil
		}, &PollOptions{Timeout: 5 * time.Second, OnError: func(err error) { t.Log(err) }})
	}()
	var answer struct {
		Data string `json:"data"`
	}
	app.do("POST", "/v1/queries", map[string]any{"message_id": card.MessageID, "data": "ping"}, &answer)
	if answer.Data != "pong:ping" {
		t.Fatalf("answer = %q", answer.Data)
	}
	stop()
	if err := <-done; err != context.Canceled {
		t.Fatalf("Poll = %v", err)
	}

	// End-to-end encryption: the app turns it on, plaintext is refused, the
	// device opens what the SDK sealed.
	app.do("PATCH", "/v1/bots/"+bot.ID, map[string]any{"encrypted": true}, nil)
	if _, err := c.Send(ctx, Message{Body: "plain"}); !IsCode(err, 400) {
		t.Fatalf("plain Send to an encrypted bot = %v", err)
	}
	key := make([]byte, 32)
	_, _ = rand.Read(key)
	c.Key = key
	sent, err = c.Send(ctx, Message{Title: "secret", Body: "sealed", Data: `{"n":1}`, ID: "e2e-sealed"})
	if err != nil {
		t.Fatal(err)
	}
	var stored struct {
		Ciphertext string `json:"ciphertext"`
		Body       string `json:"body"`
		ID         string `json:"id"`
	}
	app.do("GET", fmt.Sprintf("/v1/messages/%d", sent.MessageID), nil, &stored)
	plain, err := Open(key, bot.ID, stored.Ciphertext)
	if err != nil || stored.Body != "" || stored.ID != "e2e-sealed" {
		t.Fatalf("stored = %+v, %v", stored, err)
	}
	if string(plain) != `{"body":"sealed","data":"{\"n\":1}","title":"secret"}` {
		t.Fatalf("plaintext = %s", plain)
	}
	if err := c.Edit(ctx, ByID("e2e-sealed"), map[string]int{"n": 2}); err != nil {
		t.Fatal(err)
	}

	app.do("DELETE", "/v1/bots/"+bot.ID, nil, nil)
	if _, err := c.Me(ctx); !IsCode(err, 401) && !IsCode(err, 404) {
		t.Fatalf("Me after delete = %v", err)
	}
}

// appClient plays the phone: a registered device calling the App API.
type appClient struct {
	t      *testing.T
	base   string
	secret string
}

func newAppClient(t *testing.T, base string) *appClient {
	a := &appClient{t: t, base: base}
	tok := make([]byte, 8)
	_, _ = rand.Read(tok)
	var reg struct {
		Secret string `json:"device_secret"`
	}
	a.do("POST", "/v1/devices", map[string]any{"platform": "ios", "push_token": "simulator-" + hex.EncodeToString(tok), "name": "sdk e2e"}, &reg)
	a.secret = reg.Secret
	t.Cleanup(func() { a.do("DELETE", "/v1/devices/me", nil, nil) })
	return a
}

func (a *appClient) do(method, path string, in, out any) {
	a.t.Helper()
	var body bytes.Buffer
	if in != nil {
		_ = json.NewEncoder(&body).Encode(in)
	}
	req, _ := http.NewRequest(method, a.base+path, &body)
	req.Header.Set("Content-Type", "application/json")
	if a.secret != "" {
		req.Header.Set("Authorization", "Bearer "+a.secret)
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		a.t.Fatal(err)
	}
	defer res.Body.Close()
	var env struct {
		OK          bool            `json:"ok"`
		Result      json.RawMessage `json:"result"`
		Description string          `json:"description"`
	}
	if err := json.NewDecoder(res.Body).Decode(&env); err != nil || !env.OK {
		a.t.Fatalf("%s %s: %d %s %v", method, path, res.StatusCode, env.Description, err)
	}
	if out != nil {
		if err := json.Unmarshal(env.Result, out); err != nil {
			a.t.Fatal(err)
		}
	}
}
