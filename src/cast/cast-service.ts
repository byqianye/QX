import { createSocket } from "node:dgram";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { SaxesParser } from "saxes";

import {
  CastMediaBridge,
  type CastBridgeSession,
  type CastBridgeSource,
} from "./cast-media-bridge.js";
import {
  DEFAULT_CAST_CAPABILITIES,
  EMPTY_CAST_UI_STATE,
  type CastCapabilities,
  type CastDevice,
  type CastMediaSource,
  type CastSessionState,
  type CastUiState,
} from "./cast-types.js";

export interface SsdpResponse {
  headers: Record<string, string>;
  address?: string;
}

export interface SsdpTransport {
  search(searchTarget: string, timeoutMs: number): Promise<readonly SsdpResponse[]>;
  close?(): Promise<void> | void;
}

export interface UdpSsdpTransportOptions {
  address?: string;
  port?: number;
  bindHost?: string;
}

export class UdpSsdpTransport implements SsdpTransport {
  private readonly address: string;
  private readonly port: number;
  private readonly bindHost: string;

  public constructor(options: UdpSsdpTransportOptions = {}) {
    this.address = options.address ?? "239.255.255.250";
    this.port = options.port ?? 1900;
    this.bindHost = options.bindHost ?? "0.0.0.0";
  }

  public async search(searchTarget: string, timeoutMs: number): Promise<readonly SsdpResponse[]> {
    const socket = createSocket("udp4");
    const responses: SsdpResponse[] = [];
    const seen = new Set<string>();
    const payload = [
      "M-SEARCH * HTTP/1.1",
      `HOST: ${this.address}:${this.port}`,
      'MAN: "ssdp:discover"',
      "MX: 1",
      `ST: ${searchTarget}`,
      "",
      "",
    ].join("\r\n");
    return await new Promise<readonly SsdpResponse[]>((resolve, reject) => {
      const timer = setTimeout(() => finish(), Math.max(100, timeoutMs));
      const finish = (): void => {
        clearTimeout(timer);
        socket.close();
        resolve(responses);
      };
      socket.on("error", (error) => {
        clearTimeout(timer);
        socket.close();
        reject(error);
      });
      socket.on("message", (message, remote) => {
        const parsed = parseSsdpResponse(message.toString("utf8"));
        const key = `${parsed.headers.location ?? ""}|${parsed.headers.usn ?? ""}`;
        if (!parsed.headers.location || seen.has(key)) return;
        seen.add(key);
        responses.push({ ...parsed, address: remote.address });
      });
      socket.bind(0, this.bindHost, () => {
        socket.send(Buffer.from(payload, "utf8"), this.port, this.address, (error) => {
          if (error) {
            clearTimeout(timer);
            socket.close();
            reject(error);
          }
        });
      });
    });
  }
}

export interface CastServiceOptions {
  transport?: SsdpTransport;
  bridge?: CastMediaBridge;
  fetchImpl?: typeof fetch;
  resolveAddresses?: (hostname: string) => Promise<readonly string[]>;
  now?: () => number;
  discoveryWindowMs?: number;
  requestTimeoutMs?: number;
  maxXmlBytes?: number;
}

export interface CastRequest {
  deviceId: string;
  media: CastMediaSource;
  startPosition?: number;
}

export class CastServiceError extends Error {
  public readonly code: string;

  public constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "CastServiceError";
    this.code = code;
  }
}

interface RendererDevice extends CastDevice {
  controlUrl: string;
  serviceType: string;
}

interface InternalSession {
  publicState: CastSessionState;
  deviceId: string;
  bridgeSessions: CastBridgeSession[];
}

interface XmlFrame {
  name: string;
  text: string;
  fields: Record<string, string>;
}

interface ParsedService {
  serviceType: string;
  controlUrl: string;
  scpdUrl: string;
}

