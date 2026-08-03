/**
 * A minimal structural fetch contract. Every network-touching adapter takes a
 * `FetchLike` by injection so tests drive it with a stub and never touch the real
 * network. The global `fetch` is assignable to `FetchLike`, so production wiring is
 * a one-liner. This module has no behavior; it only defines the boundary type.
 */

export interface FetchResponseLike {
  readonly status: number;
  readonly headers: { get(name: string): string | null };
  arrayBuffer(): Promise<ArrayBuffer>;
  text(): Promise<string>;
  json(): Promise<unknown>;
}

export interface FetchInitLike {
  method?: string;
  headers?: Record<string, string>;
  body?: string | Uint8Array;
  /** Adapters set "manual" so they can inspect and re-validate each redirect hop. */
  redirect?: "follow" | "manual" | "error";
  signal?: AbortSignal;
  /** An already-SSRF-validated public IP to pin the socket to. A pinning transport
   * connects ONLY to this address (no second DNS lookup), defeating DNS rebinding,
   * while TLS SNI and the Host header keep the URL's hostname. */
  pinnedAddress?: string;
}

export type FetchLike = (url: string, init?: FetchInitLike) => Promise<FetchResponseLike>;
