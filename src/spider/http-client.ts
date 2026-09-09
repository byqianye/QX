import { randomUUID } from "node:crypto";
import { SaxesParser } from "saxes";

import type { DesktopSpiderClientPort } from "../desktop/spider-client-port.js";
import type { SourceCapabilities } from "../source/media-source.js";
import type { SpiderResponse } from "./rpc.js";

export interface HttpDesktopClientOptions {
  api: string;
  type: 0 | 1 | 4;
  headers?: Readonly<Record<string, string>>;
  initialExt?: string;
  playUrl?: string;
  requestTimeoutMs?: number;
  maxResponseBytes?: number;
  fetchImpl?: typeof fetch;
}

/**
 * Desktop client for FongMi type 0/1/4 sites. It speaks the CMS HTTP
 * contract and returns the same SpiderResponse shape as the sidecar clients.
 * It deliberately does not execute page JavaScript or external Spider code.
 */
export class HttpDesktopClient implements DesktopSpiderClientPort {
  private readonly api: string;
  private readonly type: 0 | 1 | 4;
  private readonly headers: Readonly<Record<string, string>>;
  private readonly playUrl: string;
  private readonly requestTimeoutMs: number;
  private readonly maxResponseBytes: number;
  private readonly fetchImpl: typeof fetch;
  private ext: string;
  private initialized = false;
  private destroyed = false;

  public readonly capabilities: SourceCapabilities;

  public constructor(options: HttpDesktopClientOptions) {
    this.api = requireHttpUrl(options.api);
    this.type = options.type;
    this.headers = safeHeaders(options.headers ?? {});
    this.playUrl = options.playUrl?.trim() ?? "";
    this.ext = options.initialExt ?? "";
    this.requestTimeoutMs = Math.max(1_000, Math.floor(options.requestTimeoutMs ?? 30_000));
    this.maxResponseBytes = Math.max(64 * 1024, Math.floor(options.maxResponseBytes ?? 8 * 1024 * 1024));
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.capabilities = {
      home: true,
      category: true,
      search: true,
      detail: true,
      playback: true,
      localProxy: false,
      filters: this.type !== 0,
      pagination: true,
      engine: "http",
    };
  }

  public get isRunning(): boolean {
    return this.initialized && !this.destroyed;
  }

  public get pid(): number | null {
    return null;
  }

  public async init(ext: string): Promise<SpiderResponse> {
    if (this.destroyed) return errorResponse("HTTP_SOURCE_DESTROYED", "HTTP source client is destroyed");
    if (ext.trim()) this.ext = ext;
    this.initialized = true;
    return successResponse({ initialized: true });
  }

  public homeContent(_filter = false): Promise<SpiderResponse> {
    return this.request({ ac: "videolist" });
  }

  public categoryContent(
    typeId: string,
    page: number,
    filter = false,
    extend: Record<string, string> = {},
  ): Promise<SpiderResponse> {
    return this.request({
      ac: "videolist",
      t: typeId,
      pg: String(Math.max(1, Math.floor(page))),
      ...(filter && this.type !== 0 && Object.keys(extend).length > 0
        ? { f: JSON.stringify(extend) }
        : {}),
    });
  }

  public searchContent(key: string, _quick = false, page = 1): Promise<SpiderResponse> {
    return this.request({
      ac: "videolist",
      wd: key,
      pg: String(Math.max(1, Math.floor(page))),
    });
  }

  public detailContent(ids: string[]): Promise<SpiderResponse> {
    return this.request({ ac: "detail", ids: ids.join(",") });
  }

  public async playerContent(_flag: string, id: string): Promise<SpiderResponse> {
    if (!this.isRunning) return errorResponse("HTTP_SOURCE_NOT_INITIALIZED", "HTTP source is not initialized");
    const value = this.playUrl ? `${this.playUrl}${id}` : decodeUrl(id);
    if (!/^https?:\/\//i.test(value)) {
      return errorResponse(
        "HTTP_SOURCE_PLAYBACK_UNAVAILABLE",
        "HTTP CMS playback requires a direct HTTP or HTTPS episode URL",
      );
    }
    return successResponse({ parse: 0, url: value, header: { ...this.headers } });
  }

  public async destroy(): Promise<void> {
    this.destroyed = true;
    this.initialized = false;
  }

  private async request(params: Readonly<Record<string, string>>): Promise<SpiderResponse> {
    if (!this.isRunning) return errorResponse("HTTP_SOURCE_NOT_INITIALIZED", "HTTP source is not initialized");
    try {
      const url = new URL(this.api);
      for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
      if (this.type === 4 && this.ext) url.searchParams.set("ext", encodeBase64(this.ext));
      const response = await this.fetchImpl(url, {
        headers: this.headers,
        signal: AbortSignal.timeout(this.requestTimeoutMs),
      });
      if (!response.ok) return errorResponse("HTTP_SOURCE_HTTP_ERROR", `HTTP source returned ${response.status}`);
      const body = await readResponseBody(response, this.maxResponseBytes);
      const result = this.type === 0 ? parseCmsXml(body) : parseJson(body);
      return successResponse(result);
    } catch (error) {
      return errorResponse("HTTP_SOURCE_REQUEST_FAILED", errorMessage(error));
    }
  }
}

interface XmlNode {
  name: string;
  attributes: Record<string, string>;
  text: string;
  children: XmlNode[];
}