const MEDIA_RENDERER_ST = "urn:schemas-upnp-org:device:MediaRenderer:1";
const AV_TRANSPORT_TYPE = "urn:schemas-upnp-org:service:AVTransport:1";
const SOAP_ACTIONS = new Set([
  "SetAVTransportURI",
  "Play",
  "Pause",
  "Stop",
  "Seek",
  "GetTransportInfo",
  "GetPositionInfo",
]);
const CAPABILITY_ACTIONS: Record<keyof CastCapabilities, string> = {
  setAvTransportUri: "SetAVTransportURI",
  play: "Play",
  pause: "Pause",
  stop: "Stop",
  seek: "Seek",
  getTransportInfo: "GetTransportInfo",
  getPositionInfo: "GetPositionInfo",
};
const DEFAULT_DISCOVERY_WINDOW_MS = 1_500;
const DEFAULT_REQUEST_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_XML_BYTES = 128 * 1024;

export class CastService {
  private readonly transport: SsdpTransport;
  private readonly bridge: CastMediaBridge;
  private readonly fetchImpl: typeof fetch;
  private readonly resolveAddresses: (hostname: string) => Promise<readonly string[]>;
  private readonly now: () => number;
  private readonly discoveryWindowMs: number;
  private readonly requestTimeoutMs: number;
  private readonly maxXmlBytes: number;
  private readonly devices = new Map<string, RendererDevice>();
  private discoveryStatus: CastUiState["discoveryStatus"] = "idle";
  private lastError: { code: string; message: string } | null = null;
  private session: InternalSession | null = null;
  private discovering = false;

  public constructor(options: CastServiceOptions = {}) {
    this.transport = options.transport ?? new UdpSsdpTransport();
    this.bridge = options.bridge ?? new CastMediaBridge();
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.resolveAddresses = options.resolveAddresses ?? resolveHostAddresses;
    this.now = options.now ?? Date.now;
    this.discoveryWindowMs = positive(options.discoveryWindowMs, DEFAULT_DISCOVERY_WINDOW_MS);
    this.requestTimeoutMs = positive(options.requestTimeoutMs, DEFAULT_REQUEST_TIMEOUT_MS);
    this.maxXmlBytes = positive(options.maxXmlBytes, DEFAULT_MAX_XML_BYTES);
  }

  public uiState(): CastUiState {
    return {
      discoveryStatus: this.discoveryStatus,
      devices: [...this.devices.values()]
        .sort((left, right) => left.friendlyName.localeCompare(right.friendlyName))
        .map((device) => ({
          deviceId: device.deviceId,
          friendlyName: device.friendlyName,
          location: device.location,
          model: device.model,
          manufacturer: device.manufacturer,
          lastSeen: device.lastSeen,
          capabilities: { ...device.capabilities },
        })),
      session: this.session ? cloneSession(this.session.publicState) : null,
      error: this.lastError ? { ...this.lastError } : null,
    };
  }

  public async discover(): Promise<CastUiState> {
    if (this.discovering) return this.uiState();
    this.discovering = true;
    this.discoveryStatus = "searching";
    this.lastError = null;
    try {
      const responses = await this.transport.search(MEDIA_RENDERER_ST, this.discoveryWindowMs);
      const found = new Map<string, RendererDevice>();
      let firstError: CastServiceError | null = null;
      for (const response of responses) {
        const rawLocation = headerValue(response.headers, "location");
        if (!rawLocation || !isRendererResponse(response)) continue;
        try {
          const device = await this.readDevice(rawLocation, headerValue(response.headers, "usn"));
          found.set(device.deviceId, device);
        } catch (error) {
          firstError ??= asCastError(error, "DLNA_DISCOVERY_FAILED", "DLNA 设备发现失败。");
        }
      }
      this.devices.clear();
      for (const [id, device] of found) this.devices.set(id, device);
      this.discoveryStatus = "ready";
      this.lastError = firstError ? { code: firstError.code, message: firstError.message } : null;
      if (this.session && !this.devices.has(this.session.deviceId)) this.markDeviceLost(this.session.deviceId);
      return this.uiState();
    } catch (error) {
      const castError = asCastError(error, "DLNA_DISCOVERY_FAILED", "DLNA 设备发现失败。");
      this.discoveryStatus = "error";
      this.lastError = { code: castError.code, message: castError.message };
      return this.uiState();
    } finally {
      this.discovering = false;
    }
  }

