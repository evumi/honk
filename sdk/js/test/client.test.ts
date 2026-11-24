import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { after, test } from "node:test";
import { readFileSync } from "node:fs";
import { Honk, HonkError, SECRET_HEADER, VERSION, open, parseKey, toNodeHandler } from "../src/index.ts";
import { FakeGateway, TOKEN } from "./fake.ts";

const KEY = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8";
const gateways: FakeGateway[] = [];
after(() => Promise.all(gateways.map((g) => g.close())));

async function fake(reply: ConstructorParameters<typeof FakeGateway>[0], options: { key?: string; retries?: number } = {}) {
  const g = await new FakeGateway(reply).start();
  gateways.push(g);
  return { g, honk: new Honk({ url: g.url, token: TOKEN, ...options }) };
}

test("send maps the message to sendMessage", async () => {
  const { g, honk } = await fake(() => [200, { message_id: 7, bot_id: "Ab3dEf9h", kind: "message", id: "deploy", date: 1700000000000 }]);
  const sent = await honk.send({
    title: "Deploy",
    body: "live <b>",
    html: "<b>{{status}}</b>",
    data: { status: "ok" },
    level: "timeSensitive",
    id: "deploy",
    ttl: 120,
    silent: true,
    allowQueries: true,
    parseMode: "Markdown",
  });
  assert.deepEqual(sent, { messageId: 7, botId: "Ab3dEf9h", kind: "message", id: "deploy", date: 1700000000000 });
  assert.deepEqual(g.last(), {
    method: "sendMessage",
    params: {
      title: "Deploy",
      body: "live <b>",
      html: "<b>{{status}}</b>",
      data: '{"status":"ok"}',
      level: "timeSensitive",
      id: "deploy",
      ttl: 120,
      silent: true,
      allow_queries: true,
      parse_mode: "Markdown",
    },
  });
  await honk.send("just text");
  assert.deepEqual(g.last().params, { body: "just text" });
});

test("with a key the content is sealed and the routing stays plain", async () => {
  const { g, honk } = await fake(() => [200, { message_id: 1 }], { key: KEY });
  assert.equal(honk.encrypted, true);
  await honk.send({
    title: "t",
    body: "b",
    data: '{"n":1}',
    image: "https://example.com/i.png",
    url: "https://example.com",
    open: "url",
    level: "passive",
    group: "g",
    id: "x",
  });
  const p = g.last().params;
  for (const k of ["title", "body", "html", "data", "url", "copy", "icon", "image"]) assert.equal(p[k], undefined, k);
  assert.deepEqual({ level: p.level, group: p.group, id: p.id, open: p.open }, { level: "passive", group: "g", id: "x", open: "url" });
  const content = JSON.parse(await open(parseKey(KEY), "Ab3dEf9h", p.ciphertext as string));
  assert.deepEqual(content, { title: "t", body: "b", url: "https://example.com", image: "https://example.com/i.png", data: '{"n":1}' });

  await honk.edit({ id: "x" }, { n: 2 });
  const e = g.last();
  assert.equal(e.method, "editMessageData");
  assert.equal(e.params.data, undefined);
  assert.equal(await open(parseKey(KEY), "Ab3dEf9h", e.params.ciphertext as string), '{"data":"{\\"n\\":2}"}');
});

test("edit, delete, me, dryRun", async () => {
  const { g, honk } = await fake((method) => {
    if (method === "getMe") return [200, { id: "Ab3dEf9h", name: "CI", avatar: "bell", default_level: "active", encrypted: true, created_at: 1, updated_at: 2 }];
    if (method === "sendMessage") return [200, { dry_run: true, level: "active", html: "<b></b>", input_size: 20, raw_size: 7, compressed_size: 15, removed: ["onclick on <b>"] }];
    return [200, true];
  });
  await honk.edit({ messageId: 9 }, '{"a":1}');
  assert.deepEqual(g.last(), { method: "editMessageData", params: { message_id: 9, data: '{"a":1}' } });
  await honk.delete({ id: "deploy" });
  assert.deepEqual(g.last(), { method: "deleteMessage", params: { id: "deploy" } });
  await assert.rejects(honk.delete({ id: "" }), /needs id or messageId/);
  assert.deepEqual(await honk.me(), { id: "Ab3dEf9h", name: "CI", avatar: "bell", defaultLevel: "active", encrypted: true, createdAt: 1, updatedAt: 2 });
  const rep = await honk.dryRun({ body: "x", html: '<b onclick="x()"></b>' });
  assert.equal(g.last().params.dry_run, true);
  assert.deepEqual(rep.removed, ["onclick on <b>"]);
  assert.equal(rep.compressedSize, 15);
});