function parseCmsXml(body: string): Record<string, unknown> {
  const root = parseXmlTree(body);
  const list = findChild(root, "list");
  const classes = findChild(root, "class");
  const videos = list
    ? childrenNamed(list, "video").map(normalizeCmsVideo)
    : childrenNamed(root, "video").map(normalizeCmsVideo);
  const categories = classes
    ? childrenNamed(classes, "ty").map((node) => ({
        type_id: node.attributes.id ?? node.attributes.type_id ?? textOf(node, "id"),
        type_name: node.attributes.name ?? node.attributes.type_name ?? textOf(node, "name"),
      }))
    : [];
  const metadata = list ? { ...list.attributes } : {};
  return {
    ...metadata,
    ...(categories.length > 0 ? { class: categories } : {}),
    list: videos,
  };
}

function normalizeCmsVideo(node: XmlNode): Record<string, unknown> {
  const result = xmlObject(node);
  const aliases: Readonly<Record<string, string>> = {
    id: "vod_id",
    name: "vod_name",
    pic: "vod_pic",
    remarks: "vod_remarks",
    year: "vod_year",
    area: "vod_area",
    lang: "vod_lang",
    actor: "vod_actor",
    director: "vod_director",
    content: "vod_content",
    desc: "vod_content",
    des: "vod_content",
    score: "vod_score",
  };
  for (const [from, to] of Object.entries(aliases)) {
    if (result[to] === undefined && result[from] !== undefined) result[to] = result[from];
  }

  const rawLists = Array.isArray(result.dl) ? result.dl : [result.dl];
  const lines = rawLists.filter(isRecord).map((line) => ({
    name: stringsFrom(line.flag)[0] ?? "",
    value: stringsFrom(line.dd).join("#"),
  })).filter((line) => line.name || line.value);
  if (lines.length > 0) {
    result.vod_play_from = lines.map((line) => line.name).join("$$$");
    result.vod_play_url = lines.map((line) => line.value).join("$$$");
  }
  return result;
}

function parseXmlTree(body: string): XmlNode {
  const parser = new SaxesParser({ xmlns: false, fragment: false });
  const stack: XmlNode[] = [];
  let root: XmlNode | undefined;
  let parserError: Error | undefined;
  parser.on("opentag", (tag) => {
    const node: XmlNode = {
      name: tag.name.toLowerCase(),
      attributes: { ...tag.attributes },
      text: "",
      children: [],
    };
    const parent = stack[stack.length - 1];
    if (parent) parent.children.push(node);
    else root = node;
    stack.push(node);
  });
  parser.on("text", (value) => {
    const current = stack[stack.length - 1];
    if (current) current.text += value;
  });
  parser.on("cdata", (value) => {
    const current = stack[stack.length - 1];
    if (current) current.text += value;
  });
  parser.on("closetag", () => {
    stack.pop();
  });
  parser.on("error", (error) => {
    parserError = error;
  });
  parser.write(body).close();
  if (parserError) throw parserError;
  if (!root) throw new Error("CMS XML response has no root element");
  return root;
}

function xmlObject(node: XmlNode): Record<string, unknown> {
  const result: Record<string, unknown> = { ...node.attributes };
  for (const child of node.children) {
    const value = child.children.length > 0 ? xmlObject(child) : child.text.trim();
    const previous = result[child.name];
    result[child.name] = previous === undefined
      ? value
      : Array.isArray(previous) ? [...previous, value] : [previous, value];
  }
  if (node.children.length === 0 && node.text.trim()) result.text = node.text.trim();
  return result;
}

function findChild(node: XmlNode, name: string): XmlNode | undefined {
  return node.children.find((child) => child.name === name);
}

function childrenNamed(node: XmlNode, name: string): XmlNode[] {
  return node.children.filter((child) => child.name === name);
}

function stringsFrom(value: unknown): string[] {
  if (typeof value === "string") return value.trim() ? [value.trim()] : [];
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => stringsFrom(item));
}

function textOf(node: XmlNode, name: string): string {
  return findChild(node, name)?.text.trim() ?? "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJson(body: string): unknown {
  try {
    return JSON.parse(body.replace(/^\uFEFF/, ""));
  } catch (error) {
    throw new Error("HTTP source response is not valid JSON", { cause: error });
  }
}

async function readResponseBody(response: Response, maxBytes: number): Promise<string> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) throw new Error("HTTP source response is too large");
  const body = await response.arrayBuffer();
  if (body.byteLength > maxBytes) throw new Error("HTTP source response is too large");
  const charset = /charset\s*=\s*([^;]+)/i.exec(response.headers.get("content-type") ?? "")?.[1]?.trim();
  try {
    return new TextDecoder(charset?.toLowerCase() === "gbk" ? "gbk" : "utf-8").decode(body);
  } catch {
    return new TextDecoder("utf-8").decode(body);
  }
}

function successResponse(result: unknown): SpiderResponse {
  return { id: randomUUID(), ok: true, result };
}

function errorResponse(code: string, message: string): SpiderResponse {
  return { id: randomUUID(), ok: false, error: { code, message } };
}

function requireHttpUrl(value: string): string {
  const url = new URL(value);
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) {
    throw new Error("HTTP source URL must be an HTTP(S) URL without credentials");
  }
  return url.toString();
}

function safeHeaders(value: Readonly<Record<string, string>>): Record<string, string> {
  return Object.fromEntries(Object.entries(value).filter(([name, item]) => (
    /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name)
    && !/[\r\n]/.test(item)
    && !/^(?:host|connection|content-length|transfer-encoding|upgrade|proxy-)/i.test(name)
  )));
}

function encodeBase64(value: string): string {
  return Buffer.from(value, "utf8").toString("base64");
}

function decodeUrl(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
