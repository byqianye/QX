import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { afterEach, describe, expect, it } from "vitest";

import { CastMediaBridge } from "../src/cast/cast-media-bridge.js";
import {
  CastService,
  type SsdpTransport,
} from "../src/cast/cast-service.js";

const servers: Server[] = [];
const bridges: CastMediaBridge[] = [];

afterEach(async () => {
  while (bridges.length > 0) await bridges.pop()?.close();
  while (servers.length > 0) await close(servers.pop() as Server);
});

describe("CastService", () => {
  it("discovers a MediaRenderer, parses capabilities, and controls AVTransport", async () => {
    const calls: string[] = [];
    const device = await createDeviceServer(calls);
    const transport: SsdpTransport = {
      search: async () => [{
        headers: {
          location: device.descriptionUrl,
          usn: "uuid:fixture-renderer::urn:schemas-upnp-org:device:MediaRenderer:1",
          st: "urn:schemas-upnp-org:device:MediaRenderer:1",
        },
      }],
    };
    const service = new CastService({
      transport,
      bridge: createBridge(),
    });

    const state = await service.discover();
    expect(state.discoveryStatus).toBe("ready");
    expect(state.devices).toHaveLength(1);
    expect(state.devices[0]).toMatchObject({
      deviceId: "uuid:fixture-renderer",
      friendlyName: "Fixture TV",
      model: "Fixture Model",
      manufacturer: "Fixture Manufacturer",
    });
    expect(state.devices[0]?.capabilities).toMatchObject({
      seek: true,
      getTransportInfo: true,
      getPositionInfo: true,
    });

    const session = await service.cast({
      deviceId: "uuid:fixture-renderer",
      media: { url: device.mediaUrl, title: "Test Movie", headers: { Cookie: "session=secret" } },
    });
    expect(session.session?.state).toBe("playing");
    expect(calls[0]).toMatch(/^SetAVTransportURI:http:\/\/127\.0\.0\.1:/u);
    expect(calls[1]).toBe("Play");

    await service.pause();
    await service.seek(42);
    await service.play();
    const position = await service.refreshPosition();
    const transportState = await service.refreshTransport();
    await service.stop();
    expect(position).toMatchObject({ position: 42, duration: 600 });
    expect(transportState).toBe("PLAYING");
    expect(calls.slice(1)).toEqual(["Play", "Pause", "Seek", "Play", "GetPositionInfo", "GetTransportInfo", "Stop"]);
    expect(service.uiState().session?.state).toBe("stopped");
  });

  it("uses a session bridge for private/headered media without sending Cookie to the device", async () => {
    const calls: string[] = [];
    let bridgeUrl: string | null = null;
    const upstream = await createMediaServer();
    const device = await createDeviceServer(calls, async (request) => {
      if (request.startsWith("SetAVTransportURI:")) {
        const url = request.slice("SetAVTransportURI:".length);
        bridgeUrl = url;
        const response = await fetch(url);
        expect(response.status).toBe(200);
        expect(await response.text()).toBe("bridge-media");
      }
    });
    const bridge = createBridge();
    const service = new CastService({
      transport: staticTransport(device.descriptionUrl),
      bridge,
    });
    bridges.push(bridge);
    await service.discover();
    await service.cast({
      deviceId: "uuid:fixture-renderer",
      media: {
        url: upstream.url,
        title: "Private Movie",
        headers: { Cookie: "session=secret", Referer: "https://source.example/" },
      },
    });

    expect(bridgeUrl).toMatch(/\/__qx_cast\/[A-Za-z0-9_-]{32,}\/media$/u);
    expect(bridgeUrl).not.toContain("session=secret");
    expect(upstream.seenHeaders.cookie).toBe("session=secret");
    expect(upstream.seenHeaders.referer).toBe("https://source.example/");
    expect(device.controlHeaders.cookie).toBeUndefined();
    expect(calls[0]).toMatch(/^SetAVTransportURI:http:\/\/127\.0\.0\.1:/u);
  });

  it("rejects unsafe locations and XML entities, reports unsupported actions, and marks lost devices once", async () => {
    const unsafe = new CastService({
      transport: {
        search: async () => [{ headers: { location: "http://example.com/description.xml" } }],
      },
      resolveAddresses: async () => ["93.184.216.34"],
      bridge: createBridge(),
    });
    const unsafeState = await unsafe.discover();
    expect(unsafeState.devices).toHaveLength(0);
    expect(unsafeState.error?.code).toBe("DLNA_LOCATION_BLOCKED");

    const malicious = new CastService({
      transport: staticTransport("http://127.0.0.1:9/description.xml"),
      fetchImpl: async () => new Response("<!DOCTYPE root [<!ENTITY xxe SYSTEM 'file:///secret'>]><root />"),
      bridge: createBridge(),
    });
    const maliciousState = await malicious.discover();
    expect(maliciousState.error?.code).toBe("DLNA_XML_UNSAFE");

    const oversized = new CastService({
      transport: staticTransport("http://127.0.0.1:9/description.xml"),
      fetchImpl: async () => new Response("x".repeat(64)),
      maxXmlBytes: 32,
      bridge: createBridge(),
    });
    const oversizedState = await oversized.discover();
    expect(oversizedState.error?.code).toBe("DLNA_XML_TOO_LARGE");

    const timeout = new CastService({
      transport: staticTransport("http://127.0.0.1:9/description.xml"),
      requestTimeoutMs: 10,
      fetchImpl: async (_url, init) => new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("timeout", "AbortError")), { once: true });
      }),
      bridge: createBridge(),
    });
    const timeoutState = await timeout.discover();
    expect(timeoutState.error?.code).toBe("DLNA_TIMEOUT");

    const calls: string[] = [];
    const device = await createDeviceServer(calls, undefined, { seek: false });
    const service = new CastService({ transport: staticTransport(device.descriptionUrl), bridge: createBridge() });
    await service.discover();
    await service.cast({ deviceId: "uuid:fixture-renderer", media: { url: device.mediaUrl, title: "Movie" } });
    await expect(service.seek(3)).rejects.toMatchObject({ code: "DLNA_UNSUPPORTED" });
    service.markDeviceLost("uuid:fixture-renderer");
    expect(service.uiState().session?.error?.code).toBe("DLNA_DEVICE_LOST");
    expect(service.uiState().session?.state).toBe("error");
    await service.disconnect();
    expect(service.uiState().session).toBeNull();
  });
});