test("errors, retries and a token kept out of messages", async () => {
  let n = 0;
  const { honk, g } = await fake(() => (++n < 3 ? [429, "Too Many Requests"] : [400, "Bad Request: body is required"]));
  await assert.rejects(honk.send({}), (e) => e instanceof HonkError && e.code === 429);
  assert.equal(n, 1);
  const retrying = new Honk({ url: g.url, token: TOKEN, retries: 2 });
  const start = Date.now();
  await assert.rejects(retrying.send({}), (e) => e instanceof HonkError && e.code === 400 && e.description.includes("body is required"));
  assert.equal(n, 3);
  assert.ok(Date.now() - start >= 1000);

  const down = new Honk({ url: "http://127.0.0.1:1", token: TOKEN });
  await assert.rejects(down.me(), (e) => e instanceof Error && !(e instanceof HonkError) && !e.message.includes("secret"));
});

test("poll answers widget queries and stops on 409", async () => {
  let polls = 0;
  const answers: Record<string, unknown>[] = [];
  const { honk } = await fake((method, p) => {
    if (method === "answerWidgetQuery") {
      answers.push(p);
      return [200, true];
    }
    switch (++polls) {
      case 1:
        assert.deepEqual(p, { timeout: 1, limit: 100 });
        return [
          200,
          [
            { update_id: 4, widget_query: { id: "q1", message_id: 7, data: "ping" } },
            { update_id: 5, something_else: true },
            { update_id: 6, widget_query: { id: "q2", message_id: 7, data: "fail" } },
            { update_id: 7, widget_query: { id: "q3", message_id: 7, data: "obj" } },
          ],
        ];
      case 2:
        assert.equal(p.offset, 8);
        return [500, "Internal Server Error"];
      default:
        return [409, "Conflict: can't use getUpdates method while webhook is active"];
    }
  });
  const errors: unknown[] = [];
  await assert.rejects(
    honk.poll(
      async (q) => {
        if (q.data === "fail") throw new Error("nope");
        if (q.data === "obj") return { ok: 1 };
        return `pong:${q.data}`;
      },
      { timeout: 1, onError: (e) => errors.push(e) },
    ),
    (e) => e instanceof HonkError && e.code === 409,
  );
  answers.sort((a, b) => String(a.widget_query_id).localeCompare(String(b.widget_query_id)));
  assert.deepEqual(answers, [
    { widget_query_id: "q1", data: "pong:ping" },
    { widget_query_id: "q3", data: '{"ok":1}' },
  ]);
  assert.equal(errors.length, 2); // the handler that threw and the failed poll
});

test("poll resolves when its signal aborts", async () => {
  const { honk } = await fake(async () => {
    await new Promise((r) => setTimeout(r, 50));
    return [200, []];
  });
  await honk.poll(() => "", { signal: AbortSignal.timeout(120) });
});

test("webhookHandler checks the secret and answers", async () => {
  const { g, honk } = await fake(() => [200, true]);
  const handle = honk.webhookHandler((q) => (q.data === "fail" ? Promise.reject(new Error("nope")) : { ok: 1 }), { secretToken: "s3cret" });
  const post = async (secret: string | null, body: string) => {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (secret !== null) headers[SECRET_HEADER] = secret;
    return (await handle(new Request("http://bot/hook", { method: "POST", headers, body }))).status;
  };
  const query = '{"update_id":1,"widget_query":{"id":"q1","message_id":3,"data":"x"}}';
  assert.equal(await post(null, query), 401);
  assert.equal(await post("wrong", query), 401);
  assert.equal(await post("s3cret", "{"), 400);
  assert.equal(await post("s3cret", query), 200);
  assert.deepEqual(g.last(), { method: "answerWidgetQuery", params: { widget_query_id: "q1", data: '{"ok":1}' } });
  assert.equal(await post("s3cret", '{"update_id":2,"widget_query":{"id":"q2","message_id":3,"data":"fail"}}'), 500);
  assert.equal(await post("s3cret", '{"update_id":3}'), 200);
  assert.equal((await handle(new Request("http://bot/hook"))).status, 405);
});

