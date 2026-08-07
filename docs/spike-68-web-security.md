# Spike 68: Web PIN, LAN binding, and session security

## Status

- Status: complete
- Dependency: G67 `checkpoint: complete G67 web console`
- Checkpoint: `checkpoint: complete G68 web PIN security`

## Decisions

- The default listener remains `127.0.0.1`; no router mapping, NAT-PMP, UPnP IGD,
  public domain, cloud relay, or wildcard bind is used.
- LAN mode is explicit and persisted as `Allow LAN Control`, defaulting to `false`.
  Enabling it selects one private IPv4 interface and rejects public, loopback,
  link-local, VPN, Docker, Hyper-V, virtual, and tunnel-like interface names.
- PINs are six digits from Node's cryptographically secure `randomInt`. Only a
  scrypt digest and random salt are stored in the existing settings table. The
  generated PIN is available once in process memory for setup or regeneration;
  it is not persisted.
- A successful PIN login creates a random 32-byte base64url token, stores only a
  SHA-256 token lookup hash in memory, and returns an HttpOnly, SameSite=Strict
  cookie. `Secure` is added only for an HTTPS request; the LAN endpoint is HTTP
  and is not presented as HTTPS.
- Sessions expire, can be individually revoked, and can all be revoked. Their
  visible projection contains only an opaque session id, timestamps, permissions,
  and current-session state; no IP, user-agent, or device fingerprint is stored.
- Permissions are limited to `read`, `control`, and `push`. Search uses `read`;
  Push is a separate permission. Local loopback remains the trusted management
  boundary while LAN requests require a valid session and route permission.
- PIN login is protected by per-IP and global failure windows with cooldowns.
  The Web API keeps exact-Origin checks, same-origin CSRF for state changes,
  bounded JSON bodies, rate classes, and bounded WebSocket connections/messages.
- Responses add CSP, `X-Content-Type-Options`, `Referrer-Policy`, frame
  restrictions, and `Cache-Control: no-store`. No PIN hash or session token is
  included in status projections.
- The Push server remains loopback-only by default. Its optional LAN binding is
  gated by the same private-interface rules and requires a Web session with the
  `push` permission, exact Origin, rate limiting, bounded payloads, and the
  existing URL/DNS/redirect SSRF checks.

## Verification focus

- localhost default and explicit LAN enable/disable failure paths;
- secure PIN generation, salted KDF storage, wrong PIN, per-IP/global cooldown,
  valid login, expiry, permissions, revoke, and revoke-all;
- exact Origin/CORS, CSRF, security headers, payload limits, WebSocket auth,
  private-interface filtering, and Push SSRF/rate/auth boundaries;
- Electron shutdown/restart and packaged first/restart E2E.

## Known boundary

The first implementation does not generate QR codes and does not collect device
identity. Pairing is browser PIN entry; any future QR must contain only a local
address and short-lived pairing id, never a permanent secret.
