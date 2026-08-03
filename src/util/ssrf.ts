/**
 * SSRF guards. Any outbound fetch that can be pointed at an attacker-controlled URL
 * (web asset materialization, publishing webhooks) must pass these before a byte is
 * sent. The rules are deny-by-default for anything that is not a routable public
 * address:
 *
 *   - only http(s) URLs, https by default;
 *   - an IP literal in the host is checked directly and blocked when private,
 *     loopback, link-local, CGNAT, benchmark, documentation, multicast, or reserved;
 *   - a hostname is resolved by an injected resolver and EVERY resolved address must
 *     be public, so a name that resolves partly to a private address is refused
 *     (DNS-rebinding aware); an empty resolution is refused.
 *
 * The resolver is injected so tests are deterministic and offline. This module is the
 * validation half and is pure and offline; the connect half is `util/pinnedFetch.ts`,
 * which pins the socket to the address this module returned (via `assertResolvesPublic`)
 * so the transport performs no second, unvetted DNS lookup. Callers resolve+validate here,
 * then pass the vetted address as `pinnedAddress` (see `materialize/web.ts` and
 * `workflow/webhookPublishing.ts`), closing the DNS-rebinding TOCTOU.
 */

/** Thrown for any SSRF gate failure. */
export class SsrfBlockedError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "SsrfBlockedError";
    this.code = code;
  }
}

export type HostResolver = (host: string) => Promise<string[]>;

export interface SsrfCheckResult {
  host: string;
  addresses: string[];
}

function parseIpv4(value: string): number[] | null {
  const parts = value.split(".");
  if (parts.length !== 4) return null;
  const octets: number[] = [];
  for (const part of parts) {
    if (!/^[0-9]{1,3}$/.test(part)) return null;
    const n = Number(part);
    if (n < 0 || n > 255) return null;
    // Reject non-canonical leading zeros (e.g. "010") that could bypass filters.
    if (part.length > 1 && part.startsWith("0")) return null;
    octets.push(n);
  }
  return octets;
}

function isBlockedIpv4(octets: number[]): boolean {
  const [a, b] = octets as [number, number, number, number];
  if (a === 0) return true; // 0.0.0.0/8
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 127) return true; // 127.0.0.0/8 loopback
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
  if (a === 192 && b === 0 && octets[2] === 0) return true; // 192.0.0.0/24 IETF
  if (a === 192 && b === 0 && octets[2] === 2) return true; // 192.0.2.0/24 TEST-NET-1
  if (a === 198 && (b === 18 || b === 19)) return true; // 198.18.0.0/15 benchmark
  if (a === 198 && b === 51 && octets[2] === 100) return true; // 198.51.100.0/24 TEST-NET-2
  if (a === 203 && b === 0 && octets[2] === 113) return true; // 203.0.113.0/24 TEST-NET-3
  if (a >= 224) return true; // 224.0.0.0/4 multicast and 240.0.0.0/4 reserved (incl. 255.255.255.255)
  return false;
}

function expandIpv6(value: string): number[] | null {
  let host = value.trim();
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
  // Drop a zone id (fe80::1%eth0).
  const zone = host.indexOf("%");
  if (zone >= 0) host = host.slice(0, zone);
  if (!host.includes(":")) return null;

  // Split off an embedded IPv4 tail (::ffff:127.0.0.1).
  let v4Tail: number[] | null = null;
  const lastColon = host.lastIndexOf(":");
  const tail = host.slice(lastColon + 1);
  if (tail.includes(".")) {
    v4Tail = parseIpv4(tail);
    if (v4Tail === null) return null;
    host = host.slice(0, lastColon + 1) + "0:0";
  }

  const halves = host.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0]!.split(":") : [];
  const back = halves.length === 2 ? (halves[1] ? halves[1]!.split(":") : []) : null;

  const toWords = (groups: string[]): number[] | null => {
    const words: number[] = [];
    for (const g of groups) {
      if (g === "") return null;
      if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
      words.push(parseInt(g, 16));
    }
    return words;
  };

  const headWords = toWords(head);
  if (headWords === null) return null;
  let words: number[];
  if (back === null) {
    if (headWords.length !== 8) return null;
    words = headWords;
  } else {
    const backWords = toWords(back);
    if (backWords === null) return null;
    const missing = 8 - headWords.length - backWords.length;
    if (missing < 1) return null;
    words = [...headWords, ...Array<number>(missing).fill(0), ...backWords];
  }
  if (words.length !== 8) return null;
  if (v4Tail) {
    words[6] = (v4Tail[0]! << 8) | v4Tail[1]!;
    words[7] = (v4Tail[2]! << 8) | v4Tail[3]!;
  }
  return words;
}

