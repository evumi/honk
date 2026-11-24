// Runs the SDK against a real gateway. Start one with HONK_RELAY_URL=off (and
// HONK_REGISTER_KEY unset) and point HONK_E2E_GATEWAY at it. The test registers
// a simulator device (which gets no pushes), plays the app's part through the
// App API and sends as a bot through the SDK.

import assert from "node:assert/strict";
import { test } from "node:test";
import { Honk, HonkError, open } from "../src/index.ts";

const base = process.env.HONK_E2E_GATEWAY?.replace(/\/+$/, "");

async function app(method: string, path: string, secret: string, body?: unknown): Promise<any> {
  const res = await fetch(base + path, {
    method,
    headers: { "Content-Type": "application/json", ...(secret && { Authorization: `Bearer ${secret}` }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const env = await res.json();
  assert.ok(env.ok, `${method} ${path}: ${res.status} ${env.description}`);
  return env.result;
}

test("against a gateway", { skip: !base && "HONK_E2E_GATEWAY is not set" }, async () => {
  const token = `simulator-${crypto.randomUUID()}`;
  const { device_secret: secret } = await app("POST", "/v1/devices", "", { platform: "ios", push_token: token, name: "sdk e2e" });
  try {
    const created = await app("POST", "/v1/bots", secret, { name: "SDK e2e (TS)" });
    let honk = new Honk({ url: base!, token: created.token });

    const bot = await honk.me();
    assert.equal(bot.id, created.bot.id);
    assert.equal(bot.name, "SDK e2e (TS)");

    const rep = await honk.dryRun({ body: "x", html: '<b onclick="x()">{{s}}</b>' });
    assert.equal(rep.html, "<b>{{s}}</b>");
    assert.equal(rep.removed?.length, 1);

    const sent = await honk.send({ title: "t", body: "b", html: "<b>{{s}}</b>", data: { s: "1" }, id: "e2e", level: "passive" });
    assert.ok(sent.messageId > 0);
    assert.equal(sent.id, "e2e");
    assert.equal(sent.level, "passive");
    await honk.edit({ id: "e2e" }, { s: "2" });
    await honk.delete({ messageId: sent.messageId });
    await assert.rejects(honk.send({}), (e) => e instanceof HonkError && e.code === 400);

    // Widget queries through getUpdates.
    const card = await honk.send({ body: "card", html: "<button>go</button>", allowQueries: true });
    const stop = new AbortController();
    const polling = honk.poll(
      (q) => {
        assert.equal(q.messageId, card.messageId);
        return `pong:${q.data}`;
      },
      { signal: stop.signal, timeout: 5 },
    );
    const answer = await app("POST", "/v1/queries", secret, { message_id: card.messageId, data: "ping" });
    assert.equal(answer.data, "pong:ping");
    stop.abort();
    await polling;

    // End-to-end encryption: the app turns it on, plaintext is refused, the
    // device opens what the SDK sealed.
    await app("PATCH", `/v1/bots/${bot.id}`, secret, { encrypted: true });
    await assert.rejects(honk.send("plain"), (e) => e instanceof HonkError && e.code === 400);
    const key = crypto.getRandomValues(new Uint8Array(32));
    honk = new Honk({ url: base!, token: created.token, key });
    const sealed = await honk.send({ title: "secret", body: "sealed", data: '{"n":1}', id: "e2e-sealed" });
    const stored = await app("GET", `/v1/messages/${sealed.messageId}`, secret);
    assert.equal(stored.body, undefined);
    assert.equal(stored.id, "e2e-sealed");
    assert.deepEqual(JSON.parse(await open(key, bot.id, stored.ciphertext)), { title: "secret", body: "sealed", data: '{"n":1}' });
    await honk.edit({ id: "e2e-sealed" }, { n: 2 });

    await app("DELETE", `/v1/bots/${bot.id}`, secret);
    await assert.rejects(honk.me(), (e) => e instanceof HonkError && (e.code === 401 || e.code === 404));
  } finally {
    await app("DELETE", "/v1/devices/me", secret);
  }
});