  public async cast(request: CastRequest): Promise<CastUiState> {
    const device = this.devices.get(request.deviceId);
    if (!device) throw this.fail("DLNA_DEVICE_NOT_FOUND", "未找到所选 DLNA 设备。");
    const source = validateMedia(request.media);
    await this.disconnect();
    const startedAt = this.now();
    const publicState: CastSessionState = {
      device: publicDevice(device),
      media: {
        title: source.title,
        contentType: source.contentType ?? contentTypeFor(source.url),
      },
      state: "connecting",
      startedAt,
      lastPosition: safePosition(request.startPosition),
      error: null,
    };
    const internal: InternalSession = { publicState, deviceId: device.deviceId, bridgeSessions: [] };
    this.session = internal;
    try {
      const mediaUrl = await this.mediaUrl(source, internal);
      await this.soap(device, "SetAVTransportURI", {
        InstanceID: "0",
        CurrentURI: mediaUrl,
        CurrentURIMetaData: didlMetadata(source.title, mediaUrl, source.contentType ?? contentTypeFor(source.url), await this.subtitleUrl(source, internal)),
      });
      await this.soap(device, "Play", { InstanceID: "0", Speed: "1" });
      publicState.state = "playing";
      if (publicState.lastPosition > 0 && device.capabilities.seek) {
        await this.soap(device, "Seek", { InstanceID: "0", Unit: "REL_TIME", Target: formatTime(publicState.lastPosition) });
      }
      return this.uiState();
    } catch (error) {
      const castError = asCastError(error, "DLNA_CAST_FAILED", "DLNA 投屏失败。");
      publicState.state = "error";
      publicState.error = { code: castError.code, message: castError.message };
      await this.closeBridgeSessions(internal);
      throw castError;
    }
  }

  public async play(): Promise<CastUiState> {
    return this.runAction("play", "Play", { InstanceID: "0" }, (state) => { state.state = "playing"; });
  }

  public async pause(): Promise<CastUiState> {
    return this.runAction("pause", "Pause", { InstanceID: "0" }, (state) => { state.state = "paused"; });
  }

  public async stop(): Promise<CastUiState> {
    const session = this.requireSession();
    if (session.publicState.state !== "error") {
      try {
        await this.soap(this.requireDevice(session), "Stop", { InstanceID: "0" });
      } catch (error) {
        this.markSessionError(session, asCastError(error, "DLNA_DEVICE_LOST", "DLNA 设备已离线。"));
      }
    }
    session.publicState.state = session.publicState.error ? "error" : "stopped";
    await this.closeBridgeSessions(session);
    return this.uiState();
  }

  public async seek(position: number): Promise<CastUiState> {
    if (!Number.isFinite(position) || position < 0) throw this.fail("DLNA_SEEK_INVALID", "DLNA 跳转位置无效。");
    const result = await this.runAction(
      "seek",
      "Seek",
      { InstanceID: "0", Unit: "REL_TIME", Target: formatTime(position) },
      (state) => { state.lastPosition = position; },
    );
    return result;
  }

  public async refreshPosition(): Promise<{ position: number; duration: number | null; state: string | null }> {
    const session = this.requireSession();
    const device = this.requireDevice(session);
    if (!device.capabilities.getPositionInfo) throw this.fail("DLNA_UNSUPPORTED", "设备不支持 GetPositionInfo。");
    try {
      const xml = await this.soap(device, "GetPositionInfo", { InstanceID: "0" });
      const values = parseXmlFields(xml);
      const position = parseTime(values.reltime) ?? session.publicState.lastPosition;
      const duration = parseTime(values.trackduration);
      session.publicState.lastPosition = position;
      return { position, duration, state: values.currenttransportstate ?? null };
    } catch (error) {
      const castError = asCastError(error, "DLNA_DEVICE_LOST", "DLNA device was lost.");
      this.markSessionError(session, castError);
      throw castError;
    }
  }