describe("CastMediaBridge", () => {
  it("binds only while a session exists, expires its high-entropy token, and closes cleanly", async () => {
    let now = Date.now();
    const upstream = await createMediaServer();
    const bridge = createBridge({ now: () => now, sessionTtlMs: 100 });
    bridges.push(bridge);
    const session = await bridge.createSession({ url: upstream.url, headers: { Cookie: "secret" } });
    expect(session.url).toMatch(/\/__qx_cast\/[A-Za-z0-9_-]{32,}\/media$/u);
    expect(await fetch(session.url)).toMatchObject({ status: 200 });
    now += 101;
    expect(await fetch(session.url)).toMatchObject({ status: 410 });
    await session.close();
    await expect(fetch(session.url)).rejects.toThrow();
    const second = await bridge.createSession({ url: upstream.url });
    const bound = new URL(second.url).origin;
    await bridge.close();
    await expect(fetch(bound)).rejects.toThrow();
  });
});

function createBridge(options: ConstructorParameters<typeof CastMediaBridge>[0] = {}): CastMediaBridge {
  const bridge = new CastMediaBridge({ advertisedHost: "127.0.0.1", ...options });
  if (!bridges.includes(bridge)) bridges.push(bridge);
  return bridge;
}

function staticTransport(location: string): SsdpTransport {
  return { search: async () => [{ headers: { location, st: "urn:schemas-upnp-org:device:MediaRenderer:1" } }] };
}

async function createDeviceServer(
  calls: string[],
  onAction?: (action: string) => void | Promise<void>,
  options: { seek?: boolean } = {},
): Promise<{ descriptionUrl: string; mediaUrl: string; controlHeaders: Record<string, string | undefined> }> {
  const controlHeaders: Record<string, string | undefined> = {};
  const server = createServer((request, response) => {
    void handleDeviceRequest(request, response, calls, onAction, { ...options, controlHeaders });
  });
  servers.push(server);
  await listen(server);
  const address = server.address() as { port: number };
  const base = `http://127.0.0.1:${address.port}`;
  return { descriptionUrl: `${base}/description.xml`, mediaUrl: `${base}/media.mp4`, controlHeaders };
}