/** The IPv4 address embedded in the last 32 bits of an IPv6 word array. */
function embeddedIpv4(words: number[]): number[] {
  return [(words[6]! >> 8) & 0xff, words[6]! & 0xff, (words[7]! >> 8) & 0xff, words[7]! & 0xff];
}

function isBlockedIpv6(words: number[]): boolean {
  const [w0, w1] = words as number[];
  // IPv4-mapped ::ffff:0:0/96 -> validate the embedded v4.
  if (words.slice(0, 5).every((w) => w === 0) && words[5] === 0xffff) {
    return isBlockedIpv4(embeddedIpv4(words));
  }
  // IPv4-compatible ::/96 -> validate the embedded v4. This range includes the unspecified
  // (::) and loopback (::1) addresses, which fall in 0.0.0.0/8 and stay blocked, and refuses
  // any form embedding a blocked IPv4 (e.g. ::127.0.0.1, written ::7f00:1) that could be used
  // to reach a private host.
  if (words.slice(0, 6).every((w) => w === 0)) {
    return isBlockedIpv4(embeddedIpv4(words));
  }
  if (w0 === 0x2002) return true; // 6to4 2002::/16: the whole range is refused (embeds an arbitrary IPv4 relay target)
  if ((w0! & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((w0! & 0xfe00) === 0xfc00) return true; // fc00::/7 unique-local (fc/fd)
  if ((w0! & 0xff00) === 0xff00) return true; // ff00::/8 multicast
  if (w0 === 0x0100 && w1 === 0) return true; // 100::/64 discard-only
  return false;
}

/** True when `value` is a bare IP literal that is private, reserved, or otherwise not
 * a routable public address. A non-IP string (a hostname) returns false; resolve it
 * with {@link assertResolvesPublic} instead. */
export function isBlockedIp(value: string): boolean {
  const v4 = parseIpv4(value);
  if (v4) return isBlockedIpv4(v4);
  const v6 = expandIpv6(value);
  if (v6) return isBlockedIpv6(v6);
  return false;
}

/** Reject a host that is empty, `localhost`, or a blocked IP literal. A plain
 * hostname passes here and is checked by resolution separately. */
export function assertPublicHostname(host: string): void {
  const trimmed = host.trim();
  if (trimmed.length === 0) throw new SsrfBlockedError("empty-host", "Host is empty.");
  const bare = trimmed.startsWith("[") && trimmed.endsWith("]") ? trimmed.slice(1, -1) : trimmed;
  if (bare.toLowerCase() === "localhost" || bare.toLowerCase().endsWith(".localhost")) {
    throw new SsrfBlockedError("localhost", `Host '${host}' resolves to the local machine.`);
  }
  if (isBlockedIp(bare)) {
    throw new SsrfBlockedError("private-ip", `Host '${host}' is a private or reserved address.`);
  }
}

/** Resolve a hostname and require EVERY address to be public. Rebinding-aware: a
 * single private address in the set blocks the whole host. */
export async function assertResolvesPublic(host: string, resolve: HostResolver): Promise<SsrfCheckResult> {
  assertPublicHostname(host);
  const addresses = await resolve(host);
  if (!Array.isArray(addresses) || addresses.length === 0) {
    throw new SsrfBlockedError("no-address", `Host '${host}' did not resolve to any address.`);
  }
  for (const addr of addresses) {
    if (typeof addr !== "string" || isBlockedIp(addr)) {
      throw new SsrfBlockedError("private-ip", `Host '${host}' resolves to a private or reserved address (${addr}).`);
    }
  }
  return { host, addresses };
}

/** Parse and gate a URL: only http(s) (https unless `allowHttp`), and a host that is
 * not a blocked IP literal. Returns the parsed URL for the caller to resolve/pin. */
export function assertHttpsUrl(url: string, opts: { allowHttp?: boolean } = {}): URL {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new SsrfBlockedError("bad-url", `Not a valid URL: ${JSON.stringify(url)}`);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new SsrfBlockedError("bad-scheme", `Only http(s) URLs are allowed, got '${parsed.protocol}'.`);
  }
  if (parsed.protocol === "http:" && !opts.allowHttp) {
    throw new SsrfBlockedError("insecure", "HTTPS is required; http was refused.");
  }
  assertPublicHostname(parsed.hostname);
  return parsed;
}
