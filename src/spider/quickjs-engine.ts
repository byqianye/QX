import { getQuickJS, type QuickJSContext, type QuickJSHandle, type QuickJSRuntime } from "quickjs-emscripten";
import { createHash } from "node:crypto";

import type { SourceCapabilities } from "../source/media-source.js";
import {
  requestQuickJsSync,
  type QuickJsHttpResponse,
  type QuickJsNormalizedRequest,
  type QuickJsRequestHandler,
} from "./quickjs-request.js";
import { QuickJsEngineError } from "./quickjs-errors.js";
import { loadQuickJsScript, type QuickJsScriptLoadOptions } from "./quickjs-script.js";

export interface QuickJsEngineOptions {
  script: string;
  scriptName?: string;
  moduleSources?: Readonly<Record<string, string>>;
  allowedOrigins?: readonly string[];
  request?: QuickJsRequestHandler;
  memoryLimitBytes?: number;
  maxStackSizeBytes?: number;
  maxExecutionMs?: number;
  maxResponseBytes?: number;
  requestTimeoutMs?: number;
  maxScriptBytes?: number;
  maxModules?: number;
}

export type QuickJsEngineState = "new" | "initializing" | "ready" | "stopped";

export class QuickJsEngine {
  private readonly options: Required<Pick<
    QuickJsEngineOptions,
    "memoryLimitBytes" | "maxStackSizeBytes" | "maxExecutionMs" | "maxResponseBytes" | "requestTimeoutMs"
  >> & QuickJsEngineOptions;
  private runtime: QuickJSRuntime | null = null;
  private context: QuickJSContext | null = null;
  private stateValue: QuickJsEngineState = "new";
  private initPromise: Promise<void> | null = null;
  private callChain: Promise<unknown> = Promise.resolve();
  private deadline: number | null = null;
  private moduleSources = new Map<string, string>();
  private baseUrl: string | null = null;
  private cookies = new Map<string, string>();
  private localStorageValues = new Map<string, string>();
  private lastErrorValue: QuickJsEngineError | null = null;

  public constructor(options: QuickJsEngineOptions) {
    this.options = {
      memoryLimitBytes: 32 * 1024 * 1024,
      maxStackSizeBytes: 512 * 1024,
      maxExecutionMs: 5_000,
      maxResponseBytes: 2 * 1024 * 1024,
      requestTimeoutMs: 10_000,
      ...options,
    };
  }

  public get status(): QuickJsEngineState {
    return this.stateValue;
  }

  public get isReady(): boolean {
    return this.stateValue === "ready" && this.context !== null && this.runtime !== null;
  }

  public get lastError(): QuickJsEngineError | null {
    return this.lastErrorValue;
  }

  public async init(): Promise<void> {
    if (this.stateValue === "stopped") {
      throw new QuickJsEngineError("QUICKJS_DESTROYED", "QuickJS session is destroyed");
    }
    if (this.stateValue === "ready") return;
    if (this.initPromise) return this.initPromise;

    const promise = this.initInternal();
    const tracked = promise.finally(() => {
      this.initPromise = null;
    });
    this.initPromise = tracked;
    return tracked;
  }

  private async initInternal(): Promise<void> {
    this.stateValue = "initializing";
    try {
      const bundle = await loadQuickJsScript(this.options.script, {
        ...(this.options.moduleSources ? { moduleSources: this.options.moduleSources } : {}),
        ...(this.options.allowedOrigins ? { allowedOrigins: this.options.allowedOrigins } : {}),
        requestTimeoutMs: this.options.requestTimeoutMs,
        ...(this.options.maxScriptBytes === undefined ? {} : { maxScriptBytes: this.options.maxScriptBytes }),
        ...(this.options.maxModules === undefined ? {} : { maxModules: this.options.maxModules }),
      });
      this.moduleSources = new Map(bundle.modules);
      this.baseUrl = bundle.baseUrl;

      const QuickJS = await getQuickJS();
      const runtime = QuickJS.newRuntime();
      runtime.setMemoryLimit(this.options.memoryLimitBytes);
      runtime.setMaxStackSize(this.options.maxStackSizeBytes);
      runtime.setInterruptHandler(() => this.deadline !== null && Date.now() >= this.deadline);
      runtime.setModuleLoader(
        (moduleName) => this.moduleSources.get(moduleName)
          ?? this.moduleSources.get(this.normalizeModuleName(moduleName))
          ?? (() => {
            throw new QuickJsEngineError(
              "QUICKJS_SCRIPT_LOAD_FAILED",
              `QuickJS module is not available: ${moduleName}`,
            );
          })(),
        (baseModuleName, requestedName) => this.normalizeModuleRequest(baseModuleName, requestedName),
      );
      const context = runtime.newContext();
      this.runtime = runtime;
      this.context = context;
      this.installHostApi();
      this.evaluateEntry(bundle.entryName, bundle.entrySource);
      this.stateValue = "ready";
      this.lastErrorValue = null;
    } catch (error) {
      const normalized = this.normalizeError(error);
      this.lastErrorValue = normalized;
      this.stateValue = "stopped";
      this.disposeVm();
      throw normalized;
    }
  }

