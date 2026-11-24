import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { open, parseKey, seal } from "../src/index.ts";

// app/src/e2e.vector.json: the vector every Honk client checks.
const vector = JSON.parse(readFileSync(new URL("../../../app/src/e2e.vector.json", import.meta.url), "utf8"));

test("opens the shared vector and round-trips", async () => {
  const key = parseKey(vector.key);
  assert.equal(await open(key, vector.aad, vector.ciphertext), vector.plaintext);
  const sealed = await seal(key, vector.aad, vector.plaintext);
  assert.match(sealed, /^[A-Za-z0-9_-]+$/);
  assert.equal(await open(key, vector.aad, sealed), vector.plaintext);
  await assert.rejects(open(key, "other", sealed));
});

test("parseKey takes base64 and base64url, padded or not", () => {
  const std = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=";
  for (const s of [std, std.replace(/=$/, ""), ` ${std}\n`, vector.key]) {
    const k = parseKey(s);
    assert.equal(k.length, 32);
    assert.equal(k[31], 0x1f);
  }
  const url = parseKey("-_" + "A".repeat(41));
  assert.equal(url[0], 0xfb);
  for (const s of ["", "AAEC", "not base64!"]) assert.throws(() => parseKey(s));
});
