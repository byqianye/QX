import { afterEach, describe, expect, it } from "vitest";

import {
  WebSecurityManager,
  hashWebPin,
  isSafeLanAddress,
  listSafeLanInterfaces,
} from "../src/web-control/web-security.js";

class MemorySettings {
  value: unknown = null;

  public get<T>(_key: string): T | null {
    return this.value as T | null;
  }

  public set(_key: string, value: unknown): void {
    this.value = value;
  }
}

describe("WebSecurityManager", () => {
  const managers: WebSecurityManager[] = [];

  afterEach(() => {
    while (managers.length > 0) managers.pop();
  });

  it("generates a six-digit CSPRNG PIN and persists only salted KDF material", () => {
    const settings = new MemorySettings();
    const manager = new WebSecurityManager({ settings });
    managers.push(manager);
    const pin = manager.consumeSetupPin();
    expect(pin).toMatch(/^\d{6}$/u);
    const serialized = JSON.stringify(settings.value);
    expect(serialized).not.toContain(pin as string);
    expect(settings.value).toMatchObject({ pin: { algorithm: "scrypt" } });
    expect(hashWebPin("123456").digest).not.toBe(hashWebPin("123456").digest);
  });

  it("enforces per-IP/global cooldown, then creates expiring permission-bound sessions", () => {
    let now = 1_000;
    const settings = new MemorySettings();
    const manager = new WebSecurityManager({
      settings,
      now: () => now,
      maxPinFailuresPerIp: 2,
      maxPinFailuresGlobal: 4,
      pinCooldownMs: 100,
      sessionTtlMs: 500,
    });
    managers.push(manager);
    const pin = manager.consumeSetupPin() as string;
    const wrong = pin === "000000" ? "000001" : "000000";

    expect(manager.login(wrong, "192.168.1.10")).toMatchObject({ ok: false, code: "WEB_PIN_INVALID" });
    expect(manager.login(wrong, "192.168.1.10")).toMatchObject({ ok: false, code: "WEB_PIN_RATE_LIMITED" });
    expect(manager.login(wrong, "192.168.1.10")).toMatchObject({ ok: false, code: "WEB_PIN_RATE_LIMITED" });

    now += 101;
    const loggedIn = manager.login(pin, "192.168.1.10", ["read", "push"]);
    expect(loggedIn).toMatchObject({ ok: true, session: { permissions: ["read", "push"] } });
    if (!loggedIn.ok) throw new Error("login should succeed");
    expect(manager.hasPermission(loggedIn.session, "read")).toBe(true);
    expect(manager.hasPermission(loggedIn.session, "control")).toBe(false);
    expect(manager.authenticate(loggedIn.token)).toMatchObject({ id: loggedIn.session.id });

    now += 501;
    expect(manager.authenticate(loggedIn.token)).toBeNull();
  });

  it("revokes one session or all sessions without collecting device identity", () => {
    const manager = new WebSecurityManager();
    managers.push(manager);
    const pin = manager.consumeSetupPin() as string;
    const first = manager.login(pin, "192.168.1.10", ["read"]);
    const second = manager.login(pin, "192.168.1.11", ["control"]);
    if (!first.ok || !second.ok) throw new Error("login should succeed");
    expect(manager.listSessions()).toHaveLength(2);
    expect(manager.listSessions()[0]).not.toHaveProperty("remoteAddress");
    expect(manager.revoke(first.session.id)).toBe(true);
    expect(manager.authenticate(first.token)).toBeNull();
    expect(manager.revokeAll()).toBe(1);
    expect(manager.listSessions()).toEqual([]);
  });
});

describe("LAN binding selection", () => {
  it("keeps only private physical-looking IPv4 interfaces", () => {
    const selected = listSafeLanInterfaces({
      "Wi-Fi": [{ address: "192.168.1.20", family: "IPv4", internal: false }],
      VPN: [{ address: "10.0.0.8", family: "IPv4", internal: false }],
      DockerNAT: [{ address: "172.18.0.1", family: "IPv4", internal: false }],
      Ethernet: [{ address: "8.8.8.8", family: "IPv4", internal: false }],
      Loopback: [{ address: "127.0.0.1", family: "IPv4", internal: true }],
      HyperV: [{ address: "192.168.56.1", family: "IPv4", internal: false }],
    });
    expect(selected).toEqual([{ name: "Wi-Fi", address: "192.168.1.20", family: "IPv4", internal: false }]);
    expect(isSafeLanAddress("192.168.1.20")).toBe(true);
    expect(isSafeLanAddress("169.254.1.2")).toBe(false);
    expect(isSafeLanAddress("0.0.0.0")).toBe(false);
  });
});