  public async refreshTransport(): Promise<string | null> {
    const session = this.requireSession();
    const device = this.requireDevice(session);
    if (!device.capabilities.getTransportInfo) throw this.fail("DLNA_UNSUPPORTED", "设备不支持 GetTransportInfo。");
    try {
      const xml = await this.soap(device, "GetTransportInfo", { InstanceID: "0" });
      const transportState = parseXmlFields(xml).currenttransportstate?.toUpperCase() ?? null;
      const mappedState = castStateForTransport(transportState);
      if (mappedState) session.publicState.state = mappedState;
      return transportState;
    } catch (error) {
      const castError = asCastError(error, "DLNA_DEVICE_LOST", "DLNA device was lost.");
      this.markSessionError(session, castError);
      throw castError;
    }
  }

  public markDeviceLost(deviceId: string): void {
    if (!this.session || this.session.deviceId !== deviceId) return;
    this.markSessionError(this.session, this.fail("DLNA_DEVICE_LOST", "DLNA 设备已离线。"));
  }

  public async disconnect(): Promise<CastUiState> {
    const session = this.session;
    this.session = null;
    if (session) await this.closeBridgeSessions(session);
    return this.uiState();
  }

  public async close(): Promise<void> {
    await this.disconnect();
    await this.transport.close?.();
    await this.bridge.close();
  }

  private async runAction(
    key: keyof CastCapabilities,
    action: string,
    arguments_: Record<string, string>,
    update: (state: CastSessionState) => void,
  ): Promise<CastUiState> {
    const session = this.requireSession();
    const device = this.requireDevice(session);
    this.assertCapability(device, key);
    try {
      await this.soap(device, action, arguments_);
      update(session.publicState);
      session.publicState.error = null;
      return this.uiState();
    } catch (error) {
      const castError = asCastError(error, "DLNA_DEVICE_LOST", "DLNA 设备已离线。");
      this.markSessionError(session, castError);
      throw castError;
    }
  }

  private async readDevice(locationValue: string, usn: string | undefined): Promise<RendererDevice> {
    const location = await this.safeLocalUrl(locationValue);
    const xml = await this.fetchText(location.toString());
    const parsed = parseDeviceXml(xml);
    const service = parsed.services.find((candidate) => candidate.serviceType.toLowerCase().includes("avtransport"));
    if (!service) throw this.fail("DLNA_AVTRANSPORT_MISSING", "设备没有 AVTransport 服务。");
    const controlUrl = this.resolveSameOrigin(location, service.controlUrl);
    const scpdUrl = this.resolveSameOrigin(location, service.scpdUrl);
    let capabilities = { ...DEFAULT_CAST_CAPABILITIES };
    try {
      const scpd = await this.fetchText(scpdUrl);
      capabilities = capabilitiesFromActions(parseActionNames(scpd));
    } catch (error) {
      if (asCastError(error, "DLNA_SCPD_FAILED", "DLNA capability description failed.").code === "DLNA_XML_UNSAFE") throw error;
    }
    const deviceId = parsed.udn || usn?.split("::")[0]?.trim() || location.toString();
    return {
      deviceId,
      friendlyName: parsed.friendlyName || deviceId,
      location: location.toString(),
      model: parsed.modelName || "MediaRenderer",
      manufacturer: parsed.manufacturer || "Unknown",
      lastSeen: this.now(),
      capabilities,
      controlUrl,
      serviceType: service.serviceType || AV_TRANSPORT_TYPE,
    };
  }

  private async mediaUrl(source: CastMediaSource, session: InternalSession): Promise<string> {
    if (!needsBridge(source.url, source.headers)) return source.url;
    const bridgeSource: CastBridgeSource = {
      url: source.url,
      ...(source.headers ? { headers: source.headers } : {}),
      ...(source.contentType ? { contentType: source.contentType } : {}),
    };
    const bridgeSession = await this.bridge.createSession(bridgeSource);
    session.bridgeSessions.push(bridgeSession);
    return bridgeSession.url;
  }

  private async subtitleUrl(source: CastMediaSource, session: InternalSession): Promise<string | null> {
    if (!source.subtitle) return null;
    if (!needsBridge(source.subtitle.url, source.subtitle.headers)) return source.subtitle.url;
    const subtitleSource: CastBridgeSource = {
      url: source.subtitle.url,
      ...(source.subtitle.headers ? { headers: source.subtitle.headers } : {}),
      ...(source.subtitle.contentType ? { contentType: source.subtitle.contentType } : {}),
    };
    const bridgeSession = await this.bridge.createSession(subtitleSource);
    session.bridgeSessions.push(bridgeSession);
    return bridgeSession.url;
  }

