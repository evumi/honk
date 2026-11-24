# Honk Go SDK

[English](README.md)

用 Go 通过 [Honk](https://github.com/evumi/honk) 网关发推送：消息与卡片、编辑与删除、端到端加密，以及应答卡片里 `request()` 发来的 widget query。只用标准库，需要 Go 1.22 或更高。

```bash
go get github.com/evumi/honk/sdk/go
```

导入路径以 `go` 结尾，包名是 `honk`。

```go
import honk "github.com/evumi/honk/sdk/go"

c := &honk.Client{URL: "https://honk.example.com", Token: "aZ3kQ9xT:Gw2K7mx…"}
// 或者：c, err := honk.FromEnv()   // HONK_URL、HONK_TOKEN、HONK_KEY

sent, err := c.Send(ctx, honk.Message{
	Title: "部署",
	Body:  "api v1.8.2 已上线",
	HTML:  `<b>{{status}}</b>`,
	Data:  map[string]string{"status": "live"},
	ID:    "deploy-api", // 之后同 id 的消息会替换这一条
	Level: honk.Passive,
})
err = c.Edit(ctx, honk.ByID("deploy-api"), map[string]string{"status": "已回滚"})
err = c.Delete(ctx, honk.ByMessageID(sent.MessageID))
bot, err := c.Me(ctx)
report, err := c.DryRun(ctx, honk.Message{Body: "x", HTML: card}) // 白名单保留了什么、大小
```

`Message` 覆盖 `sendMessage` 的全部参数：`Title`、`Body`、`HTML`、`Data`（字符串按 JSON 文本原样发送，其他值会序列化成 JSON）、`URL`、`Copy`、`Icon`、`Image`、`Level`、`Group`、`ID`、`Open`（`honk.OpenURL`）、`ParseMode`（`honk.Markdown`）、`TTL`、`Silent`、`AllowQueries`。

被网关拒绝的调用返回 `*honk.Error`，带网关的 `Code` 和 `Description`；`honk.IsCode(err, 429)` 用来判断。`Client.Retries` 会在 429 时退避重试；`Client.Timeout` 限制每次调用（默认 30 秒）。错误信息里不会出现 token。

## 端到端加密

把 App 在 bot 设置里显示的密钥设为 `Key`，每条消息的内容（title、body、html、data、url、copy、icon、image）在发出前就用 AES-256-GCM 加密；`Edit` 也会加密 data。路由字段（`Level`、`Group`、`ID`、`TTL`、`Silent`、`Open`、`ParseMode`、`AllowQueries`）对网关仍然可读。

```go
key, err := honk.ParseKey(os.Getenv("HONK_KEY"))
c := &honk.Client{URL: url, Token: token, Key: key}
```

需要直接用底层加解密时，有 `honk.Seal` 和 `honk.Open`。

## Widget query

用 `AllowQueries: true` 发出的卡片可以调用 `request(data)`，网关最多等 15 秒让 bot 应答。`QueryHandler` 返回应答内容（0–1024 字节）：

```go
answer := func(ctx context.Context, q honk.WidgetQuery) (string, error) {
	switch q.Data {
	case "approve":
		return `{"status":"approved"}`, approve(ctx, q.MessageID)
	}
	return "", fmt.Errorf("未知操作 %q", q.Data)
}
```

长轮询（不需要公网地址）；会一直阻塞，直到 `ctx` 结束或网关拒绝轮询（401、404，或设了 webhook 时的 409）：

```go
err := c.Poll(ctx, answer, &honk.PollOptions{OnError: func(err error) { log.Print(err) }})
```

或者用 webhook（公网地址上的 https）：

```go
err := c.SetWebhook(ctx, "https://bot.example.com/honk", secret)
http.Handle("/honk", c.WebhookHandler(answer, &honk.WebhookOptions{Secret: secret, OnError: logErr}))
```

这个 handler 会校验 `X-Honk-Bot-Api-Secret-Token` 请求头（设了 `Secret` 时）、运行你的函数，并在回复 200 之前完成应答。网关只等 webhook 5 秒，所以处理要快。`OnError` 会收到失败的处理和应答。处理函数返回错误时，webhook 模式下卡片的 `request()` 会立刻失败（`REQUEST_FAILED`），长轮询模式下要等 15 秒超时（`TIMEOUT`）。想手动处理时可以用 `GetUpdates`、`AnswerWidgetQuery`、`DeleteWebhook` 和 `GetWebhookInfo`。

## 测试

`go test ./...` 用所有 Honk 客户端共用的 `app/src/e2e.vector.json` 做校验。`HONK_E2E_GATEWAY=http://127.0.0.1:8080 go test -run TestGateway` 会对一个用 `HONK_RELAY_URL=off` 启动的真实网关跑 SDK。

推 tag 即发布：先改 `honk.go` 里的 `Version`，再推 `sdk/go/vX.Y.Z`；CI 跑测试后让 proxy.golang.org 拉取。

## 许可

MIT