  public capabilities(): SourceCapabilities {
    const home = this.hasMethod("home") || this.hasMethod("homeVod");
    return {
      home,
      category: this.hasMethod("category"),
      search: this.hasMethod("search"),
      detail: this.hasMethod("detail"),
      playback: this.hasMethod("player"),
      localProxy: this.hasMethod("localProxy"),
      filters: this.hasMethod("category"),
      pagination: this.hasMethod("category") || this.hasMethod("search"),
      engine: "quickjs",
    };
  }

  public hasMethod(method: string): boolean {
    const context = this.context;
    if (!context || !this.isReady) return false;
    const spider = context.getProp(context.global, "__qxSpider");
    const value = context.getProp(spider, method);
    const result = context.typeof(value) === "function";
    value.dispose();
    spider.dispose();
    return result;
  }

  public call(method: string, args: readonly unknown[] = [], timeoutMs = this.options.maxExecutionMs): Promise<unknown> {
    if (this.stateValue === "stopped") {
      return Promise.reject(new QuickJsEngineError("QUICKJS_DESTROYED", "QuickJS session is destroyed"));
    }
    if (!this.isReady) {
      return Promise.reject(new QuickJsEngineError("QUICKJS_NOT_INITIALIZED", "QuickJS session is not initialized"));
    }
    const run = this.callChain
      .then(() => this.callInternal(method, args, timeoutMs))
      .catch((error) => {
        const normalized = this.normalizeError(error);
        this.lastErrorValue = normalized;
        throw normalized;
      });
    this.callChain = run.catch(() => undefined);
    return run;
  }

  private async callInternal(method: string, args: readonly unknown[], timeoutMs: number): Promise<unknown> {
    if (!this.hasMethod(method)) {
      throw new QuickJsEngineError("QUICKJS_UNSUPPORTED_METHOD", `QuickJS Spider does not implement ${method}`);
    }
    const context = this.requireContext();
    const argsHandle = context.newString(JSON.stringify(args));
    context.setProp(context.global, "__qxArgs", argsHandle);
    argsHandle.dispose();
    try {
      const code = `(() => {
        const target = globalThis.__qxSpider;
        const method = target[${JSON.stringify(method)}];
        return method.apply(target, JSON.parse(globalThis.__qxArgs));
      })()`;
      return this.evaluateValue(code, `${this.options.scriptName ?? "qx-call"}:${method}`, timeoutMs);
    } finally {
      context.setProp(context.global, "__qxArgs", context.undefined);
    }
  }

  public async destroy(): Promise<void> {
    if (this.stateValue === "stopped") return;
    this.stateValue = "stopped";
    try {
      await this.callChain;
    } catch {
      // Preserve the original operation error for its caller.
    }
    this.disposeVm();
  }

  private evaluateEntry(entryName: string, source: string): void {
    if (containsModuleSyntax(source)) {
      const moduleValue = this.evaluateHandle(source, entryName, "module", this.options.maxExecutionMs);
      const context = this.requireContext();
      context.setProp(context.global, "__qxModule", moduleValue);
      moduleValue.dispose();
      this.evaluateValue(moduleFactoryBootstrap(), "qx-bootstrap.mjs", this.options.maxExecutionMs);
    } else {
      this.evaluateValue(source, entryName, this.options.maxExecutionMs, "global");
      this.evaluateValue(plainScriptBootstrap(), "qx-bootstrap.js", this.options.maxExecutionMs);
    }
  }