  private async soap(device: RendererDevice, action: string, arguments_: Record<string, string>): Promise<string> {
    if (!SOAP_ACTIONS.has(action)) throw this.fail("DLNA_ACTION_INVALID", "DLNA 操作不受支持。");
    const capability = (Object.entries(CAPABILITY_ACTIONS) as Array<[keyof CastCapabilities, string]>).find(([, value]) => value === action)?.[0];
    if (capability) this.assertCapability(device, capability);
    const body = Object.entries(arguments_)
      .map(([key, value]) => `<${key}>${escapeXml(value)}</${key}>`)
      .join("");
    const envelope = `<?xml version="1.0" encoding="utf-8"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><u:${action} xmlns:u="${escapeXml(device.serviceType)}">${body}</u:${action}></s:Body></s:Envelope>`;
    let response: Response;
    try {
      response = await this.fetchWithTimeout(device.controlUrl, {
        method: "POST",
        headers: {
          "content-type": "text/xml; charset=utf-8",
          soapaction: `"${device.serviceType}#${action}"`,
        },
        body: envelope,
      });
    } catch {
      throw this.fail("DLNA_DEVICE_LOST", "DLNA 设备已离线。");
    }
    const text = await readResponseText(response, this.maxXmlBytes);
    if (!response.ok) {
      if (/<(?:[^:>]+:)?Fault\b/iu.test(text)) throw this.fail("DLNA_SOAP_FAULT", "DLNA 设备拒绝了操作。");
      throw this.fail("DLNA_DEVICE_LOST", "DLNA 设备未响应。");
    }
    parseXmlFields(text);
    return text;
  }

  private async fetchText(url: string): Promise<string> {
    const response = await this.fetchWithTimeout(url, { headers: { accept: "text/xml, application/xml" } });
    if (!response.ok) throw this.fail("DLNA_DESCRIPTION_FAILED", "DLNA 设备描述请求失败。");
    return readResponseText(response, this.maxXmlBytes);
  }

  private async fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
    const signal = AbortSignal.timeout(this.requestTimeoutMs);
    try {
      return await this.fetchImpl(url, { ...init, redirect: "manual", signal });
    } catch {
      throw this.fail("DLNA_TIMEOUT", "DLNA 请求超时。");
    }
  }

  private async safeLocalUrl(value: string): Promise<URL> {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw this.fail("DLNA_LOCATION_INVALID", "DLNA location 地址无效。");
    }
    if (url.protocol !== "http:" || url.username || url.password || value.length > 2048) {
      throw this.fail("DLNA_LOCATION_BLOCKED", "DLNA location 只允许本地 HTTP 地址。");
    }
    const addresses = await this.resolveAddresses(url.hostname);
    if (addresses.length === 0 || addresses.some((address) => !isLocalAddress(address))) {
      throw this.fail("DLNA_LOCATION_BLOCKED", "DLNA location 不在本地网络内。");
    }
    return url;
  }

  private resolveSameOrigin(base: URL, value: string): string {
    let resolved: URL;
    try {
      resolved = new URL(value, base);
    } catch {
      throw this.fail("DLNA_CONTROL_URL_INVALID", "DLNA 控制地址无效。");
    }
    if (resolved.origin !== base.origin || resolved.protocol !== "http:") {
      throw this.fail("DLNA_CONTROL_URL_INVALID", "DLNA 控制地址超出设备来源。");
    }
    return resolved.toString();
  }

  private requireSession(): InternalSession {
    if (!this.session) throw this.fail("DLNA_SESSION_MISSING", "当前没有投屏会话。");
    return this.session;
  }

  private requireDevice(session: InternalSession): RendererDevice {
    const device = this.devices.get(session.deviceId);
    if (!device) {
      this.markSessionError(session, this.fail("DLNA_DEVICE_LOST", "DLNA 设备已离线。"));
      throw this.fail("DLNA_DEVICE_LOST", "DLNA 设备已离线。");
    }
    return device;
  }

  private assertCapability(device: RendererDevice, key: keyof CastCapabilities): void {
    if (!device.capabilities[key]) throw this.fail("DLNA_UNSUPPORTED", `设备不支持 ${CAPABILITY_ACTIONS[key]}。`);
  }

  private markSessionError(session: InternalSession, error: CastServiceError): void {
    session.publicState.state = "error";
    session.publicState.error = { code: error.code, message: error.message };
    void this.closeBridgeSessions(session);
  }

  private async closeBridgeSessions(session: InternalSession): Promise<void> {
    const sessions = session.bridgeSessions.splice(0);
    await Promise.all(sessions.map((bridgeSession) => bridgeSession.close()));
  }

  private fail(code: string, message: string): CastServiceError {
    return new CastServiceError(code, message);
  }
}

