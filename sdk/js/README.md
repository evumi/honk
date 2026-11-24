# @evumi/honk

[中文](README.zh-CN.md)

Send push notifications through a [Honk](https://github.com/evumi/honk) gateway from TypeScript or JavaScript: messages and cards, edits and deletes, end-to-end encryption, and answers to the widget queries that cards send with `request()`. No dependencies; it uses `fetch` and Web Crypto, so it runs on Node 20+, Bun, Deno and Cloudflare Workers.

```bash
npm install @evumi/honk
```

```ts
import { Honk } from "@evumi/honk";

const honk = new Honk({ url: "https://honk.example.com", token: "aZ3kQ9xT:Gw2K7mx…" });
// or: Honk.fromEnv()   // HONK_URL, HONK_TOKEN, HONK_KEY

await honk.send("backup finished");
const sent = await honk.send({
  title: "Deploy",
  body: "api v1.8.2 is live",
  html: "<b>{{status}}</b>",
  data: { status: "live" },
  id: "deploy-api", // a later message with this id replaces it
  level: "passive",
});
await honk.edit({ id: "deploy-api" }, { status: "rolled back" });
await honk.delete({ messageId: sent.messageId });
const bot = await honk.me();
const report = await honk.dryRun({ body: "x", html: card }); // what the whitelist keeps, sizes
```

`send` takes every `sendMessage` parameter in camelCase: `title`, `body`, `html`, `data` (a string is sent as JSON text, anything else as JSON), `url`, `copy`, `icon`, `image`, `level`, `group`, `id`, `open`, `parseMode`, `ttl` (seconds), `silent`, `allowQueries`. Results come back in camelCase too.

A refused call throws a `HonkError` with the gateway's `code` and `description`. `retries` retries 429s with backoff; `timeout` bounds each call (30 000 ms). Errors never contain the token. `honk.call(method, params)` reaches any Bot API method by name.

## End-to-end encryption

Pass the key the app shows in the bot's settings and every message's content (title, body, html, data, url, copy, icon, image) is sealed with AES-256-GCM before it leaves; `edit` seals the data. Routing fields (`level`, `group`, `id`, `ttl`, `silent`, `open`, `parseMode`, `allowQueries`) stay readable to the gateway.

```ts
const honk = new Honk({ url, token, key: process.env.HONK_KEY });
```

`seal`, `open` and `parseKey` are exported, if you need them directly.

## Widget queries

A card sent with `allowQueries: true` can call `request(data)`; the gateway holds it for up to 15 s while the bot answers. The handler's return value is the answer: a string as written, an object as JSON, nothing as `""` (at most 1024 bytes).

```ts
const answer = async (q: WidgetQuery) => {
  if (q.data === "approve") {
    await approve(q.messageId);
    return { status: "approved" };
  }
  throw new Error(`unknown action ${q.data}`);
};
```

Long polling (no public URL needed); it runs until the signal aborts, and rejects when the gateway refuses the polling (401, 404, or 409 while a webhook is set):

```ts
const stop = new AbortController();
await honk.poll(answer, { signal: stop.signal, onError: console.error });
```

Or a webhook (https on a public address). `webhookHandler` returns a fetch-style handler, `(Request) => Promise<Response>`:

```ts
await honk.setWebhook("https://bot.example.com/honk", { secretToken: secret });
const handle = honk.webhookHandler(answer, { secretToken: secret });

export default { fetch: handle };                                // Cloudflare Workers, Bun
export const POST = handle;                                      // Next.js route handler
http.createServer(toNodeHandler(handle)).listen(8443);           // node:http
app.post("/honk", toNodeHandler(handle));                        // Express
```

It checks the `X-Honk-Bot-Api-Secret-Token` header, runs the handler and answers before it replies 200. The gateway waits 5 s for a delivery, so keep webhook handlers quick. When the handler throws, the card's `request()` fails at once (`REQUEST_FAILED`) with a webhook, and after 15 s (`TIMEOUT`) with polling. `getUpdates`, `answerWidgetQuery`, `deleteWebhook` and `getWebhookInfo` are there for doing it by hand.

## Development

```bash
npm install
npm test             # node --test, straight from the TypeScript sources (Node 22.18+)
npm run typecheck
npm run build        # dist/
HONK_E2E_GATEWAY=http://127.0.0.1:8080 npm test   # also against a gateway run with HONK_RELAY_URL=off
```

The tests check against `app/src/e2e.vector.json`, the vector every Honk client shares. Releases are tagged `sdk/js/vX.Y.Z`.
