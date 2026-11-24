// @evumi/honk: the TypeScript SDK for the Honk Bot API.

import { parseKey, seal } from "./crypto.ts";

export { open, parseKey, seal } from "./crypto.ts";
export { toNodeHandler } from "./node.ts";
export type { NodeHandler, NodeRequest, NodeResponse } from "./node.ts";

export const VERSION = "0.1.0";

/** How long the gateway holds a card's request() for the bot's answer, in ms. */
export const QUERY_TIMEOUT = 15_000;

/** The header that carries setWebhook's secret token on every delivery. */
export const SECRET_HEADER = "X-Honk-Bot-Api-Secret-Token";

/** How a message interrupts. */
export type Level = "passive" | "active" | "timeSensitive";

/** JSON text, or a value that is sent as JSON. */
export type Data = string | Record<string, unknown> | unknown[];

/** What {@link Honk.send} sends. See the Bot API's sendMessage for the limits. */
export interface Message {
  /** Required unless the client has a key: the banner text and the fallback for clients without cards. */
  body?: string;
  title?: string;
  /** A card: whitelisted HTML and CSS, inline scripts allowed. */
  html?: string;
  /** Fills the card's {{key}} placeholders and is its chatData (at most 1 KB). */
  data?: Data;
  /** A link; with `open: "url"` tapping the notification opens it. */
  url?: string;
  /** Text behind the notification's Copy button. */
  copy?: string;
  /** https URL of the sender icon. */
  icon?: string;
  /** https URL of an image attached to the notification. */
  image?: string;

  // The fields below stay readable to the gateway even with a key.
  /** passive, active (the bot's default when left out) or timeSensitive. */
  level?: Level;
  /** Thread notifications by this name. */
  group?: string;
  /** Collapse id: a later message with the same id replaces this one. */
  id?: string;
  open?: "chat" | "url";
  parseMode?: "Markdown";
  /** Seconds it stays queued, at least 60. */
  ttl?: number;
  /** No banner; it still reaches the chat and the badge. */
  silent?: boolean;
  /** The card's request() reaches this bot (see {@link Honk.poll} and {@link Honk.webhookHandler}). */
  allowQueries?: boolean;
}

/** The message as the gateway queued it. */
export interface SentMessage {
  messageId: number;
  botId: string;
  kind: string;
  id?: string;
  level?: Level;
  group?: string;
  title?: string;
  body?: string;
  ciphertext?: string;
  allowQueries?: boolean;
  /** When the gateway took it, in Unix milliseconds. */
  date: number;
}

/**
 * What {@link Honk.dryRun} returns: the card as the gateway's whitelist leaves
 * it, its sizes (limits 32768 raw, 4096 compressed) and what was removed. For
 * an encrypted message only `level` and `ciphertextSize` are set.
 */
export interface DryRunReport {
  level: Level;
  html?: string;
  inputSize?: number;
  rawSize?: number;
  compressedSize?: number;
  removed?: string[];
  ciphertextSize?: number;
}

/** The bot behind the token. */
export interface Bot {
  id: string;
  name: string;
  avatar: string;
  defaultLevel: Level;
  encrypted: boolean;
  createdAt: number;
  updatedAt: number;
}

/** A message to edit or delete: by its collapse id or the gateway's message id. */
export type Target = { id: string } | { messageId: number };

/** What a card's request(data) sends. */
export interface WidgetQuery {
  /** Answered with {@link Honk.answerWidgetQuery}. */
  id: string;
  /** The message the card belongs to. */
  messageId: number;
  /** The 1–64 bytes the card passed. */
  data: string;
}

/** One item from getUpdates or a webhook delivery. */
export interface Update {
  updateId: number;
  /** Missing for kinds of update this SDK does not know yet. */
  widgetQuery?: WidgetQuery;
}

export interface WebhookInfo {
  url: string;
  hasCustomCertificate: boolean;
  pendingUpdateCount: number;
}