function parseSsdpResponse(value: string): { headers: Record<string, string> } {
  const headers: Record<string, string> = {};
  for (const line of value.split(/\r?\n/u).slice(1)) {
    const index = line.indexOf(":");
    if (index <= 0) continue;
    const name = line.slice(0, index).trim().toLowerCase();
    const headerValue = line.slice(index + 1).trim();
    if (name && headerValue && !/[\r\n]/u.test(headerValue)) headers[name] = headerValue;
  }
  return { headers };
}

function isRendererResponse(response: SsdpResponse): boolean {
  const st = headerValue(response.headers, "st") ?? "";
  const usn = headerValue(response.headers, "usn") ?? "";
  return !st && !usn || /mediaRenderer/i.test(st) || /mediaRenderer/i.test(usn);
}

function headerValue(headers: Record<string, string>, name: string): string | undefined {
  const expected = name.toLowerCase();
  return Object.entries(headers).find(([key]) => key.toLowerCase() === expected)?.[1];
}

function parseDeviceXml(xml: string): {
  udn: string;
  friendlyName: string;
  manufacturer: string;
  modelName: string;
  services: ParsedService[];
} {
  const values = parseXmlTree(xml);
  const serviceFrames = values.services;
  return {
    udn: values.fields.udn ?? "",
    friendlyName: values.fields.friendlyname ?? "",
    manufacturer: values.fields.manufacturer ?? "",
    modelName: values.fields.modelname ?? "",
    services: serviceFrames.map((service) => ({
      serviceType: service.servicetype ?? "",
      controlUrl: service.controlurl ?? "",
      scpdUrl: service.scpdurl ?? "",
    })),
  };
}

function parseActionNames(xml: string): Set<string> {
  const values = parseXmlTree(xml);
  return new Set(values.actionNames);
}

function parseXmlFields(xml: string): Record<string, string> {
  return parseXmlTree(xml).fields;
}

function parseXmlTree(xml: string): { fields: Record<string, string>; services: Array<Record<string, string>>; actionNames: string[] } {
  if (/<(?:!DOCTYPE|!ENTITY)\b/iu.test(xml)) throw new CastServiceError("DLNA_XML_UNSAFE", "DLNA XML 不允许 DTD 或外部实体。");
  const fields: Record<string, string> = {};
  const services: Array<Record<string, string>> = [];
  const actionNames: string[] = [];
  const stack: XmlFrame[] = [];
  const parser = new SaxesParser({ xmlns: false, fragment: false });
  parser.on("doctype", () => { throw new CastServiceError("DLNA_XML_UNSAFE", "DLNA XML 不允许 DTD 或外部实体。"); });
  parser.on("error", (error) => { throw new CastServiceError("DLNA_XML_INVALID", "DLNA XML 格式无效。", { cause: error }); });
  parser.on("opentag", (tag) => stack.push({ name: localName(tag.name), text: "", fields: {} }));
  parser.on("text", (text) => {
    const frame = stack.at(-1);
    if (frame) frame.text += text;
  });
  parser.on("cdata", (text) => {
    const frame = stack.at(-1);
    if (frame) frame.text += text;
  });
  parser.on("closetag", (rawName) => {
    const frame = stack.pop();
    if (!frame) throw new CastServiceError("DLNA_XML_INVALID", "DLNA XML 标签结构无效。");
    const value = frame.text.replace(/\s+/gu, " ").trim();
    const parent = stack.at(-1);
    if (frame.name === "service") services.push({ ...frame.fields });
    else if (frame.name === "name" && parent?.name === "action") actionNames.push(value);
    else if (parent?.name === "service") parent.fields[frame.name] = value;
    else if (parent) parent.fields[frame.name] = value;
    if (value) fields[frame.name] = value;
    const closedName = typeof rawName === "string" ? rawName : rawName.name;
    if (localName(closedName) !== frame.name) throw new CastServiceError("DLNA_XML_INVALID", "DLNA XML 标签不匹配。");
  });
  try {
    parser.write(xml).close();
  } catch (error) {
    if (error instanceof CastServiceError) throw error;
    throw new CastServiceError("DLNA_XML_INVALID", "DLNA XML 解析失败。");
  }
  return { fields, services, actionNames };
}