test("toNodeHandler serves the webhook on node:http", async () => {
  const { g, honk } = await fake(() => [200, true]);
  const server = createServer(toNodeHandler(honk.webhookHandler((q) => `got ${q.data}`, { secretToken: "s" })));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/hook`;
    const res = await fetch(url, {
      method: "POST",
      headers: { [SECRET_HEADER]: "s", "Content-Type": "application/json" },
      body: '{"update_id":1,"widget_query":{"id":"q9","message_id":3,"data":"x"}}',
    });
    assert.equal(res.status, 200);
    assert.deepEqual(g.last(), { method: "answerWidgetQuery", params: { widget_query_id: "q9", data: "got x" } });
    assert.equal((await fetch(url, { method: "POST", body: "{}" })).status, 401);
  } finally {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
});

test("fromEnv", () => {
  const honk = Honk.fromEnv({ HONK_URL: "https://h.example.com/", HONK_TOKEN: TOKEN, HONK_KEY: KEY });
  assert.equal(honk.url, "https://h.example.com");
  assert.equal(honk.botId, "Ab3dEf9h");
  assert.equal(honk.encrypted, true);
  assert.throws(() => Honk.fromEnv({}), /HONK_URL/);
  assert.throws(() => new Honk({ url: "x", token: TOKEN, key: "AAEC" }), /32 bytes/);
});

test("VERSION is package.json's version", () => {
  assert.equal(VERSION, JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version);
});

test("poll waits at least a whole second per poll and stops its handlers", async () => {
  const seen: unknown[] = [];
  let sent = false;
  const { honk } = await fake((method, p) => {
    if (method === "answerWidgetQuery") return [200, true];
    seen.push(p.timeout);
    if (sent) return [200, []];
    sent = true;
    return [200, [{ update_id: 1, widget_query: { id: "q1", message_id: 1, data: "slow" } }]];
  });
  const stop = new AbortController();
  let aborted = false;
  const polling = honk.poll(
    (_q, { signal }) =>
      new Promise<string>((resolve) => {
        signal.addEventListener("abort", () => {
          aborted = true;
          resolve("stopped");
        });
        setTimeout(() => stop.abort(), 20);
      }),
    { signal: stop.signal, timeout: 0 },
  );
  const start = Date.now();
  await polling;
  assert.ok(aborted);
  assert.ok(Date.now() - start < 2000);
  assert.deepEqual(seen.slice(0, 1), [1]);
  await honk.getUpdates({ timeout: 2.7 });
  assert.equal(seen[seen.length - 1], 2);
});

test("toNodeHandler reads the stream when a parser skipped it, and survives a broken body", async () => {
  const { g, honk } = await fake(() => [200, true]);
  const node = toNodeHandler(honk.webhookHandler(() => "ok"));
  const update = '{"update_id":1,"widget_query":{"id":"q7","message_id":3,"data":"x"}}';
  const res = () => {
    const r = { statusCode: 0, ended: false, writableEnded: false, setHeader() {}, end() { r.ended = true; r.writableEnded = true; } };
    return r;
  };
  async function* chunks(...parts: (string | Error)[]) {
    for (const p of parts) {
      if (p instanceof Error) throw p;
      yield new TextEncoder().encode(p);
    }
  }
  // Express with a parser that skipped this request: req.body = {}, stream unread.
  const skipped = Object.assign(chunks(update), { method: "POST", url: "/", headers: {}, body: {}, readableEnded: false });
  let r = res();
  await node(skipped, r);
  assert.equal(r.statusCode, 200);
  assert.deepEqual(g.last().params, { widget_query_id: "q7", data: "ok" });
  // express.raw(): a Buffer.
  const raw = Object.assign(chunks(), { method: "POST", url: "/", headers: {}, body: new TextEncoder().encode(update), readableEnded: true });
  r = res();
  await node(raw, r);
  assert.equal(r.statusCode, 200);
  // The client goes away mid-body: no rejection, a 400.
  const broken = Object.assign(chunks('{"update', new Error("aborted")), { method: "POST", url: "/", headers: {} });
  r = res();
  await node(broken, r);
  assert.equal(r.statusCode, 400);
  assert.ok(r.ended);
});