async function handleDeviceRequest(
  request: IncomingMessage,
  response: ServerResponse,
  calls: string[],
  onAction: ((action: string) => void | Promise<void>) | undefined,
  options: { seek?: boolean; controlHeaders?: Record<string, string | undefined> },
): Promise<void> {
  const path = new URL(request.url ?? "/", "http://127.0.0.1/").pathname;
  if (path === "/description.xml") {
    response.writeHead(200, { "content-type": "text/xml" });
    response.end(descriptionXml());
    return;
  }
  if (path === "/scpd.xml") {
    response.writeHead(200, { "content-type": "text/xml" });
    response.end(scpdXml(options.seek !== false));
    return;
  }
  if (path === "/media.mp4") {
    response.writeHead(200, { "content-type": "video/mp4", "set-cookie": "device=never" });
    response.end("fixture-media");
    return;
  }
  if (path !== "/control") {
    response.writeHead(404).end();
    return;
  }
  if (options.controlHeaders) {
    options.controlHeaders.cookie = request.headers.cookie;
    options.controlHeaders.referer = request.headers.referer;
  }
  const body = await readBody(request);
  const action = body.match(/#?([A-Za-z]+)\s+xmlns:u=/u)?.[1] ?? "Unknown";
  calls.push(action === "SetAVTransportURI"
    ? `${action}:${body.match(/<CurrentURI>([^<]+)<\/CurrentURI>/u)?.[1] ?? ""}`
    : action);
  await onAction?.(calls.at(-1) ?? action);
  const position = body.match(/<Target>([^<]+)<\/Target>/u)?.[1] ?? "00:00:42";
  response.writeHead(200, { "content-type": "text/xml" });
  response.end(soapResponse(action, position));
}

function descriptionXml(): string {
  return `<?xml version="1.0"?><root><device><deviceType>urn:schemas-upnp-org:device:MediaRenderer:1</deviceType><friendlyName>Fixture TV</friendlyName><manufacturer>Fixture Manufacturer</manufacturer><modelName>Fixture Model</modelName><UDN>uuid:fixture-renderer</UDN><serviceList><service><serviceType>urn:schemas-upnp-org:service:AVTransport:1</serviceType><SCPDURL>/scpd.xml</SCPDURL><controlURL>/control</controlURL></service></serviceList></device></root>`;
}

function scpdXml(seek: boolean): string {
  const actions = ["SetAVTransportURI", "Play", "Pause", "Stop", "GetTransportInfo", "GetPositionInfo", ...(seek ? ["Seek"] : [])];
  return `<scpd><actionList>${actions.map((action) => `<action><name>${action}</name></action>`).join("")}</actionList></scpd>`;
}

function soapResponse(action: string, position: string): string {
  if (action === "GetPositionInfo") {
    return `<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><u:GetPositionInfoResponse xmlns:u="urn:schemas-upnp-org:service:AVTransport:1"><TrackDuration>00:10:00</TrackDuration><RelTime>${position === "00:00:42" ? position : "00:00:42"}</RelTime></u:GetPositionInfoResponse></s:Body></s:Envelope>`;
  }
  if (action === "GetTransportInfo") {
    return `<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><u:GetTransportInfoResponse xmlns:u="urn:schemas-upnp-org:service:AVTransport:1"><CurrentTransportState>PLAYING</CurrentTransportState></u:GetTransportInfoResponse></s:Body></s:Envelope>`;
  }
  return `<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><u:${action}Response xmlns:u="urn:schemas-upnp-org:service:AVTransport:1" /></s:Body></s:Envelope>`;
}

async function createMediaServer(): Promise<{ url: string; seenHeaders: Record<string, string | undefined> }> {
  const seenHeaders: Record<string, string | undefined> = {};
  const server = createServer((request, response) => {
    seenHeaders.cookie = request.headers.cookie;
    seenHeaders.referer = request.headers.referer;
    response.writeHead(200, { "content-type": "video/mp4" });
    response.end("bridge-media");
  });
  servers.push(server);
  await listen(server);
  const address = server.address() as { port: number };
  return { url: `http://127.0.0.1:${address.port}/media.mp4`, seenHeaders };
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

async function listen(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
}

async function close(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}