function capabilitiesFromActions(actions: Set<string>): CastCapabilities {
  if (actions.size === 0) return { ...DEFAULT_CAST_CAPABILITIES };
  return {
    setAvTransportUri: actions.has("SetAVTransportURI"),
    play: actions.has("Play"),
    pause: actions.has("Pause"),
    stop: actions.has("Stop"),
    seek: actions.has("Seek"),
    getTransportInfo: actions.has("GetTransportInfo"),
    getPositionInfo: actions.has("GetPositionInfo"),
  };
}

function validateMedia(source: CastMediaSource): CastMediaSource {
  let url: URL;
  try {
    url = new URL(source.url);
  } catch {
    throw new CastServiceError("DLNA_MEDIA_INVALID", "投屏媒体地址无效。");
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) {
    throw new CastServiceError("DLNA_MEDIA_INVALID", "投屏媒体必须是无凭据的 HTTP 地址。");
  }
  const headers = source.headers ? sanitizeMediaHeaders(source.headers) : undefined;
  return {
    url: url.toString(),
    title: source.title.trim().slice(0, 256) || "当前媒体",
    ...(headers ? { headers } : {}),
    ...(source.contentType ? { contentType: source.contentType.slice(0, 128) } : {}),
    ...(source.subtitle ? {
      subtitle: {
        url: validateSubtitle(source.subtitle.url),
        ...(source.subtitle.headers ? { headers: sanitizeMediaHeaders(source.subtitle.headers) } : {}),
        ...(source.subtitle.contentType ? { contentType: source.subtitle.contentType.slice(0, 128) } : {}),
      },
    } : {}),
  };
}

function validateSubtitle(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new CastServiceError("DLNA_MEDIA_INVALID", "投屏字幕地址无效。");
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) {
    throw new CastServiceError("DLNA_MEDIA_INVALID", "投屏字幕必须是无凭据的 HTTP 地址。");
  }
  return url.toString();
}

function sanitizeMediaHeaders(headers: Record<string, string>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (!name || /[\r\n]/u.test(name) || /[\r\n]/u.test(value)) throw new CastServiceError("DLNA_MEDIA_HEADERS_INVALID", "投屏媒体请求头无效。");
    if (/^(?:host|connection|content-length|transfer-encoding|upgrade|proxy-)/iu.test(name)) throw new CastServiceError("DLNA_MEDIA_HEADERS_INVALID", "投屏媒体请求头不允许该字段。");
    result[name] = value;
  }
  return result;
}

function needsBridge(value: string, headers: Record<string, string> | undefined): boolean {
  if (headers && Object.keys(headers).length > 0) return true;
  const url = new URL(value);
  return isLocalAddress(url.hostname);
}

function didlMetadata(title: string, url: string, contentType: string, subtitleUrl: string | null): string {
  const subtitle = subtitleUrl
    ? `<sec:CaptionInfoEx sec:type="srt">${escapeXml(subtitleUrl)}</sec:CaptionInfoEx>`
    : "";
  return `<DIDL-Lite xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/" xmlns:sec="http://www.sec.co.kr/"><item id="1" parentID="-1" restricted="1"><dc:title>${escapeXml(title)}</dc:title><upnp:class>object.item.videoItem</upnp:class><res protocolInfo="http-get:*:${escapeXml(contentType)}:*">${escapeXml(url)}</res>${subtitle}</item></DIDL-Lite>`;
}

