import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { QuickJsEngineError } from "./quickjs-errors.js";

export interface QuickJsScriptBundle {
  entryName: string;
  entrySource: string;
  modules: ReadonlyMap<string, string>;
  baseUrl: string | null;
}

export interface QuickJsScriptLoadOptions {
  moduleSources?: Readonly<Record<string, string>>;
  allowedOrigins?: readonly string[];
  requestTimeoutMs?: number;
  maxScriptBytes?: number;
  maxModules?: number;
}

export async function loadQuickJsScript(
  scriptOrReference: string,
  options: QuickJsScriptLoadOptions = {},
): Promise<QuickJsScriptBundle> {
  const maxScriptBytes = options.maxScriptBytes ?? 4 * 1024 * 1024;
  const maxModules = options.maxModules ?? 32;
  const providedModules = new Map(Object.entries(options.moduleSources ?? {}));
  const reference = classifyReference(scriptOrReference);

  let entryName: string;
  let entrySource: string;
  let baseUrl: string | null;
  let rootDirectory: string | null = null;

  if (reference.kind === "source") {
    entryName = "qx-entry.mjs";
    entrySource = scriptOrReference;
    baseUrl = null;
  } else if (reference.kind === "url") {
    entryName = reference.value;
    entrySource = await readRemoteScript(reference.value, options, maxScriptBytes);
    baseUrl = reference.value;
  } else {
    const filePath = reference.value;
    entryName = pathToFileURL(filePath).toString();
    entrySource = await readLocalScript(filePath, maxScriptBytes);
    baseUrl = entryName;
    rootDirectory = dirname(filePath);
  }

  const modules = new Map<string, string>(providedModules);
  addModuleAliases(modules, entryName, entrySource);
  const visited = new Set<string>([entryName]);
  const queue: Array<{ name: string; source: string }> = [{ name: entryName, source: entrySource }];

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) break;
    for (const requested of staticModuleSpecifiers(current.source)) {
      if (modules.has(requested)) continue;
      const resolved = resolveModuleReference(requested, current.name, baseUrl, rootDirectory);
      if (!resolved) continue;
      if (visited.has(resolved.name)) continue;
      if (visited.size >= maxModules) {
        throw new QuickJsEngineError(
          "QUICKJS_SCRIPT_LOAD_FAILED",
          `QuickJS module limit exceeded (${maxModules})`,
        );
      }
      const source = resolved.kind === "url"
        ? await readRemoteScript(resolved.name, options, maxScriptBytes)
        : await readLocalScript(fileURLToPath(resolved.name), maxScriptBytes);
      visited.add(resolved.name);
      addModuleAliases(modules, resolved.name, source);
      queue.push({ name: resolved.name, source });
    }
  }

  return { entryName, entrySource, modules, baseUrl };
}

function classifyReference(value: string):
  | { kind: "source" }
  | { kind: "url"; value: string }
  | { kind: "file"; value: string } {
  const trimmed = value.trim();
  if (/^https?:\/\//i.test(trimmed)) return { kind: "url", value: new URL(trimmed).toString() };
  if (/^file:\/\//i.test(trimmed)) return { kind: "file", value: fileURLToPath(trimmed) };
  if (existsSync(trimmed) && isAbsolute(resolve(trimmed))) {
    return { kind: "file", value: resolve(trimmed) };
  }
  return { kind: "source" };
}

async function readLocalScript(path: string, maxBytes: number): Promise<string> {
  try {
    const source = await readFile(path, "utf8");
    assertScriptSize(source, maxBytes, path);
    return source;
  } catch (error) {
    if (error instanceof QuickJsEngineError) throw error;
    throw new QuickJsEngineError(
      "QUICKJS_SCRIPT_LOAD_FAILED",
      `Unable to read QuickJS script: ${path}`,
      { cause: error },
    );
  }
}

async function readRemoteScript(
  url: string,
  options: QuickJsScriptLoadOptions,
  maxBytes: number,
): Promise<string> {
  assertAllowedOrigin(url, options.allowedOrigins);
  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(options.requestTimeoutMs ?? 10_000),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const source = await response.text();
    assertScriptSize(source, maxBytes, url);
    return source;
  } catch (error) {
    if (error instanceof QuickJsEngineError) throw error;
    throw new QuickJsEngineError(
      "QUICKJS_SCRIPT_LOAD_FAILED",
      `Unable to load QuickJS script: ${url}`,
      { cause: error },
    );
  }
}

function assertAllowedOrigin(url: string, allowedOrigins: readonly string[] | undefined): void {
  const parsed = new URL(url);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new QuickJsEngineError(
      "QUICKJS_NETWORK_DENIED",
      `QuickJS only permits HTTP(S) script URLs: ${url}`,
    );
  }
  if (allowedOrigins && allowedOrigins.length > 0 && !allowedOrigins.includes(parsed.origin)) {
    throw new QuickJsEngineError(
      "QUICKJS_NETWORK_DENIED",
      `QuickJS script origin is not allowed: ${parsed.origin}`,
    );
  }
}

function assertScriptSize(source: string, maxBytes: number, label: string): void {
  const size = new TextEncoder().encode(source).byteLength;
  if (size > maxBytes) {
    throw new QuickJsEngineError(
      "QUICKJS_SCRIPT_LOAD_FAILED",
      `QuickJS script exceeds ${maxBytes} bytes: ${label}`,
    );
  }
}

function staticModuleSpecifiers(source: string): string[] {
  const matches = new Set<string>();
  const patterns = [
    /\bimport\s+(?:[^"']+?\s+from\s+)?["']([^"']+)["']/g,
    /\bexport\s+[^"']*?\s+from\s+["']([^"']+)["']/g,
    /\bimport\(\s*["']([^"']+)["']\s*\)/g,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      const value = match[1];
      if (value) matches.add(value);
    }
  }
  return [...matches];
}

function resolveModuleReference(
  requested: string,
  currentName: string,
  baseUrl: string | null,
  rootDirectory: string | null,
): { kind: "url" | "file"; name: string } | null {
  if (/^https?:\/\//i.test(requested)) return { kind: "url", name: new URL(requested).toString() };
  if (/^file:\/\//i.test(requested)) {
    const path = fileURLToPath(requested);
    if (rootDirectory && !isWithin(rootDirectory, path)) return null;
    return { kind: "file", name: pathToFileURL(path).toString() };
  }
  if (baseUrl && /^https?:\/\//i.test(baseUrl)) {
    const resolved = new URL(requested, currentName || baseUrl).toString();
    return { kind: "url", name: resolved };
  }
  if (rootDirectory) {
    const path = resolve(dirname(fileURLToPath(currentName)), requested);
    if (!isWithin(rootDirectory, path)) return null;
    return { kind: "file", name: pathToFileURL(path).toString() };
  }
  return null;
}

function addModuleAliases(modules: Map<string, string>, name: string, source: string): void {
  modules.set(name, source);
  if (name.startsWith("file:")) {
    const path = fileURLToPath(name);
    modules.set(path, source);
    modules.set(`./${path.split(/[\\/]/).pop() ?? ""}`, source);
  }
}

function isWithin(root: string, candidate: string): boolean {
  const relativePath = relative(resolve(root), resolve(candidate));
  return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
}
