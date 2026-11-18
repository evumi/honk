import { expect, test } from "nsh/test";
import contract from "./host.contract.json";
import { demo } from "./demo";
import { api, cards, listenIncoming, spy } from "./host";

// host.contract.json is the contract with the native hosts. Here: host.ts calls
// exactly the names and argument shapes it lists, and demo.ts answers in its
// result shapes. HonkKit's HostContractTests and :core's HostContractTest check
// the native side against the same file.

type Sample = { args?: unknown; result?: unknown };
type Spec = { optional?: string[]; demo?: boolean; samples: Sample[] };
const calls = contract.calls as unknown as Record<string, Spec>;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Why `v` does not have the shape of `sample` (null: it does). Keys in `optional` may be absent. */
function mismatch(v: unknown, sample: unknown, optional: Set<string>, path: string): string | null {
  if (v === undefined) v = null;
  if (sample === null) return v === null ? null : `${path}: expected null`;
  if (v === null) return `${path}: unexpected null`;
  if (Array.isArray(sample)) {
    if (!Array.isArray(v)) return `${path}: expected an array`;
    if (sample.length === 0) return null;
    for (const [i, item] of v.entries()) {
      const errors = sample.map((s) => mismatch(item, s, optional, `${path}[${i}]`));
      if (!errors.some((e) => e === null)) return errors[0];
    }
    return null;
  }
  if (isObject(sample)) {
    if (!isObject(v)) return `${path}: expected an object`;
    for (const k of Object.keys(v)) {
      if (v[k] === undefined) continue;
      if (!(k in sample)) return `${path}.${k}: not in the contract`;
      const e = mismatch(v[k], sample[k], optional, `${path}.${k}`);
      if (e) return e;
    }
    for (const k of Object.keys(sample)) if (!(k in v) && !optional.has(k)) return `${path}.${k}: missing`;
    return null;
  }
  return typeof v === typeof sample ? null : `${path}: expected ${typeof sample}, got ${typeof v}`;
}

function conformsToAny(v: unknown, samples: unknown[], optional: string[] | undefined, what: string) {
  const errors = samples.map((s) => mismatch(v, s, new Set(optional ?? []), what));
  expect(errors.some((e) => e === null) ? "ok" : errors.join(" | ")).toBe("ok");
}

test("the contract lists samples for every call", () => {
  for (const [name, spec] of Object.entries(calls)) {
    expect(name.startsWith("honk.")).toBe(true);
    expect(spec.samples.length > 0).toBe(true);
  }
});

// Runs before the test below: the demo is one in-memory store, and that test's calls change it.
test("demo.ts answers in the contract's result shapes", async () => {
  for (const [name, spec] of Object.entries(calls)) {
    if (spec.demo === false) continue;
    for (const s of spec.samples) {
      // The demo's own bot stands in for the sample's.
      const args = JSON.parse(JSON.stringify(s.args ?? null).replaceAll("aZ3kQ9xT", "Bx7kQ2mT"));
      const result = await demo(name, args);
      conformsToAny(result, spec.samples.map((x) => x.result), spec.optional, `${name} result`);
    }
  }
});

test("host.ts makes exactly the calls the contract lists, with their arguments", async () => {
  const seen: { name: string; args: unknown }[] = [];
  spy.call = (name, args) => seen.push({ name, args: args === null ? null : JSON.parse(JSON.stringify(args)) });
  const invocations: (() => Promise<unknown>)[] = [
    () => api.status(),
    () => api.chats(),
    () => api.messages("aZ3kQ9xT", 8),
    () => api.messages("aZ3kQ9xT"),
    () => api.markRead("aZ3kQ9xT"),
    () => api.focus("aZ3kQ9xT"),
    () => api.focus(null),
    () => api.refresh(),
    () => api.createBot("n", "preset:box:#1c1c1e", "active"),
    () => api.updateBot("aZ3kQ9xT", { name: "x" }),
    () => api.updateBot("aZ3kQ9xT", { name: "x", avatar: "a", defaultLevel: "passive" }),
    () => api.token("aZ3kQ9xT"),
    () => api.resetToken("aZ3kQ9xT"),
    () => api.deleteBot("aZ3kQ9xT"),
    () => api.setMuted("aZ3kQ9xT", true),
    () => api.setPinned("aZ3kQ9xT", true),
    () => api.deleteMessage(7),
    () => api.clearChat("aZ3kQ9xT"),
    () => api.deleteDevice(),
    () => api.openNotificationSettings(),
    () => api.retryRegistration(),
    () => api.gateway(),
    () => api.testGateway("gw.test"),
    () => api.setGateway("https://gw.test/"),
    () => api.setGateway(null),
    () => api.saveAvatar("iVBORw0KGgo=", "image/png"),
    () => api.avatarImage("local:a1b2c3d4.png"),
    () => cards.open("c1", "{}"),
    () => cards.click("c1", "0"),
    () => cards.set("c1", "{}"),
    () => cards.close("c1"),
    () => listenIncoming(),
  ];
  try {
    for (const run of invocations) await run().catch(() => {});
  } finally {
    spy.call = undefined;
  }
  expect([...new Set(seen.map((s) => s.name))].sort()).toEqual(Object.keys(calls).sort());
  for (const { name, args } of seen) {
    const spec = calls[name];
    conformsToAny(args, spec.samples.map((s) => s.args ?? null), spec.optional, `${name} args`);
  }
});

test("the events the host sends have samples", () => {
  expect(Object.keys(contract.events).sort()).toEqual(["honk.card.changed", "honk.changed", "honk.incoming", "honk.open"]);
  const incoming = contract.events["honk.incoming"].samples[0] as { botId: string; messageId: number };
  expect(typeof incoming.botId).toBe("string");
  expect(typeof incoming.messageId).toBe("number");
});
