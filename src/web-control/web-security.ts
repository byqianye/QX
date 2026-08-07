import { networkInterfaces } from "node:os";
import {
  createHash,
  randomBytes,
  randomInt,
  randomUUID,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";

import type { WebControlPermission } from "./web-control-types.js";

export const WEB_SECURITY_SETTINGS_KEY = "web.security";

const PIN_LENGTH = 6;
const PIN_SPACE = 1_000_000;
const PIN_SALT_BYTES = 16;
const PIN_KEY_BYTES = 32;
const PIN_ATTEMPT_WINDOW_MS = 60_000;
const PIN_COOLDOWN_MS = 30_000;
const MAX_PIN_FAILURES_PER_IP = 5;
const MAX_PIN_FAILURES_GLOBAL = 20;
const DEFAULT_SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const EXCLUDED_INTERFACE_PATTERN = /(vpn|virtual|docker|hyper-?v|vEthernet|tun|tap|tailscale|wireguard|zerotier|loopback)/iu;

export interface WebSecuritySettingsStore {
  get<T>(key: string): T | null;
  set(key: string, value: unknown): void;
}

export interface WebSecurityPersistedState {
  allowLan: boolean;
  pin?: {
    algorithm: "scrypt";
    salt: string;
    digest: string;
  };
}

export interface WebLanInterface {
  name: string;
  address: string;
  family: "IPv4";
  internal: boolean;
}

interface NetworkInterfaceEntry {
  address: string;
  family: string | number;
  internal: boolean;
}

export interface WebSessionView {
  id: string;
  createdAt: number;
  expiresAt: number;
  permissions: readonly WebControlPermission[];
  current: boolean;
}

export interface WebLoginResult {
  ok: true;
  session: WebSessionView;
  token: string;
}

export type WebPinFailure =
  | { ok: false; code: "WEB_PIN_INVALID"; retryAfterMs: 0 }
  | { ok: false; code: "WEB_PIN_RATE_LIMITED"; retryAfterMs: number };

interface StoredSession {
  id: string;
  tokenHash: string;
  createdAt: number;
  expiresAt: number;
  permissions: readonly WebControlPermission[];
}

interface FailureState {
  windowStartedAt: number;
  count: number;
  cooldownUntil: number;
}

interface PersistedPin {
  algorithm: "scrypt";
  salt: Buffer;
  digest: Buffer;
}

export interface WebSecurityManagerOptions {
  settings?: WebSecuritySettingsStore;
  now?: () => number;
  sessionTtlMs?: number;
  pinCooldownMs?: number;
  maxPinFailuresPerIp?: number;
  maxPinFailuresGlobal?: number;
}

export class WebSecurityManager {
  private readonly settings: WebSecuritySettingsStore | undefined;
  private readonly now: () => number;
  private readonly sessionTtlMs: number;
  private readonly pinCooldownMs: number;
  private readonly maxPinFailuresPerIp: number;
  private readonly maxPinFailuresGlobal: number;
  private readonly sessions = new Map<string, StoredSession>();
  private readonly failuresByIp = new Map<string, FailureState>();
  private globalFailures: FailureState = { windowStartedAt: 0, count: 0, cooldownUntil: 0 };
  private pin: PersistedPin | null = null;
  private setupPin: string | null = null;
  private allowLanValue = false;

  public constructor(options: WebSecurityManagerOptions = {}) {
    this.settings = options.settings;
    this.now = options.now ?? Date.now;
    this.sessionTtlMs = positiveInteger(options.sessionTtlMs, DEFAULT_SESSION_TTL_MS);
    this.pinCooldownMs = positiveInteger(options.pinCooldownMs, PIN_COOLDOWN_MS);
    this.maxPinFailuresPerIp = positiveInteger(options.maxPinFailuresPerIp, MAX_PIN_FAILURES_PER_IP);
    this.maxPinFailuresGlobal = positiveInteger(options.maxPinFailuresGlobal, MAX_PIN_FAILURES_GLOBAL);
    const stored = readPersistedState(this.settings?.get<unknown>(WEB_SECURITY_SETTINGS_KEY));
    this.allowLanValue = stored.allowLan;
    this.pin = stored.pin ? decodePin(stored.pin) : null;
    if (!this.pin) this.createPin();
  }

  public get allowLan(): boolean {
    return this.allowLanValue;
  }

  public get pinConfigured(): boolean {
    return this.pin !== null;
  }

  public get setupPinAvailable(): boolean {
    return this.setupPin !== null;
  }

  public setAllowLan(allowLan: boolean): void {
    this.allowLanValue = allowLan;
    this.persist();
  }

  /** Returns a PIN only when it was generated or regenerated during this process. */
  public consumeSetupPin(): string | null {
    const value = this.setupPin;
    this.setupPin = null;
    return value;
  }

  public regeneratePin(): string {
    this.createPin();
    this.revokeAll();
    return this.setupPin as string;
  }

  public login(pin: string, remoteAddress: string, permissions: readonly WebControlPermission[] = ["read"]): WebLoginResult | WebPinFailure {
    const now = this.now();
    const address = normalizeAddress(remoteAddress);
    const retryAfterMs = Math.max(this.retryAfter(this.globalFailures, now), this.retryAfter(this.failuresByIp.get(address), now));
    if (retryAfterMs > 0) return { ok: false, code: "WEB_PIN_RATE_LIMITED", retryAfterMs };

    if (!this.verifyPin(pin)) {
      const ipFailure = this.recordFailure(this.failuresByIp, address, now, this.maxPinFailuresPerIp);
      this.globalFailures = recordFailureState(this.globalFailures, now, this.maxPinFailuresGlobal, this.pinCooldownMs);
      const retry = Math.max(this.retryAfter(ipFailure, now), this.retryAfter(this.globalFailures, now));
      return retry > 0
        ? { ok: false, code: "WEB_PIN_RATE_LIMITED", retryAfterMs: retry }
        : { ok: false, code: "WEB_PIN_INVALID", retryAfterMs: 0 };
    }

    this.failuresByIp.delete(address);
    this.globalFailures = { windowStartedAt: now, count: 0, cooldownUntil: 0 };
    const token = randomBytes(32).toString("base64url");
    const session: StoredSession = {
      id: randomUUID(),
      tokenHash: tokenHash(token),
      createdAt: now,
      expiresAt: now + this.sessionTtlMs,
      permissions: normalizePermissions(permissions),
    };
    this.sessions.set(session.tokenHash, session);
    return { ok: true, token, session: this.toView(session, false) };
  }

  public authenticate(token: string | null | undefined): WebSessionView | null {
    if (!token) return null;
    const key = tokenHash(token);
    const session = this.sessions.get(key);
    if (!session) return null;
    if (session.expiresAt <= this.now()) {
      this.sessions.delete(key);
      return null;
    }
    return this.toView(session, false);
  }

  public hasPermission(session: WebSessionView | null, permission: WebControlPermission): boolean {
    return session?.permissions.includes(permission) === true;
  }

  public revoke(sessionId: string): boolean {
    for (const [key, session] of this.sessions) {
      if (session.id !== sessionId) continue;
      this.sessions.delete(key);
      return true;
    }
    return false;
  }

  public revokeAll(): number {
    const count = this.sessions.size;
    this.sessions.clear();
    return count;
  }

  public listSessions(currentSessionId?: string | null): readonly WebSessionView[] {
    const now = this.now();
    const result: WebSessionView[] = [];
    for (const [key, session] of this.sessions) {
      if (session.expiresAt <= now) {
        this.sessions.delete(key);
        continue;
      }
      result.push(this.toView(session, session.id === (currentSessionId ?? null)));
    }
    return result.sort((left, right) => right.createdAt - left.createdAt);
  }

  public cleanupExpired(): void {
    this.listSessions();
  }

  private createPin(): void {
    const value = randomInt(0, PIN_SPACE).toString().padStart(PIN_LENGTH, "0");
    const salt = randomBytes(PIN_SALT_BYTES);
    this.pin = { algorithm: "scrypt", salt, digest: derivePin(value, salt) };
    this.setupPin = value;
    this.persist();
  }

  private verifyPin(value: string): boolean {
    if (!/^\d{6}$/u.test(value) || !this.pin) return false;
    const digest = derivePin(value, this.pin.salt);
    return digest.byteLength === this.pin.digest.byteLength && timingSafeEqual(digest, this.pin.digest);
  }

  private persist(): void {
    this.settings?.set(WEB_SECURITY_SETTINGS_KEY, {
      allowLan: this.allowLanValue,
      ...(this.pin ? {
        pin: {
          algorithm: this.pin.algorithm,
          salt: this.pin.salt.toString("base64url"),
          digest: this.pin.digest.toString("base64url"),
        },
      } : {}),
    } satisfies WebSecurityPersistedState);
  }

  private recordFailure(map: Map<string, FailureState>, key: string, now: number, limit: number): FailureState {
    const current = recordFailureState(map.get(key), now, limit, this.pinCooldownMs);
    map.set(key, current);
    return current;
  }

  private retryAfter(state: FailureState | undefined, now: number): number {
    return state ? Math.max(0, state.cooldownUntil - now) : 0;
  }

  private toView(session: StoredSession, current: boolean): WebSessionView {
    return {
      id: session.id,
      createdAt: session.createdAt,
      expiresAt: session.expiresAt,
      permissions: [...session.permissions],
      current,
    };
  }
}

export function generateWebPin(): string {
  return randomInt(0, PIN_SPACE).toString().padStart(PIN_LENGTH, "0");
}

export function hashWebPin(pin: string, salt = randomBytes(PIN_SALT_BYTES)): { salt: string; digest: string } {
  return {
    salt: salt.toString("base64url"),
    digest: derivePin(pin, salt).toString("base64url"),
  };
}

export function isSafeLanAddress(value: string): boolean {
  const octets = value.split(".").map(Number);
  if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) return false;
  const [first, second] = octets;
  if (first === undefined || second === undefined) return false;
  return first === 10
    || (first === 172 && second >= 16 && second <= 31)
    || (first === 192 && second === 168);
}

