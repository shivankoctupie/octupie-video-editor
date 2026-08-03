/**
 * Production HTTP transport with connection pinning (SSRF/DNS-rebinding defense).
 *
 * SSRF validation (`ssrf.ts`) resolves a hostname and proves every address is public.
 * But if the socket then re-resolves the name, an attacker can rebind it to a private
 * address between the check and the connect (a TOCTOU). This transport removes the
 * second lookup entirely: the caller passes the already-validated public IP as
 * `init.pinnedAddress`, and the socket connects ONLY to that IP via a custom `lookup`
 * that ignores the hostname. TLS SNI and the Host header still use the hostname (from
 * the URL), so certificate validation and virtual hosting keep working. With no
 * `pinnedAddress` the transport behaves as an ordinary client (used for the fixed,
 * trusted Drive host, which is not attacker-controlled).
 *
 * The low-level request function is injectable so the pinning behavior is tested offline
 * without opening a socket. `redirect: "manual"` needs no special handling: Node's
 * http(s).request never auto-follows a redirect, so a 3xx is returned to the caller to
 * re-validate (see `materialize/web.ts`).
 */

import { request as httpsRequest } from "node:https";
import { request as httpRequest } from "node:http";
import type { ClientRequest, IncomingMessage } from "node:http";
import type { RequestOptions } from "node:https";
import type { FetchInitLike, FetchLike, FetchResponseLike } from "./fetchLike.js";

type LookupCallback = (err: Error | null, address: string | Array<{ address: string; family: number }>, family?: number) => void;
type PinnedLookup = (hostname: string, options: unknown, callback: LookupCallback) => void;

/** The subset of Node request options this transport builds. Structurally a valid
 * `https.RequestOptions`, exported so the pinning logic is unit-testable. */
export interface PinnedRequestOptions {
  protocol: string;
  host: string;
  port: number;
  path: string;
  method: string;
  headers: Record<string, string>;
  /** TLS SNI (https only) always tracks the hostname, never the pinned IP. */
  servername?: string;
  /** Present only when an address is pinned; returns that IP without any DNS query. */
  lookup?: PinnedLookup;
}

/** The injectable low-level request seam. Defaults to node:https / node:http. */
export type NodeRequestFn = (options: PinnedRequestOptions, callback: (res: IncomingMessage) => void) => ClientRequest;

/** A lookup that resolves EVERY hostname to the one pinned, pre-validated address. No DNS
 * is performed, so a rebinding record can never move the socket to a private host. */
function pinnedLookup(address: string): PinnedLookup {
  const family = address.includes(":") ? 6 : 4;
  return (_hostname, options, callback) => {
    const all = typeof options === "object" && options !== null && (options as { all?: boolean }).all === true;
    if (all) callback(null, [{ address, family }]);
    else callback(null, address, family);
  };
}

/** Build the Node request options for one hop. Pure and offline: pins the connect to
 * `init.pinnedAddress` (when present) while keeping the hostname for Host/SNI. */
export function pinnedRequestOptions(url: URL, init: FetchInitLike = {}): PinnedRequestOptions {
  const isHttps = url.protocol === "https:";
  const port = url.port ? Number(url.port) : isHttps ? 443 : 80;
  const options: PinnedRequestOptions = {
    protocol: url.protocol,
    host: url.hostname,
    port,
    path: `${url.pathname}${url.search}`,
    method: init.method ?? "GET",
    headers: { ...(init.headers ?? {}) },
    ...(isHttps ? { servername: url.hostname } : {}),
    ...(init.pinnedAddress ? { lookup: pinnedLookup(init.pinnedAddress) } : {}),
  };
  return options;
}

function toResponseLike(status: number, headers: IncomingMessage["headers"], body: Buffer): FetchResponseLike {
  return {
    status,
    headers: {
      get(name: string): string | null {
        const v = headers[name.toLowerCase()];
        if (v === undefined) return null;
        return Array.isArray(v) ? v.join(", ") : v;
      },
    },
    arrayBuffer: async () => {
      const copy = new Uint8Array(body.byteLength);
      copy.set(body);
      return copy.buffer;
    },
    text: async () => body.toString("utf8"),
    json: async () => JSON.parse(body.toString("utf8")),
  };
}

/** A production {@link FetchLike} backed by Node's http(s) stack. Honors
 * `init.pinnedAddress` (connection pinning), `init.signal` (abort), and returns 3xx
 * responses unfollowed so the caller re-validates each hop. */
export function createNodeFetch(deps: { request?: NodeRequestFn } = {}): FetchLike {
  return (url: string, init: FetchInitLike = {}): Promise<FetchResponseLike> =>
    new Promise<FetchResponseLike>((resolve, reject) => {
      let parsed: URL;
      try {
        parsed = new URL(url);
      } catch {
        reject(new Error(`Not a valid URL: ${JSON.stringify(url)}`));
        return;
      }
      const isHttps = parsed.protocol === "https:";
      const options = pinnedRequestOptions(parsed, init);
      const requestFn: NodeRequestFn = deps.request ?? ((isHttps ? httpsRequest : httpRequest) as unknown as NodeRequestFn);

      let settled = false;
      const fail = (err: Error): void => {
        if (settled) return;
        settled = true;
        reject(err);
      };

      const req = requestFn(options, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(Buffer.from(c)));
        res.on("end", () => {
          if (settled) return;
          settled = true;
          resolve(toResponseLike(res.statusCode ?? 0, res.headers, Buffer.concat(chunks)));
        });
        res.on("error", (e: Error) => fail(e));
      });

      req.on("error", (e: Error) => fail(e));

      const signal = init.signal;
      if (signal) {
        if (signal.aborted) {
          req.destroy(new Error("request aborted"));
          fail(new Error("request aborted"));
          return;
        }
        signal.addEventListener("abort", () => req.destroy(new Error("request aborted")), { once: true });
      }

      if (init.body !== undefined) req.write(init.body);
      req.end();
    });
}
