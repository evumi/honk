# Honk Go SDK

[中文](README.zh-CN.md)

Send push notifications through a [Honk](https://github.com/evumi/honk) gateway from Go: messages and cards, edits and deletes, end-to-end encryption, and answers to the widget queries that cards send with `request()`. No dependencies outside the standard library; Go 1.22 or later.

```bash
go get github.com/evumi/honk/sdk/go
```

The import path ends in `go`; the package is `honk`.

```go
import honk "github.com/evumi/honk/sdk/go"

c := &honk.Client{URL: "https://honk.example.com", Token: "aZ3kQ9xT:Gw2K7mx…"}
// or: c, err := honk.FromEnv()   // HONK_URL, HONK_TOKEN, HONK_KEY

sent, err := c.Send(ctx, honk.Message{
	Title: "Deploy",
	Body:  "api v1.8.2 is live",
	HTML:  `<b>{{status}}</b>`,
	Data:  map[string]string{"status": "live"},
	ID:    "deploy-api", // a later message with this id replaces it
	Level: honk.Passive,
})
err = c.Edit(ctx, honk.ByID("deploy-api"), map[string]string{"status": "rolled back"})
err = c.Delete(ctx, honk.ByMessageID(sent.MessageID))
bot, err := c.Me(ctx)
report, err := c.DryRun(ctx, honk.Message{Body: "x", HTML: card}) // what the whitelist keeps, sizes
```

`Message` has every `sendMessage` parameter: `Title`, `Body`, `HTML`, `Data` (a string is sent as JSON text, anything else is marshalled), `URL`, `Copy`, `Icon`, `Image`, `Level`, `Group`, `ID`, `Open` (`honk.OpenURL`), `ParseMode` (`honk.Markdown`), `TTL`, `Silent`, `AllowQueries`.

A refused call is an `*honk.Error` with the gateway's `Code` and `Description`; `honk.IsCode(err, 429)` tests for one. `Client.Retries` retries 429s with backoff; `Client.Timeout` bounds each call (30 s). Errors never contain the token.

## End-to-end encryption

Set `Key` to the key the app shows in the bot's settings and every message's content (title, body, html, data, url, copy, icon, image) is sealed with AES-256-GCM before it leaves; `Edit` seals the data. Routing fields (`Level`, `Group`, `ID`, `TTL`, `Silent`, `Open`, `ParseMode`, `AllowQueries`) stay readable to the gateway.

```go
key, err := honk.ParseKey(os.Getenv("HONK_KEY"))
c := &honk.Client{URL: url, Token: token, Key: key}
```

`honk.Seal` and `honk.Open` are the primitives, if you need them directly.

## Widget queries

A card sent with `AllowQueries: true` can call `request(data)`; the gateway holds it for up to 15 s while the bot answers. A `QueryHandler` returns the answer (0–1024 bytes):

```go
answer := func(ctx context.Context, q honk.WidgetQuery) (string, error) {
	switch q.Data {
	case "approve":
		return `{"status":"approved"}`, approve(ctx, q.MessageID)
	}
	return "", fmt.Errorf("unknown action %q", q.Data)
}
```

Long polling (no public URL needed); it blocks until `ctx` ends or the gateway refuses the polling (401, 404, or 409 while a webhook is set):

```go
err := c.Poll(ctx, answer, &honk.PollOptions{OnError: func(err error) { log.Print(err) }})
```

Or a webhook (https on a public address):

```go
err := c.SetWebhook(ctx, "https://bot.example.com/honk", secret)
http.Handle("/honk", c.WebhookHandler(answer, &honk.WebhookOptions{Secret: secret, OnError: logErr}))
```

The handler checks the `X-Honk-Bot-Api-Secret-Token` header (when `Secret` is set), runs your function and answers before it replies 200. The gateway waits 5 s for a delivery, so keep webhook handlers quick. `OnError` hears about handlers and answers that failed. When the handler returns an error the card's `request()` fails at once (`REQUEST_FAILED`) with a webhook, and after 15 s (`TIMEOUT`) with polling. `GetUpdates`, `AnswerWidgetQuery`, `DeleteWebhook` and `GetWebhookInfo` are there for doing it by hand.

## Tests

`go test ./...` checks against `app/src/e2e.vector.json`, the vector every Honk client shares. `HONK_E2E_GATEWAY=http://127.0.0.1:8080 go test -run TestGateway` runs the SDK against a real gateway started with `HONK_RELAY_URL=off`.

Releases are tagged `sdk/go/vX.Y.Z`.