function cloneSession(state: CastSessionState): CastSessionState {
  return {
    ...state,
    device: publicDevice(state.device),
    media: { ...state.media },
    error: state.error ? { ...state.error } : null,
  };
}

function publicDevice(device: CastDevice): CastDevice {
  return { ...device, capabilities: { ...device.capabilities } };
}

function contentTypeFor(value: string): string {
  if (/\.m3u8(?:$|[?#])/iu.test(value)) return "application/vnd.apple.mpegurl";
  if (/\.(?:mp3|m4a|aac|wav)(?:$|[?#])/iu.test(value)) return "audio/mpeg";
  return "video/mp4";
}

function formatTime(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(whole / 3_600);
  const minutes = Math.floor((whole % 3_600) / 60);
  const rest = whole % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(rest).padStart(2, "0")}`;
}

function parseTime(value: string | undefined): number | null {
  if (!value || !/^\d{2,}:\d{2}:\d{2}(?:\.\d+)?$/u.test(value)) return null;
  const parts = value.split(":");
  const hours = Number(parts[0] ?? NaN);
  const minutes = Number(parts[1] ?? NaN);
  const seconds = Number(parts[2] ?? NaN);
  if (![hours, minutes, seconds].every(Number.isFinite) || minutes > 59 || seconds >= 60) return null;
  return hours * 3_600 + minutes * 60 + seconds;
}

function castStateForTransport(value: string | null): CastSessionState["state"] | null {
  if (value === "PLAYING") return "playing";
  if (value === "PAUSED_PLAYBACK" || value === "PAUSED") return "paused";
  if (value === "STOPPED" || value === "NO_MEDIA_PRESENT") return "stopped";
  return null;
}

function safePosition(value: number | undefined): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function escapeXml(value: string): string {
  return value.replace(/[&<>'"]/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "'": "&apos;",
    '"': "&quot;",
  })[character] ?? character);
}

function localName(value: string): string {
  return value.split(":").pop()?.toLowerCase() ?? value.toLowerCase();
}

function positive(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function asCastError(error: unknown, fallbackCode: string, fallbackMessage: string): CastServiceError {
  if (error instanceof CastServiceError) return error;
  return new CastServiceError(fallbackCode, fallbackMessage);
}

async function readResponseText(response: Response, maxBytes: number): Promise<string> {
  const length = Number(response.headers.get("content-length"));
  if (Number.isFinite(length) && length > maxBytes) throw new CastServiceError("DLNA_XML_TOO_LARGE", "DLNA 响应超过大小限制。");
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await response.arrayBuffer());
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new CastServiceError("DLNA_TIMEOUT", "DLNA 请求超时。", { cause: error });
    }
    throw error;
  }
  if (bytes.byteLength > maxBytes) throw new CastServiceError("DLNA_XML_TOO_LARGE", "DLNA 响应超过大小限制。");
  return new TextDecoder().decode(bytes);
}

async function resolveHostAddresses(hostname: string): Promise<readonly string[]> {
  if (isIP(hostname)) return [hostname];
  const records = await lookup(hostname, { all: true, verbatim: true });
  return records.map((record) => record.address);
}

function isLocalAddress(value: string): boolean {
  const normalized = value.replace(/^\[|\]$/gu, "").split("%", 1)[0] ?? value;
  const mapped = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/iu)?.[1];
  if (mapped) return isLocalAddress(mapped);
  if (isIP(normalized) === 4) {
    const octets = normalized.split(".").map(Number);
    const [first, second] = octets;
    return first === 10
      || first === 127
      || (first === 169 && second === 254)
      || (first === 172 && second !== undefined && second >= 16 && second <= 31)
      || (first === 192 && second === 168)
      || first === 0;
  }
  if (isIP(normalized) === 6) {
    const lower = normalized.toLowerCase();
    return lower === "::1"
      || lower.startsWith("fc")
      || lower.startsWith("fd")
      || lower.startsWith("fe8")
      || lower.startsWith("fe9")
      || lower.startsWith("fea")
      || lower.startsWith("feb");
  }
  return false;
}
