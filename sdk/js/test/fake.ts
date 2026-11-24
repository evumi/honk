// A fake gateway: answers /bot<token>/<method> with a function and records the calls.

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export const TOKEN = "Ab3dEf9h:secret";

export interface Call {
  method: string;
  params: Record<string, unknown>;
}

export type Reply = (method: string, params: Record<string, unknown>) => [number, unknown] | Promise<[number, unknown]>;

export class FakeGateway {
  readonly calls: Call[] = [];
  reply: Reply;
  #server: Server;
  url = "";

  constructor(reply: Reply) {
    this.reply = reply;
    this.#server = createServer(async (req, res) => {
      const prefix = `/bot${TOKEN}/`;
      let body = "";
      for await (const chunk of req) body += chunk;
      if (!req.url?.startsWith(prefix) || req.method !== "POST" || req.headers["content-type"] !== "application/json") {
        res.statusCode = 404;
        res.end(JSON.stringify({ ok: false, error_code: 404, description: "Not Found" }));
        return;
      }
      const method = req.url.slice(prefix.length);
      const params = JSON.parse(body);
      this.calls.push({ method, params });
      const [status, result] = await this.reply(method, params);
      res.statusCode = status;
      res.end(
        JSON.stringify(status === 200 ? { ok: true, result } : { ok: false, error_code: status, description: result }),
      );
    });
  }

  async start(): Promise<this> {
    await new Promise<void>((resolve) => this.#server.listen(0, "127.0.0.1", resolve));
    this.url = `http://127.0.0.1:${(this.#server.address() as AddressInfo).port}/`;
    return this;
  }

  last(): Call {
    return this.calls[this.calls.length - 1];
  }

  close(): Promise<void> {
    this.#server.closeAllConnections();
    return new Promise((resolve) => this.#server.close(() => resolve()));
  }
}
