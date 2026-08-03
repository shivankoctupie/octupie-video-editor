import { describe, expect, it } from "vitest";
import {
  assertHttpsUrl,
  assertPublicHostname,
  assertResolvesPublic,
  isBlockedIp,
  SsrfBlockedError,
} from "../src/util/ssrf.js";

describe("isBlockedIp", () => {
  it.each([
    "0.0.0.0",
    "10.0.0.1",
    "100.64.0.1",
    "127.0.0.1",
    "169.254.169.254",
    "172.16.0.1",
    "172.31.255.255",
    "192.0.2.5",
    "192.168.1.1",
    "198.18.0.1",
    "203.0.113.9",
    "224.0.0.1",
    "255.255.255.255",
    "::1",
    "::",
    "fe80::1",
    "fc00::1",
    "fd12:3456::1",
    "ff02::1",
    "::ffff:127.0.0.1",
    "::ffff:10.0.0.1",
  ])("blocks private/reserved %s", (ip) => {
    expect(isBlockedIp(ip)).toBe(true);
  });

  it.each([
    "8.8.8.8",
    "1.1.1.1",
    "93.184.216.34",
    "203.0.114.1",
    "2606:2800:220:1:248:1893:25c8:1946",
    "2001:4860:4860::8888",
  ])("allows public %s", (ip) => {
    expect(isBlockedIp(ip)).toBe(false);
  });

  it("treats a non-IP string as not a bare IP (name resolution is separate)", () => {
    expect(isBlockedIp("example.com")).toBe(false);
    expect(isBlockedIp("not.an.ip")).toBe(false);
  });
});

describe("isBlockedIp IPv6 IPv4-compatible (::/96) and 6to4 (2002::/16)", () => {
  it.each([
    "::127.0.0.1", // IPv4-compatible form embedding loopback
    "::7f00:1", // same address written with hex groups
    "2002:7f00:1::", // 6to4 relay embedding 127.0.0.1
    "2002:a00:1::", // 6to4 embedding 10.0.0.1
    "2002::1", // any 6to4 address is refused wholesale
    "::", // unspecified is preserved as blocked
    "::1", // loopback is preserved as blocked
  ])("blocks %s", (ip) => {
    expect(isBlockedIp(ip)).toBe(true);
  });

  it.each([
    "2606:2800:220:1:248:1893:25c8:1946", // real public IPv6, must stay allowed
    "2001:4860:4860::8888", // public resolver, must stay allowed
  ])("allows safe public %s", (ip) => {
    expect(isBlockedIp(ip)).toBe(false);
  });
});

describe("assertPublicHostname", () => {
  it("rejects localhost and blocked IP literals", () => {
    expect(() => assertPublicHostname("localhost")).toThrow(SsrfBlockedError);
    expect(() => assertPublicHostname("127.0.0.1")).toThrow(SsrfBlockedError);
    expect(() => assertPublicHostname("10.0.0.5")).toThrow(SsrfBlockedError);
    expect(() => assertPublicHostname("[::1]")).toThrow(SsrfBlockedError);
  });
  it("permits a plain hostname (resolution checked separately)", () => {
    expect(() => assertPublicHostname("example.com")).not.toThrow();
  });
  it("rejects empty host", () => {
    expect(() => assertPublicHostname("")).toThrow(SsrfBlockedError);
  });
});

describe("assertResolvesPublic (DNS-rebinding aware)", () => {
  it("blocks when any resolved address is private", async () => {
    await expect(assertResolvesPublic("evil.example", async () => ["93.184.216.34", "127.0.0.1"])).rejects.toBeInstanceOf(
      SsrfBlockedError,
    );
  });
  it("blocks when resolution is empty", async () => {
    await expect(assertResolvesPublic("void.example", async () => [])).rejects.toBeInstanceOf(SsrfBlockedError);
  });
  it("passes and returns addresses when every resolved address is public", async () => {
    const r = await assertResolvesPublic("ok.example", async () => ["93.184.216.34"]);
    expect(r.addresses).toEqual(["93.184.216.34"]);
    expect(r.host).toBe("ok.example");
  });
});

describe("assertHttpsUrl", () => {
  it("requires https by default", () => {
    expect(() => assertHttpsUrl("http://example.com/x")).toThrow(SsrfBlockedError);
    expect(assertHttpsUrl("https://example.com/x").hostname).toBe("example.com");
  });
  it("allows http only when explicitly permitted", () => {
    expect(assertHttpsUrl("http://example.com", { allowHttp: true }).protocol).toBe("http:");
  });
  it("rejects non-http(s) schemes", () => {
    expect(() => assertHttpsUrl("ftp://example.com")).toThrow(SsrfBlockedError);
    expect(() => assertHttpsUrl("file:///etc/passwd")).toThrow(SsrfBlockedError);
  });
  it("rejects a URL whose host is a blocked IP literal", () => {
    expect(() => assertHttpsUrl("https://127.0.0.1/x")).toThrow(SsrfBlockedError);
    expect(() => assertHttpsUrl("https://[::1]/x")).toThrow(SsrfBlockedError);
  });
});