  private evaluateValue(
    code: string,
    filename: string,
    timeoutMs: number,
    type: "global" | "module" = "global",
  ): unknown {
    const handle = this.evaluateHandle(code, filename, type, timeoutMs);
    const context = this.requireContext();
    try {
      return context.dump(handle);
    } finally {
      handle.dispose();
    }
  }

  private evaluateHandle(
    code: string,
    filename: string,
    type: "global" | "module",
    timeoutMs: number,
  ): QuickJSHandle {
    const context = this.requireContext();
    const runtime = this.requireRuntime();
    const deadline = Date.now() + Math.max(1, timeoutMs);
    const previousDeadline = this.deadline;
    this.deadline = deadline;
    try {
      const result = context.evalCode(code, filename, { type });
      const handle = context.unwrapResult(result);
      return this.settleHandle(handle, deadline, runtime, context);
    } catch (error) {
      throw this.normalizeError(error);
    } finally {
      this.deadline = previousDeadline;
    }
  }

  private settleHandle(
    handle: QuickJSHandle,
    deadline: number,
    runtime: QuickJSRuntime,
    context: QuickJSContext,
  ): QuickJSHandle {
    for (let index = 0; index < 100_000; index += 1) {
      const state = context.getPromiseState(handle);
      if (state.type === "fulfilled") {
        const value = state.value.dup();
        disposeDistinct(state.value, handle);
        return value;
      }
      if (state.type === "rejected") {
        const error = context.dump(state.error);
        disposeDistinct(state.error, handle);
        throw this.normalizeError(error);
      }
      if (Date.now() >= deadline) {
        handle.dispose();
        throw new QuickJsEngineError("QUICKJS_TIMEOUT", "QuickJS script execution timed out");
      }
      try {
        context.unwrapResult(runtime.executePendingJobs(100));
      } catch (error) {
        handle.dispose();
        throw this.normalizeError(error);
      }
      if (!runtime.hasPendingJob() && context.getPromiseState(handle).type === "pending") {
        handle.dispose();
        throw new QuickJsEngineError("QUICKJS_TIMEOUT", "QuickJS Promise did not settle");
      }
    }
    handle.dispose();
    throw new QuickJsEngineError("QUICKJS_TIMEOUT", "QuickJS Promise job limit exceeded");
  }

  private installHostApi(): void {
    const context = this.requireContext();
    const req = context.newFunction("req", (...args: QuickJSHandle[]) => this.requestGuest(context, args));
    context.setProp(context.global, "req", req);
    req.dispose();

    const fetch = context.newFunction("fetch", (...args: QuickJSHandle[]) => this.requestGuest(context, args));
    context.setProp(context.global, "fetch", fetch);
    fetch.dispose();

    const post = context.newFunction("post", (...args: QuickJSHandle[]) => {
      const url = args[0] ? context.getString(args[0]) : "";
      const body = args[1] ? context.dump(args[1]) : undefined;
      const headers = args[2] ? context.dump(args[2]) : undefined;
      const urlHandle = context.newString(url);
      const optionsHandle = context.newString(JSON.stringify({ method: "POST", body, headers }));
      try {
        return this.requestGuest(context, [urlHandle, optionsHandle]);
      } finally {
        urlHandle.dispose();
        optionsHandle.dispose();
      }
    });
    context.setProp(context.global, "post", post);
    post.dispose();

    const encode = context.newFunction("encode", (value) => context.newString(Buffer.from(context.getString(value), "utf8").toString("base64")));
    const decode = context.newFunction("decode", (value) => context.newString(Buffer.from(context.getString(value), "base64").toString("utf8")));
    const hash = context.newFunction("hash", (value, algorithm) => {
      const name = algorithm ? context.getString(algorithm) : "sha256";
      if (!/^(?:sha256|sha1|md5)$/i.test(name)) throw new QuickJsEngineError("QUICKJS_SCRIPT_ERROR", `Unsupported hash algorithm: ${name}`);
      return context.newString(createHash(name as "sha256" | "sha1" | "md5").update(context.getString(value)).digest("hex"));
    });
    context.setProp(context.global, "encode", encode);
    context.setProp(context.global, "decode", decode);
    context.setProp(context.global, "hash", hash);
    encode.dispose();
    decode.dispose();
    hash.dispose();

    const storage = context.newObject();
    const getItem = context.newFunction("getItem", (key) => {
      const value = this.localStorageValues.get(context.getString(key));
      return value === undefined ? context.null : context.newString(value);
    });
    const setItem = context.newFunction("setItem", (key, value) => {
      this.localStorageValues.set(context.getString(key), context.getString(value));
      return context.undefined;
    });
    const removeItem = context.newFunction("removeItem", (key) => {
      this.localStorageValues.delete(context.getString(key));
      return context.undefined;
    });
    const clear = context.newFunction("clear", () => {
      this.localStorageValues.clear();
      return context.undefined;
    });
    context.setProp(storage, "getItem", getItem);
    context.setProp(storage, "setItem", setItem);
    context.setProp(storage, "removeItem", removeItem);
    context.setProp(storage, "clear", clear);
    context.setProp(context.global, "localStorage", storage);
    getItem.dispose();
    setItem.dispose();
    removeItem.dispose();
    clear.dispose();
    storage.dispose();

    const consoleObject = context.newObject();
    for (const method of ["log", "info", "warn", "error", "debug"]) {
      const noop = context.newFunction(method, () => context.undefined);
      context.setProp(consoleObject, method, noop);
      noop.dispose();
    }
    context.setProp(context.global, "console", consoleObject);
    consoleObject.dispose();
  }