export function listSafeLanInterfaces(
  source: Record<string, readonly NetworkInterfaceEntry[] | undefined> = networkInterfaces(),
): readonly WebLanInterface[] {
  const result: WebLanInterface[] = [];
  for (const [name, entries] of Object.entries(source)) {
    if (!entries || EXCLUDED_INTERFACE_PATTERN.test(name)) continue;
    for (const entry of entries) {
      const family = entry.family === "IPv4" || entry.family === 4 ? "IPv4" : null;
      if (!family || entry.internal || !isSafeLanAddress(entry.address)) continue;
      result.push({ name, address: entry.address, family, internal: false });
    }
  }
  return result.filter((entry, index, all) => all.findIndex((candidate) => candidate.address === entry.address) === index);
}

export function selectSafeLanInterface(
  interfaces: readonly WebLanInterface[] = listSafeLanInterfaces(),
  preferredName?: string,
): WebLanInterface | null {
  if (preferredName) {
    const preferred = interfaces.find((entry) => entry.name === preferredName);
    if (preferred) return preferred;
  }
  return interfaces[0] ?? null;
}

export function normalizeAddress(value: string | undefined): string {
  const normalized = (value ?? "unknown").toLowerCase();
  return normalized.startsWith("::ffff:") ? normalized.slice("::ffff:".length) : normalized;
}

