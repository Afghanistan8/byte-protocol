/**
 * A Node server for the console.
 *
 * Serves the UI at `/` and the owner-only API under `/api`. Binds to loopback by default:
 * this surface reports everything Byte keeps off the chain, and a bind address is not an
 * authorisation boundary but it is a sensible first wall.
 */

import { createServer, type Server } from "node:http";
import { createConsoleApi, type ConsoleApiOptions } from "./api.js";
import { consoleHtml } from "./ui.js";

export interface ConsoleServerOptions extends ConsoleApiOptions {
  /** Defaults to 127.0.0.1. */
  host?: string;
  /** Defaults to 0, meaning any free port. */
  port?: number;
}

export interface RunningConsole {
  server: Server;
  url: string;
  close: () => Promise<void>;
}

export async function startConsole(options: ConsoleServerOptions): Promise<RunningConsole> {
  const handle = createConsoleApi(options);
  const html = consoleHtml({ apiBase: "/api" });

  const server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", "http://localhost");

      if (url.pathname === "/" || url.pathname === "/index.html") {
        res.writeHead(200, {
          "content-type": "text/html; charset=utf-8",
          // The console holds owner-only data; it should not sit in a shared cache.
          "cache-control": "no-store",
          // It loads nothing from anywhere else, so say so.
          "content-security-policy":
            "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:",
          "referrer-policy": "no-referrer",
          "x-content-type-options": "nosniff",
        });
        res.end(html);
        return;
      }

      if (url.pathname.startsWith("/api")) {
        const query: Record<string, string> = {};
        url.searchParams.forEach((value, key) => {
          query[key] = value;
        });

        const result = await handle({
          method: req.method ?? "GET",
          path: url.pathname.slice("/api".length) || "/",
          query,
          header: (name) => (req.headers[name.toLowerCase()] as string | undefined) ?? null,
        });

        res.writeHead(result.status, {
          "content-type": "application/json",
          "cache-control": "no-store",
        });
        res.end(JSON.stringify(result.body));
        return;
      }

      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not_found" }));
    })().catch((error: unknown) => {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          error: "internal",
          message: error instanceof Error ? error.message : String(error),
        }),
      );
    });
  });

  const host = options.host ?? "127.0.0.1";
  await new Promise<void>((resolve) => server.listen(options.port ?? 0, host, resolve));

  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("console server has no address");
  }

  return {
    server,
    url: `http://${host}:${address.port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