  private requestGuest(context: QuickJSContext, args: QuickJSHandle[]): QuickJSHandle {
    const urlValue = args[0];
    if (!urlValue) throw new QuickJsEngineError("QUICKJS_NETWORK_ERROR", "request() requires a URL");
    const requestedUrl = context.getString(urlValue);
    const rawOptions = args[1] ? context.dump(args[1]) : {};
    const options = isRecord(rawOptions) ? rawOptions : {};
    const request = this.buildRequest(requestedUrl, options);
    const response = this.performRequest(request);
    return context.newString(JSON.stringify(responseForGuest(response)));
  }

  private buildRequest(urlValue: string, options: Record<string, unknown>): QuickJsNormalizedRequest {
    const url = this.resolveRequestUrl(urlValue);
    const method = typeof options.method === "string" ? options.method.toUpperCase() : "GET";
    const headers = headerRecord(options.headers);
    const body = options.body === undefined || options.body === null
      ? undefined
      : typeof options.body === "string"
        ? options.body
        : JSON.stringify(options.body);
    const timeoutValue = options.timeoutMs ?? options.timeout;
    const timeoutMs = typeof timeoutValue === "number" && Number.isFinite(timeoutValue)
      ? Math.max(1, timeoutValue)
      : this.options.requestTimeoutMs;
    const origin = new URL(url).origin;
    const cookie = this.cookies.get(origin);
    if (cookie && !Object.keys(headers).some((key) => key.toLowerCase() === "cookie")) {
      headers.Cookie = cookie;
    }
    return {
      url,
      method,
      headers,
      ...(body === undefined ? {} : { body }),
      timeoutMs,
    };
  }

  private performRequest(request: QuickJsNormalizedRequest): QuickJsHttpResponse {
    const allowedOrigins = this.options.allowedOrigins ?? (this.baseUrl ? [new URL(this.baseUrl).origin] : []);
    const origin = new URL(request.url).origin;
    if (allowedOrigins.length === 0 || !allowedOrigins.includes(origin)) {
      throw new QuickJsEngineError("QUICKJS_NETWORK_DENIED", `QuickJS request origin is not allowed: ${origin}`);
    }
    const response = requestQuickJsSync(request, {
      maxResponseBytes: this.options.maxResponseBytes,
      ...(this.options.request ? { request: this.options.request } : {}),
    });
    const setCookie = response.headers["set-cookie"] ?? response.headers["Set-Cookie"];
    if (setCookie) this.cookies.set(origin, setCookie.split(",", 1)[0] ?? setCookie);
    return response;
  }