export function isLoopbackAddress(value: string | undefined): boolean {
  const normalized = normalizeAddress(value);
  return normalized === "127.0.0.1" || normalized === "::1" || normalized.startsWith("127.");
}

function derivePin(pin: string, salt: Buffer): Buffer {
  return scryptSync(pin, salt, PIN_KEY_BYTES, { N: 16_384, r: 8, p: 1 });
}

function tokenHash(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("base64url");
}

function normalizePermissions(value: readonly WebControlPermission[]): readonly WebControlPermission[] {
  const allowed = new Set<WebControlPermission>(["read", "control", "push"]);
  const permissions = [...new Set(value)].filter((permission): permission is WebControlPermission => allowed.has(permission));
  return permissions.length > 0 ? permissions : ["read"];
}

function recordFailureState(
  state: FailureState | undefined,
  now: number,
  limit: number,
  cooldownMs: number,
): FailureState {
  const current = !state || now - state.windowStartedAt >= PIN_ATTEMPT_WINDOW_MS
    ? { windowStartedAt: now, count: 0, cooldownUntil: 0 }
    : state;
  const count = current.count + 1;
  return {
    windowStartedAt: current.windowStartedAt,
    count,
    cooldownUntil: count >= limit ? now + cooldownMs : current.cooldownUntil,
  };
}

function readPersistedState(value: unknown): { allowLan: boolean; pin: WebSecurityPersistedState["pin"] | null } {
  if (!isRecord(value)) return { allowLan: false, pin: null };
  const pin = isRecord(value.pin)
    && value.pin.algorithm === "scrypt"
    && typeof value.pin.salt === "string"
    && typeof value.pin.digest === "string"
    ? { algorithm: "scrypt" as const, salt: value.pin.salt, digest: value.pin.digest }
    : null;
  return { allowLan: value.allowLan === true, pin };
}

function decodePin(value: NonNullable<WebSecurityPersistedState["pin"]>): PersistedPin | null {
  try {
    const salt = Buffer.from(value.salt, "base64url");
    const digest = Buffer.from(value.digest, "base64url");
    if (salt.byteLength !== PIN_SALT_BYTES || digest.byteLength !== PIN_KEY_BYTES) return null;
    return { algorithm: value.algorithm, salt, digest };
  } catch {
    return null;
  }
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isInteger(value) && value > 0 ? value : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