/**
 * Answers a widget query. What it returns is what the card's request()
 * resolves with: a string as written, another value as JSON, nothing as "".
 * At most 1024 bytes. Throwing leaves the query unanswered.
 */
export type QueryHandler = (query: WidgetQuery, ctx: { signal: AbortSignal }) => unknown;

export interface HonkOptions {
  /** The gateway's base URL, e.g. https://honk.example.com. */
  url: string;
  /** The bot token, `<bot id>:<secret>`. */
  token: string;
  /**
   * The bot's end-to-end key (base64 text as the app shows it, or 32 bytes).
   * When set, message content is sent as ciphertext; required once the bot
   * has end-to-end encryption turned on.
   */
  key?: string | Uint8Array;
  /** Bounds each call that is not a long poll, in ms. Default 30 000. */
  timeout?: number;
  /** How many times a call refused with 429 is tried again (after 1 s, 2 s, 4 s, … up to 30 s). Default 0. */
  retries?: number;
  /** The fetch to use; default the global one. */
  fetch?: typeof fetch;
}

/** A failure the gateway reported: `code` is its error_code (the HTTP status). */
export class HonkError extends Error {
  readonly code: number;
  readonly description: string;
  constructor(code: number, description: string) {
    super(`${description} (${code})`);
    this.name = "HonkError";
    this.code = code;
    this.description = description;
  }
}

export interface PollOptions {
  /** Stops polling; poll() then resolves once running handlers are done. */
  signal?: AbortSignal;
  /** Each long poll's wait in whole seconds, 1–50. Default 30. */
  timeout?: number;
  /** Hears about failures poll() gets over: a failed poll (retried after 1 s, 2 s, … 30 s), a handler that threw, a failed answer. */
  onError?: (error: unknown) => void;
}

export interface WebhookOptions {
  /** The secret given to setWebhook; deliveries without it are refused with 401. */
  secretToken?: string;
  /** Hears about handlers that threw and answers that failed. */
  onError?: (error: unknown) => void;
}

type Params = Record<string, string | number | boolean>;

interface CallOptions {
  signal?: AbortSignal;
  /** How long the gateway may hold the request on purpose (a long poll), in ms. */
  wait?: number;
}

/** A client for one bot. */
export class Honk {
  readonly url: string;
  readonly token: string;
  readonly #timeout: number;
  readonly #retries: number;
  readonly #fetch: typeof fetch;
  readonly #key?: Uint8Array;
  #cryptoKey?: Promise<CryptoKey>;

