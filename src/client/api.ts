/*
 * Thin REST client for the product server. The bearer token is held in memory and mirrored
 * to sessionStorage so a refresh keeps the session but nothing persists beyond the tab. The
 * token is NEVER placed in a URL or logged; it only rides the Authorization header.
 */

export interface ApiResult<T = unknown> {
  status: number;
  json: T | null;
  ok: boolean;
}

let token = sessionStorage.getItem("ove_token") || "";

export function getToken(): string {
  return token;
}
export function setToken(next: string): void {
  token = next;
  if (next) sessionStorage.setItem("ove_token", next);
  else sessionStorage.removeItem("ove_token");
}

function authHeaders(extra?: Record<string, string>): Record<string, string> {
  return { authorization: `Bearer ${token}`, ...(extra || {}) };
}

export async function api<T = any>(path: string, opts: { method?: string; body?: unknown; headers?: Record<string, string> } = {}): Promise<ApiResult<T>> {
  const headers = authHeaders(opts.headers);
  let body: BodyInit | undefined;
  if (opts.body !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(opts.body);
  }
  const res = await fetch(path, { method: opts.method || "GET", headers, ...(body !== undefined ? { body } : {}) });
  const text = await res.text();
  const ct = res.headers.get("content-type") || "";
  let json: T | null = null;
  if (ct.includes("application/json") && text) {
    try {
      json = JSON.parse(text) as T;
    } catch {
      json = null;
    }
  }
  return { status: res.status, json, ok: res.status >= 200 && res.status < 300 };
}

/** Raw byte upload (media). Content type and filename ride headers; the token is never in the URL. */
export async function apiUpload<T = any>(path: string, contentType: string, filename: string, bytes: Uint8Array): Promise<ApiResult<T>> {
  const res = await fetch(path, { method: "POST", headers: authHeaders({ "content-type": contentType, "x-filename": filename }), body: bytes as BodyInit });
  const text = await res.text();
  let json: T | null = null;
  try {
    json = text ? (JSON.parse(text) as T) : null;
  } catch {
    json = null;
  }
  return { status: res.status, json, ok: res.status >= 200 && res.status < 300 };
}

export function errorText(r: ApiResult, fallback: string): string {
  const j = r.json as any;
  return (j && j.error && j.error.message) || (j && j.message) || fallback;
}

// ---- typed shapes used across the client ----

export interface MediaRow {
  id: string;
  projectId: string;
  storageKey: string;
  sha256: string;
  size: number;
  mime: string;
  filename: string;
  origin: string;
}

export interface VersionRow {
  id: string;
  version: number;
  status: "draft" | "in-review" | "approved" | "rejected" | string;
  creator: string;
  planSha256: string;
  parentVersionId: string | null;
}

export interface Me {
  user: { username: string; role: string; tenantId: string };
  actions: string[];
}

export interface ProjectRow {
  id: string;
  name: string;
}
