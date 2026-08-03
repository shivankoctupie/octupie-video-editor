/**
 * Minimal HTTP plumbing built on the Node standard library (no web framework, no CDN).
 *
 * A tiny router matches method + path patterns with `:param` segments. Every non-public
 * route is authenticated by bearer token and authorized by the workflow RBAC matrix
 * before its handler runs. Bodies are read with a hard byte cap; the bearer token is
 * parsed but never logged. Static files are served from an explicit directory with a
 * containment check so a request path can never escape it.
 */

import { createReadStream, existsSync, statSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { authorize, type WorkflowAction } from "../workflow/rbac.js";
import { assertContainedPath } from "../util/paths.js";
import type { AuthRegistry, Principal } from "./auth.js";

export interface Ctx {
  req: IncomingMessage;
  res: ServerResponse;
  method: string;
  path: string;
  url: URL;
  params: Record<string, string>;
  query: URLSearchParams;
  principal: Principal | null;
}

export type Handler = (ctx: Ctx) => Promise<void> | void;

/** "public" = no auth. Otherwise the RBAC action a principal must hold. */
export type RouteAction = WorkflowAction | "public";

interface Route {
  method: string;
  segments: string[];
  action: RouteAction;
  handler: Handler;
}

export class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.code = code;
  }
}

/**
 * Global hardening for the app shell and every JSON response. The CSP fits the all-local React
 * app: scripts and styles are the two bundled same-origin files (React inline `style=` attributes
 * need `'unsafe-inline'` in style-src), and the browser builds media object URLs (`blob:`) and
 * canvas thumbnails (`data:`) that `<img>`/`<video>` render. Everything else is denied: no
 * framing, no plugins, no `<base>` hijack. Media BYTES are served by sendBytes with their own,
 * stricter sandboxed CSP and are deliberately left untouched here.
 */
export const APP_SECURITY_HEADERS: Readonly<Record<string, string>> = {
  "content-security-policy": [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' blob: data:",
    "media-src 'self' blob:",
    "font-src 'self'",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
  ].join("; "),
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "x-frame-options": "DENY",
};

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(text), ...APP_SECURITY_HEADERS });
  res.end(text);
}

export function sendError(res: ServerResponse, status: number, code: string, message: string): void {
  sendJson(res, status, { error: { code, message } });
}

/** Send raw stored media bytes safely. The real mime is preserved (so the app can preview
 * a fetched blob), but the response is never a trusted document: `nosniff` stops payload
 * re-interpretation, `Content-Disposition: attachment` forces download over inline render,
 * and a locked-down CSP (`default-src 'none'; sandbox`) neutralizes any active content
 * (an SVG or HTML `<script>`) so a materialized/uploaded blob can never execute
 * same-origin and read the session token. */
export function sendBytes(res: ServerResponse, status: number, mime: string, bytes: Buffer, filename?: string): void {
  const safeName = filename ? filename.replace(/[^A-Za-z0-9._-]/g, "_") : undefined;
  res.writeHead(status, {
    "content-type": mime,
    "content-length": bytes.length,
    "x-content-type-options": "nosniff",
    "content-disposition": `attachment${safeName ? `; filename="${safeName}"` : ""}`,
    "content-security-policy": "default-src 'none'; sandbox",
    "cache-control": "private, max-age=300",
  });
  res.end(bytes);
}

/** A thrown error that carries a safe 4xx status and code (e.g. UploadError) is surfaced
 * to the client verbatim; anything else becomes a generic 500. */
function isClientError(e: unknown): e is { status: number; code: string; message: string } {
  if (typeof e !== "object" || e === null) return false;
  const o = e as Record<string, unknown>;
  return typeof o.status === "number" && o.status >= 400 && o.status < 500 && typeof o.code === "string" && typeof o.message === "string";
}

function parseBearer(header: string | undefined): string | undefined {
  if (!header) return undefined;
  const m = /^Bearer\s+(.+)$/i.exec(header.trim());
  return m ? m[1] : undefined;
}