  private resolveRequestUrl(value: string): string {
    try {
      const parsed = this.baseUrl ? new URL(value, this.baseUrl) : new URL(value);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        throw new Error("only HTTP(S) URLs are permitted");
      }
      return parsed.toString();
    } catch (error) {
      throw new QuickJsEngineError(
        "QUICKJS_NETWORK_ERROR",
        `Invalid QuickJS request URL: ${value}`,
        { cause: error },
      );
    }
  }

  private normalizeModuleRequest(base: string, requested: string): string {
    if (this.moduleSources.has(requested)) return requested;
    const normalized = this.normalizeModuleName(requested, base);
    return this.moduleSources.has(normalized) ? normalized : requested;
  }

  private normalizeModuleName(name: string, base = this.options.scriptName ?? ""): string {
    if (/^https?:\/\//i.test(name) || /^file:\/\//i.test(name)) return name;
    if (/^https?:\/\//i.test(base)) return new URL(name, base).toString();
    if (/^file:\/\//i.test(base)) return new URL(name, base).toString();
    return name;
  }

  private requireContext(): QuickJSContext {
    if (!this.context) throw new QuickJsEngineError("QUICKJS_NOT_INITIALIZED", "QuickJS context is not initialized");
    return this.context;
  }

  private requireRuntime(): QuickJSRuntime {
    if (!this.runtime) throw new QuickJsEngineError("QUICKJS_NOT_INITIALIZED", "QuickJS runtime is not initialized");
    return this.runtime;
  }

  private disposeVm(): void {
    this.context?.dispose();
    this.context = null;
    this.runtime?.dispose();
    this.runtime = null;
    this.moduleSources.clear();
    this.cookies.clear();
    this.localStorageValues.clear();
  }

  private normalizeError(error: unknown): QuickJsEngineError {
    if (error instanceof QuickJsEngineError) return error;
    const message = guestErrorMessage(error);
    if (/interrupt|timeout|did not settle|job limit/i.test(message)) {
      return new QuickJsEngineError("QUICKJS_TIMEOUT", message, { cause: error });
    }
    if (/out of memory|memory limit/i.test(message)) {
      return new QuickJsEngineError("QUICKJS_MEMORY_LIMIT", message, { cause: error });
    }
    return new QuickJsEngineError("QUICKJS_SCRIPT_ERROR", message, { cause: error });
  }
}

function containsModuleSyntax(source: string): boolean {
  return /(^|[;\n\r])\s*(?:import|export)\b/.test(source)
    || /\bimport\s*\(/.test(source);
}

function moduleFactoryBootstrap(): string {
  return `(() => {
    const moduleValue = globalThis.__qxModule || {};
    let candidate = typeof moduleValue.__jsEvalReturn === "function"
      ? moduleValue.__jsEvalReturn()
      : moduleValue.default;
    if (typeof candidate === "function") {
      try { candidate = candidate(); }
      catch (error) {
        if (!/class constructor/i.test(String(error))) throw error;
        candidate = new candidate();
      }
    }
    if (!candidate) throw new Error("QuickJS module did not export a Spider instance");
    globalThis.__qxSpider = candidate;
    return true;
  })()`;
}

function plainScriptBootstrap(): string {
  return `(() => {
    let candidate = typeof __jsEvalReturn === "function"
      ? __jsEvalReturn()
      : typeof spider !== "undefined"
        ? spider
        : typeof Spider !== "undefined"
          ? Spider
          : globalThis.spider || globalThis.__spider || globalThis.default;
    if (typeof candidate === "function") {
      try { candidate = candidate(); }
      catch (error) {
        if (!/class constructor/i.test(String(error))) throw error;
        candidate = new candidate();
      }
    }
    if (!candidate) throw new Error("QuickJS script did not expose a Spider instance");
    globalThis.__qxSpider = candidate;
    return true;
  })()`;
}

function headerRecord(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
}

function responseForGuest(response: QuickJsHttpResponse): Record<string, unknown> {
  let bodyValue: unknown = response.body;
  try {
    bodyValue = JSON.parse(response.body);
  } catch {
    // Keep a text body when it is not JSON.
  }
  return isRecord(bodyValue)
    ? { ...bodyValue, url: response.url, status: response.status, headers: response.headers, body: response.body }
    : { url: response.url, status: response.status, headers: response.headers, body: response.body };
}

function guestErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (isRecord(error)) {
    const message = typeof error.message === "string" ? error.message : undefined;
    const stack = typeof error.stack === "string" ? error.stack : undefined;
    if (message && stack) return `${message}\n${stack}`;
    if (message) return message;
  }
  return String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function disposeDistinct(first: QuickJSHandle, second: QuickJSHandle): void {
  if (first !== second) first.dispose();
  second.dispose();
}