  constructor(options: HonkOptions) {
    if (!options.url || !options.token) throw new Error("honk: url and token are required");
    this.url = options.url.replace(/\/+$/, "");
    this.token = options.token;
    this.#timeout = options.timeout ?? 30_000;
    this.#retries = options.retries ?? 0;
    this.#fetch = options.fetch ?? ((input, init) => fetch(input, init));
    if (options.key !== undefined) {
      this.#key = typeof options.key === "string" ? parseKey(options.key) : options.key;
      if (this.#key.length !== 32) throw new Error(`honk: key must be 32 bytes, got ${this.#key.length}`);
    }
  }

  /** Makes a client from HONK_URL, HONK_TOKEN and the optional HONK_KEY (default: process.env). */
  static fromEnv(env?: Record<string, string | undefined>): Honk {
    const e = env ?? (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {};
    if (!e.HONK_URL || !e.HONK_TOKEN) throw new Error("honk: HONK_URL and HONK_TOKEN must be set");
    return new Honk({ url: e.HONK_URL, token: e.HONK_TOKEN, key: e.HONK_KEY || undefined });
  }

  /** The bot's short id, the part of the token before the colon. */
  get botId(): string {
    return this.token.split(":")[0];
  }

  /** Whether message content is sealed before it leaves. */
  get encrypted(): boolean {
    return this.#key !== undefined;
  }

  // ---- messages ----

  /** Queues a message and pushes it to the bot owner's devices. A string is the body. */
  async send(message: Message | string): Promise<SentMessage> {
    const m = typeof message === "string" ? { body: message } : message;
    return sentMessage(await this.call("sendMessage", await this.#sendParams(m)));
  }

  /** Has the gateway check a message without queueing or pushing it. Counts against the rate limit. */
  async dryRun(message: Message | string): Promise<DryRunReport> {
    const m = typeof message === "string" ? { body: message } : message;
    const r = (await this.call("sendMessage", { ...(await this.#sendParams(m)), dry_run: true })) as Record<string, any>;
    return {
      level: r.level,
      html: r.html,
      inputSize: r.input_size,
      rawSize: r.raw_size,
      compressedSize: r.compressed_size,
      removed: r.removed,
      ciphertextSize: r.ciphertext_size,
    };
  }

  /** Replaces a sent message's card data, silently. With a key the data is sealed. */
  async edit(target: Target, data: Data): Promise<void> {
    const p = targetParams(target);
    const d = dataText(data);
    if (this.#key) p.ciphertext = await this.#seal({ data: d });
    else p.data = d;
    await this.call("editMessageData", p);
  }

  /** Removes a message and its notification. */
  async delete(target: Target): Promise<void> {
    await this.call("deleteMessage", targetParams(target));
  }

  /** The bot behind the token. */
  async me(): Promise<Bot> {
    const b = (await this.call("getMe", {})) as Record<string, any>;
    return {
      id: b.id,
      name: b.name,
      avatar: b.avatar,
      defaultLevel: b.default_level,
      encrypted: b.encrypted,
      createdAt: b.created_at,
      updatedAt: b.updated_at,
    };
  }

  // ---- widget queries ----

  /**
   * Long-polls for updates with an id of at least `offset`, waiting up to
   * `timeout` seconds (0–50) when there are none. Refused with 409 while a
   * webhook is set. {@link poll} is the loop around it.
   */
  async getUpdates(options: { offset?: number; limit?: number; timeout?: number; signal?: AbortSignal } = {}): Promise<Update[]> {
    const timeout = Math.min(Math.max(Math.floor(options.timeout ?? 0), 0), 50);
    const p: Params = { timeout };
    if (options.offset) p.offset = options.offset;
    if (options.limit) p.limit = options.limit;
    const r = (await this.call("getUpdates", p, { signal: options.signal, wait: timeout * 1000 })) as any[];
    return r.map((u) => ({
      updateId: u.update_id,
      ...(u.widget_query && {
        widgetQuery: { id: u.widget_query.id, messageId: u.widget_query.message_id, data: u.widget_query.data },
      }),
    }));
  }

  /** Answers a widget query with data (0–1024 bytes), within 15 s of the card's request. */
  async answerWidgetQuery(id: string, data: string): Promise<void> {
    await this.call("answerWidgetQuery", { widget_query_id: id, data });
  }

  /**
   * Has the gateway POST updates to `url` (https, on a public address) instead
   * of keeping them for getUpdates. An empty url removes the webhook.
   */
  async setWebhook(url: string, options: { secretToken?: string } = {}): Promise<void> {
    const p: Params = { url };
    if (options.secretToken) p.secret_token = options.secretToken;
    await this.call("setWebhook", p);
  }

  /** Removes the webhook, so getUpdates works again. */
  async deleteWebhook(): Promise<void> {
    await this.call("deleteWebhook", {});
  }

  async getWebhookInfo(): Promise<WebhookInfo> {
    const r = (await this.call("getWebhookInfo", {})) as Record<string, any>;
    return { url: r.url, hasCustomCertificate: r.has_custom_certificate, pendingUpdateCount: r.pending_update_count };
  }

  /**
   * Receives updates with getUpdates and runs `handler` for every widget
   * query, concurrently, answering with what it returns. Runs until
   * `options.signal` aborts (then resolves once running handlers are done) or
   * the gateway refuses the polling itself: 401 or 404 (a wrong token) and 409
   * (a webhook is set) reject. Aborting also aborts the running handlers' signals;
   * what they still return is answered. When the handler throws, the query stays
   * unanswered and the card's request() rejects with TIMEOUT after 15 s.
   */
  async poll(handler: QueryHandler, options: PollOptions = {}): Promise<void> {
    const { signal } = options;
    // At least 1 s: a zero wait would have the loop ask again at once, over and over.
    const timeout = Math.min(Math.max(Math.floor(options.timeout ?? 30), 1), 50);
    const report = (e: unknown) => options.onError?.(e);
    const running = new Set<Promise<void>>();
    let offset = 0;
    let backoff = 0;
    try {
      while (!signal?.aborted) {
        let updates: Update[];
        try {
          updates = await this.getUpdates({ offset, limit: 100, timeout, signal });
        } catch (e) {
          if (signal?.aborted) break;
          if (e instanceof HonkError && (e.code === 401 || e.code === 404 || e.code === 409)) throw e;
          report(e);
          backoff = Math.min(Math.max(backoff * 2, 1000), 30_000);
          await sleep(backoff, signal);
          continue;
        }
        backoff = 0;
        for (const u of updates) {
          offset = Math.max(offset, u.updateId + 1);
          if (!u.widgetQuery) continue;
          const job = this.#handle(handler, u.widgetQuery, signal).catch(report);
          running.add(job);
          void job.finally(() => running.delete(job));
        }
      }
    } finally {
      await Promise.allSettled(running);
    }
  }

  /**
   * A fetch-style handler for the URL given to setWebhook (Bun, Deno,
   * Workers, Next.js route handlers; {@link toNodeHandler} for node:http and
   * Express). It checks the secret, runs `handler` for a widget query and
   * answers it before replying 200. The gateway waits 5 s for the delivery,
   * so the handler should be quick. When it throws or the answer fails the
   * reply is 500, and the gateway fails the card's request() at once
   * (REQUEST_FAILED) instead of letting it time out.
   */
  webhookHandler(handler: QueryHandler, options: WebhookOptions = {}): (request: Request) => Promise<Response> {
    return async (request) => {
      if (request.method !== "POST") return new Response("method not allowed", { status: 405, headers: { Allow: "POST" } });
      if (options.secretToken && !sameText(request.headers.get(SECRET_HEADER) ?? "", options.secretToken)) {
        return new Response("unauthorized", { status: 401 });
      }
      let u: any;
      try {
        u = await request.json();
      } catch {
        return new Response("bad update", { status: 400 });
      }
      const q = u?.widget_query;
      if (q && typeof q === "object") {
        try {
          await this.#handle(handler, { id: q.id, messageId: q.message_id, data: q.data }, request.signal);
        } catch (e) {
          options.onError?.(e);
          return new Response("query failed", { status: 500 });
        }
      }
      return new Response(null, { status: 200 });
    };
  }

  async #handle(handler: QueryHandler, q: WidgetQuery, signal?: AbortSignal): Promise<void> {
    const limit = deadline(QUERY_TIMEOUT, signal);
    let result: unknown;
    try {
      result = await handler(q, { signal: limit.signal });
    } finally {
      limit.clear();
    }
    const data = result === undefined || result === null ? "" : typeof result === "string" ? result : JSON.stringify(result);
    await this.answerWidgetQuery(q.id, data);
  }

  // ---- plumbing ----

  /**
   * Calls a Bot API method by name with its parameters as the API spells them
   * and returns the raw `result`. For methods this SDK has no wrapper for.
   */
  async call(method: string, params: Params, options: CallOptions = {}): Promise<unknown> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.#post(method, params, options);
      } catch (e) {
        if (!(e instanceof HonkError) || e.code !== 429 || attempt >= this.#retries) throw e;
        await sleep(Math.min(1000 * 2 ** attempt, 30_000), options.signal);
        if (options.signal?.aborted) throw e;
      }
    }
  }

  async #post(method: string, params: Params, options: CallOptions): Promise<unknown> {
    const limit = deadline(this.#timeout + (options.wait ?? 0), options.signal);
    let res: Response;
    let text: string;
    try {
      res = await this.#fetch(`${this.url}/bot${this.token}/${method}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(params),
        signal: limit.signal,
      });
      text = await res.text();
    } catch (e) {
      // The URL holds the token: say what failed without it.
      const why = e instanceof Error ? (e.name === "AbortError" || e.name === "TimeoutError" ? e.name : e.message) : String(e);
      throw new Error(`honk: ${method}: request failed: ${why}`, { cause: e });
    } finally {
      limit.clear();
    }
    let env: { ok?: boolean; result?: unknown; error_code?: number; description?: string };
    try {
      env = JSON.parse(text);
    } catch {
      throw new Error(`honk: ${method}: not a Honk gateway answer (HTTP ${res.status})`);
    }
    if (!env.ok) throw new HonkError(env.error_code || res.status, env.description ?? `HTTP ${res.status}`);
    return env.result;
  }

  async #sendParams(m: Message): Promise<Params> {
    const p: Params = {};
    const content: Record<string, string> = {};
    for (const k of ["title", "body", "html", "url", "copy", "icon", "image"] as const) {
      if (m[k]) content[k] = m[k];
    }
    if (m.data !== undefined) {
      const d = dataText(m.data);
      if (d) content.data = d;
    }
    if (this.#key) p.ciphertext = await this.#seal(content);
    else Object.assign(p, content);
    if (m.level) p.level = m.level;
    if (m.group) p.group = m.group;
    if (m.id) p.id = m.id;
    if (m.open) p.open = m.open;
    if (m.parseMode) p.parse_mode = m.parseMode;
    if (m.ttl !== undefined) p.ttl = Math.floor(m.ttl);
    if (m.silent) p.silent = true;
    if (m.allowQueries) p.allow_queries = true;
    return p;
  }

  #seal(content: Record<string, string>): Promise<string> {
    this.#cryptoKey ??= crypto.subtle.importKey("raw", this.#key as Uint8Array<ArrayBuffer>, "AES-GCM", false, ["encrypt"]);
    return this.#cryptoKey.then((k) => seal(k, this.botId, JSON.stringify(content)));
  }
}

function sentMessage(r: unknown): SentMessage {
  const m = r as Record<string, any>;
  const out: SentMessage = { messageId: m.message_id, botId: m.bot_id, kind: m.kind, date: m.date };
  if (m.id) out.id = m.id;
  if (m.level) out.level = m.level;
  if (m.group) out.group = m.group;
  if (m.title) out.title = m.title;
  if (m.body) out.body = m.body;
  if (m.ciphertext) out.ciphertext = m.ciphertext;
  if (m.allow_queries) out.allowQueries = true;
  return out;
}

function targetParams(t: Target): Params {
  if ("id" in t && t.id) return { id: t.id };
  if ("messageId" in t && t.messageId > 0) return { message_id: t.messageId };
  throw new Error("honk: a target needs id or messageId");
}

function dataText(d: Data): string {
  return typeof d === "string" ? d : JSON.stringify(d);
}

/** An AbortSignal that fires after ms or when parent aborts; clear() frees the timer. */
function deadline(ms: number, parent?: AbortSignal): { signal: AbortSignal; clear: () => void } {
  const c = new AbortController();
  const timer = setTimeout(() => c.abort(new DOMException("timed out", "TimeoutError")), ms);
  const onAbort = () => c.abort(parent?.reason);
  if (parent?.aborted) onAbort();
  else parent?.addEventListener("abort", onAbort, { once: true });
  return {
    signal: c.signal,
    clear: () => {
      clearTimeout(timer);
      parent?.removeEventListener("abort", onAbort);
    },
  };
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
  });
}

/** Compares two strings in time that does not depend on where they differ. */
function sameText(a: string, b: string): boolean {
  const x = new TextEncoder().encode(a);
  const y = new TextEncoder().encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}