/** Read and JSON-parse a request body under a byte cap. Returns {} for an empty body. */
export function readJsonBody(req: IncomingMessage, maxBytes: number): Promise<Record<string, unknown>> {
  return new Promise((resolveP, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    const fail = (e: Error): void => {
      if (done) return;
      done = true;
      req.destroy();
      reject(e);
    };
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > maxBytes) {
        fail(new HttpError(413, "body-too-large", `Request body exceeds the ${maxBytes}-byte cap.`));
        return;
      }
      chunks.push(c);
    });
    req.on("error", (e) => fail(e instanceof Error ? e : new Error(String(e))));
    req.on("end", () => {
      if (done) return;
      done = true;
      const raw = Buffer.concat(chunks).toString("utf8").trim();
      if (raw.length === 0) {
        resolveP({});
        return;
      }
      try {
        const v = JSON.parse(raw);
        if (v === null || typeof v !== "object" || Array.isArray(v)) {
          reject(new HttpError(400, "bad-json", "Request body must be a JSON object."));
          return;
        }
        resolveP(v as Record<string, unknown>);
      } catch {
        reject(new HttpError(400, "bad-json", "Request body is not valid JSON."));
      }
    });
  });
}

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".map": "application/json; charset=utf-8",
};

export class Router {
  private readonly routes: Route[] = [];
  constructor(
    private readonly auth: AuthRegistry,
    private readonly publicDir: string,
  ) {}

  add(method: string, pattern: string, action: RouteAction, handler: Handler): void {
    this.routes.push({ method: method.toUpperCase(), segments: pattern.split("/").filter((s) => s.length > 0), action, handler });
  }

  private match(method: string, path: string): { route: Route; params: Record<string, string> } | null {
    const parts = path.split("/").filter((s) => s.length > 0);
    for (const route of this.routes) {
      if (route.method !== method) continue;
      if (route.segments.length !== parts.length) continue;
      const params: Record<string, string> = {};
      let ok = true;
      for (let i = 0; i < route.segments.length; i++) {
        const seg = route.segments[i]!;
        const part = parts[i]!;
        if (seg.startsWith(":")) params[seg.slice(1)] = decodeURIComponent(part);
        else if (seg !== part) {
          ok = false;
          break;
        }
      }
      if (ok) return { route, params };
    }
    return null;
  }

  /** The Node request listener. */
  listener(): (req: IncomingMessage, res: ServerResponse) => void {
    return (req, res) => {
      void this.handle(req, res);
    };
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let url: URL;
    try {
      url = new URL(req.url ?? "/", "http://localhost");
    } catch {
      sendError(res, 400, "bad-url", "Malformed request URL.");
      return;
    }
    const method = (req.method ?? "GET").toUpperCase();
    const path = url.pathname;
    const principal = this.auth.authenticate(parseBearer(req.headers.authorization));

    const found = this.match(method, path);
    if (found) {
      const ctx: Ctx = { req, res, method, path, url, params: found.params, query: url.searchParams, principal };
      if (found.route.action !== "public") {
        if (!principal) {
          sendError(res, 401, "unauthenticated", "A valid bearer token is required.");
          return;
        }
        if (!authorize(principal.role, found.route.action)) {
          sendError(res, 403, "forbidden", `Role '${principal.role}' is not authorized for this action.`);
          return;
        }
      }
      try {
        await found.route.handler(ctx);
      } catch (err) {
        if (err instanceof HttpError) sendError(res, err.status, err.code, err.message);
        else if (isClientError(err)) sendError(res, err.status, err.code, err.message);
        else {
          // Never leak internals or a token; return a generic server error.
          sendError(res, 500, "internal", "Internal server error.");
        }
      }
      return;
    }

    // No API route: for a GET, try the static browser app; otherwise 404.
    if (method === "GET" && !path.startsWith("/api/")) {
      this.serveStatic(path, res);
      return;
    }
    sendError(res, 404, "not-found", `No route for ${method} ${path}.`);
  }

  private serveStatic(path: string, res: ServerResponse): void {
    const rel = path === "/" ? "index.html" : path.replace(/^\/+/, "");
    let abs: string;
    try {
      abs = resolve(this.publicDir, rel);
      assertContainedPath(abs, this.publicDir, "static path");
    } catch {
      sendError(res, 403, "forbidden", "Static path escapes the public root.");
      return;
    }
    let target = abs;
    if (!existsSync(target) || !statSync(target).isFile()) {
      // Single-page app fallback so client routes resolve to the shell.
      target = join(this.publicDir, "index.html");
      if (!existsSync(target)) {
        sendError(res, 404, "not-found", "Not found.");
        return;
      }
    }
    const type = CONTENT_TYPES[extname(target).toLowerCase()] ?? "application/octet-stream";
    res.writeHead(200, { "content-type": type, "cache-control": "no-cache", ...APP_SECURITY_HEADERS });
    createReadStream(target).pipe(res);
  }
}
