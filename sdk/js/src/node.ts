// An adapter from a fetch-style handler (Request in, Response out) to a
// node:http one, so webhookHandler also serves node:http, Express, Koa's
// req/res and the like. It uses only the shapes it needs, not @types/node.

/** The parts of node:http's IncomingMessage the adapter reads. */
export interface NodeRequest extends AsyncIterable<unknown> {
  method?: string;
  url?: string;
  headers: Record<string, string | string[] | undefined>;
  /** A body a framework has already parsed (Express's express.json(), express.raw()). */
  body?: unknown;
  /** True once the body stream has been read, by a framework or by us. */
  readableEnded?: boolean;
}

/** The parts of node:http's ServerResponse the adapter writes. */
export interface NodeResponse {
  statusCode: number;
  setHeader(name: string, value: string): unknown;
  end(body?: string): unknown;
  writableEnded?: boolean;
  headersSent?: boolean;
  once?(event: "close", listener: () => void): unknown;
}

const hopHeaders = new Set(["content-length", "transfer-encoding", "connection", "keep-alive"]);

export type NodeHandler = (req: NodeRequest, res: NodeResponse) => Promise<void>;

/**
 * Wraps a fetch-style handler for node:http. The returned function never
 * rejects: a body that cannot be read, or a handler that throws, ends the
 * response with 400 or 500.
 *
 *     http.createServer(toNodeHandler(honk.webhookHandler(answer))).listen(8443)
 *     app.post("/honk", toNodeHandler(honk.webhookHandler(answer)))   // Express
 */
export function toNodeHandler(handler: (request: Request) => Promise<Response>): NodeHandler {
  return async (req, res) => {
    try {
      await serve(handler, req, res);
    } catch {
      if (res.writableEnded) return;
      if (!res.headersSent) res.statusCode = 500;
      try {
        res.end();
      } catch {
        // the connection is gone
      }
    }
  };
}

async function serve(handler: (request: Request) => Promise<Response>, req: NodeRequest, res: NodeResponse): Promise<void> {
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    // The body is handed over whole, so its framing headers no longer apply.
    if (v !== undefined && !hopHeaders.has(k.toLowerCase())) headers.set(k, Array.isArray(v) ? v.join(", ") : v);
  }
  const method = req.method ?? "GET";
  let body: string | undefined;
  if (method !== "GET" && method !== "HEAD") {
    let read: string | number;
    try {
      read = await readBody(req);
    } catch {
      read = 400; // the client went away mid-body, or sent something unreadable
    }
    if (typeof read === "number") {
      res.statusCode = read;
      res.end();
      return;
    }
    body = read;
  }
  const abort = new AbortController();
  // The client went away before we answered (req's own "close" fires once its body is read).
  res.once?.("close", () => {
    if (!res.writableEnded) abort.abort();
  });
  const response = await handler(
    new Request(new URL(req.url ?? "/", "http://localhost"), { method, headers, body, signal: abort.signal }),
  );
  res.statusCode = response.status;
  response.headers.forEach((v, k) => res.setHeader(k, v));
  res.end(await response.text());
}

/** The body as text, or 413 when it is over 64 KB. */
async function readBody(req: NodeRequest): Promise<string | number> {
  // A body parser that ran has consumed the stream and left req.body; one that
  // skipped this request has not (Express sets req.body = {} all the same).
  if (req.body !== undefined && req.readableEnded !== false) {
    const b = req.body;
    if (typeof b === "string") return b;
    if (b instanceof Uint8Array) return new TextDecoder().decode(b);
    return JSON.stringify(b);
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of req) {
    const c = typeof chunk === "string" ? new TextEncoder().encode(chunk) : (chunk as Uint8Array);
    size += c.length;
    if (size > 64 << 10) return 413;
    chunks.push(c);
  }
  const all = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    all.set(c, at);
    at += c.length;
  }
  return new TextDecoder().decode(all);
}
