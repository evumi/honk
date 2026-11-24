# @evumi/honk

[English](README.md)

用 TypeScript 或 JavaScript 通过 [Honk](https://github.com/evumi/honk) 网关发推送：消息与卡片、编辑与删除、端到端加密，以及应答卡片里 `request()` 发来的 widget query。没有任何依赖，只用 `fetch` 和 Web Crypto，所以 Node 20+、Bun、Deno 和 Cloudflare Workers 都能跑。

```bash
npm install @evumi/honk
```

```ts
import { Honk } from "@evumi/honk";

const honk = new Honk({ url: "https://honk.example.com", token: "aZ3kQ9xT:Gw2K7mx…" });
// 或者：Honk.fromEnv()   // HONK_URL、HONK_TOKEN、HONK_KEY

await honk.send("备份完成");
const sent = await honk.send({
  title: "部署",
  body: "api v1.8.2 已上线",
  html: "<b>{{status}}</b>",
  data: { status: "live" },
  id: "deploy-api", // 之后同 id 的消息会替换这一条
  level: "passive",
});
await honk.edit({ id: "deploy-api" }, { status: "已回滚" });
await honk.delete({ messageId: sent.messageId });
const bot = await honk.me();
const report = await honk.dryRun({ body: "x", html: card }); // 白名单保留了什么、大小
```

`send` 用 camelCase 接收 `sendMessage` 的全部参数：`title`、`body`、`html`、`data`（字符串按 JSON 文本原样发送，其他值发 JSON）、`url`、`copy`、`icon`、`image`、`level`、`group`、`id`、`open`、`parseMode`、`ttl`（秒）、`silent`、`allowQueries`。返回结果也是 camelCase。

被网关拒绝的调用会抛出 `HonkError`，带网关的 `code` 和 `description`。`retries` 会在 429 时退避重试；`timeout` 限制每次调用（默认 30 000 毫秒）。错误信息里不会出现 token。`honk.call(method, params)` 可以按名字调用任意 Bot API 方法。

## 端到端加密

传入 App 在 bot 设置里显示的密钥，每条消息的内容（title、body、html、data、url、copy、icon、image）在发出前就用 AES-256-GCM 加密；`edit` 也会加密 data。路由字段（`level`、`group`、`id`、`ttl`、`silent`、`open`、`parseMode`、`allowQueries`）对网关仍然可读。

```ts
const honk = new Honk({ url, token, key: process.env.HONK_KEY });
```

需要直接用底层函数时，有导出的 `seal`、`open` 和 `parseKey`。

## Widget query

用 `allowQueries: true` 发出的卡片可以调用 `request(data)`，网关最多等 15 秒让 bot 应答。处理函数的返回值就是应答：字符串原样发送，对象发 JSON，没有返回值则发 `""`（最多 1024 字节）。

```ts
const answer = async (q: WidgetQuery) => {
  if (q.data === "approve") {
    await approve(q.messageId);
    return { status: "approved" };
  }
  throw new Error(`未知操作 ${q.data}`);
};
```

长轮询（不需要公网地址）；会一直运行到 signal 中止，网关拒绝轮询时（401、404，或设了 webhook 时的 409）会 reject：

```ts
const stop = new AbortController();
await honk.poll(answer, { signal: stop.signal, onError: console.error });
```

或者用 webhook（公网地址上的 https）。`webhookHandler` 返回一个 fetch 风格的 handler，即 `(Request) => Promise<Response>`：

```ts
await honk.setWebhook("https://bot.example.com/honk", { secretToken: secret });
const handle = honk.webhookHandler(answer, { secretToken: secret });

export default { fetch: handle };                                // Cloudflare Workers、Bun
export const POST = handle;                                      // Next.js route handler
http.createServer(toNodeHandler(handle)).listen(8443);           // node:http
app.post("/honk", toNodeHandler(handle));                        // Express
```

它会校验 `X-Honk-Bot-Api-Secret-Token` 请求头、运行处理函数，并在回复 200 之前完成应答。网关只等 webhook 5 秒，所以处理要快。处理函数抛错时，webhook 模式下卡片的 `request()` 会立刻失败（`REQUEST_FAILED`），长轮询模式下要等 15 秒超时（`TIMEOUT`）。想手动处理时可以用 `getUpdates`、`answerWidgetQuery`、`deleteWebhook` 和 `getWebhookInfo`。

## 开发

```bash
npm install
npm test             # node --test，直接跑 TypeScript 源码（Node 22.18+）
npm run typecheck
npm run build        # 输出到 dist/
HONK_E2E_GATEWAY=http://127.0.0.1:8080 npm test   # 同时对一个用 HONK_RELAY_URL=off 启动的网关跑
```

测试用所有 Honk 客户端共用的 `app/src/e2e.vector.json` 做校验。版本 tag 是 `sdk/js/vX.Y.Z`。
