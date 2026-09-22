import { randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fccHome, serverInfoPath } from "../paths.ts";
import { listTasks, readGraph } from "../tasks.ts";
import { readServerInfo, type ServerInfo } from "./launcher.ts";

const DEFAULT_PORT = 47291;
const IDLE_MS = Number(process.env.FCC_IDLE_MINUTES ?? 30) * 60_000;

/** Files the page may load: URL path -> absolute file. */
const STATIC = staticFiles();

function staticFiles(): Record<string, string> {
  // Bundled: scripts/build.mjs copied everything to web/ next to the entry point (dist/fcc.mjs).
  const bundled = path.join(path.dirname(process.argv[1]!), "web");
  const isBundled = existsSync(path.join(bundled, "vendor"));
  const web = isBundled ? bundled : fileURLToPath(new URL("../web/", import.meta.url));
  const vendor = (bundledName: string, modulePath: string) =>
    isBundled ? path.join(bundled, "vendor", bundledName) : fileURLToPath(new URL(`../../node_modules/${modulePath}`, import.meta.url));
  return {
    "/": path.join(web, "index.html"),
    "/app.js": path.join(web, "app.js"),
    "/story.js": path.join(web, "story.js"),
    "/app.css": path.join(web, "app.css"),
    "/vendor/cytoscape.js": vendor("cytoscape.js", "cytoscape/dist/cytoscape.min.js"),
    "/vendor/elk.js": vendor("elk.js", "elkjs/lib/elk.bundled.js"),
    "/vendor/cytoscape-elk.js": vendor("cytoscape-elk.js", "cytoscape-elk/dist/cytoscape-elk.js"),
  };
}

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
};

export function startServer(): void {
  const token = randomBytes(16).toString("hex");
  let port = 0;
  let idleTimer: NodeJS.Timeout | undefined;

  const shutdown = () => {
    // Only remove server.json if it still describes this process.
    if (readServerInfo()?.pid === process.pid) rmSync(serverInfoPath(), { force: true });
    process.exit(0);
  };
  const touch = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(shutdown, IDLE_MS);
  };

  const server = createServer((req, res) => {
    touch();
    try {
      handle(req, res, token, port);
    } catch (err) {
      send(res, 500, "text/plain", String(err));
    }
  });

  const listen = (p: number) => server.listen(p, "127.0.0.1");
  let triedRandomPort = false;
  server.on("error", (err: NodeJS.ErrnoException) => {
    // Default port taken by something else: any free port will do, the hook prints the URL.
    if (err.code !== "EADDRINUSE" || triedRandomPort) throw err;
    triedRandomPort = true;
    listen(0);
  });
  server.on("listening", () => {
    port = (server.address() as AddressInfo).port;
    const info: ServerInfo = { port, token, pid: process.pid };
    mkdirSync(fccHome(), { recursive: true });
    writeFileSync(serverInfoPath(), JSON.stringify(info), { mode: 0o600 });
    touch();
  });
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
  listen(Number(process.env.FCC_PORT ?? DEFAULT_PORT));
}

function handle(req: IncomingMessage, res: ServerResponse, token: string, port: number): void {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");

  // DNS-rebinding guard: only answer requests addressed to loopback.
  const host = req.headers.host ?? "";
  if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return send(res, 403, "text/plain", "forbidden host");
  if (req.method !== "GET") return send(res, 405, "text/plain", "method not allowed");

  const cookieName = `fcc_${port}`;
  const queryToken = url.searchParams.get("t");
  const presented = queryToken ?? req.headers["x-fcc-token"]?.toString() ?? readCookie(req, cookieName);
  if (!presented || !safeEqual(presented, token)) return send(res, 401, "text/plain", "missing or invalid token");
  if (queryToken) {
    res.setHeader("Set-Cookie", `${cookieName}=${token}; HttpOnly; SameSite=Strict; Path=/`);
  }

  if (url.pathname === "/health") return sendJson(res, { ok: true });
  if (url.pathname === "/api/tasks") return sendJson(res, listTasks());

  const m = /^\/api\/tasks\/([^/]+)\/([^/]+)$/.exec(url.pathname);
  if (m) {
    const graph = readGraph(decodeURIComponent(m[1]!), decodeURIComponent(m[2]!));
    return graph ? sendJson(res, graph) : send(res, 404, "text/plain", "task not found");
  }

  const file = STATIC[url.pathname];
  if (file) return send(res, 200, TYPES[path.extname(file) || ".html"]!, readFileSync(file));
  send(res, 404, "text/plain", "not found");
}

function send(res: ServerResponse, status: number, type: string, body: string | Buffer): void {
  res.writeHead(status, {
    "Content-Type": type,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Content-Security-Policy": "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:",
  });
  res.end(body);
}

function sendJson(res: ServerResponse, value: unknown): void {
  send(res, 200, "application/json; charset=utf-8", JSON.stringify(value));
}

function readCookie(req: IncomingMessage, name: string): string | undefined {
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
  return undefined;
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}
