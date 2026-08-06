export type PlaybackRuleScope = "source" | "playback-session" | "media-origin" | "path";

export interface PlaybackRuleMatch {
  origin?: string;
  pathPrefix?: string;
  extension?: string;
  playbackSessionId?: string;
  lineContains?: string;
}

export type PlaybackRuleAction =
  | { type: "url-rewrite"; from: string; to: string }
  | { type: "header-merge"; headers: Readonly<Record<string, string>> }
  | { type: "query-parameter"; name: string; value: string; mode?: "set" | "append" }
  | { type: "host-replace"; host: string; port?: number }
  | { type: "path-replace"; from: string; to: string }
  | { type: "uri-rewrite"; from: string; to: string }
  | { type: "line-filter"; contains: string }
  | { type: "marker-filter"; markers: readonly string[] };

export interface PlaybackRule {
  id: string;
  sourceId: string;
  enabled: boolean;
  priority: number;
  match: PlaybackRuleMatch;
  action: PlaybackRuleAction;
  scope: PlaybackRuleScope;
  safeDescription: string;
}

export interface PlaybackRuleContext {
  sourceId: string;
  playbackSessionId: string;
  url: string;
}

export interface PlaybackRuleSourceInput {
  url: string;
  headers: Readonly<Record<string, string>>;
}

export interface PlaybackRuleSourceResult extends PlaybackRuleSourceInput {
  matchedRuleIds: readonly string[];
  warnings: readonly string[];
}

export interface PlaybackRulePlaylistResult {
  body: string;
  matchedRuleIds: readonly string[];
  removedNodes: number;
  keptNodes: number;
  warnings: readonly string[];
}

export interface PlaybackRuleDryRun {
  originalUrl: string;
  rewrittenUrl: string;
  matchedRuleIds: readonly string[];
  removedNodes: number;
  keptNodes: number;
  warnings: readonly string[];
  redactedDiff: string;
}

export class PlaybackRuleError extends Error {
  public readonly code: string;

  public constructor(code: string, message: string) {
    super(message);
    this.name = "PlaybackRuleError";
    this.code = code;
  }
}

export class PlaybackRuleEngine {
  private readonly rules: readonly PlaybackRule[];

  public constructor(rules: readonly PlaybackRule[] = []) {
    this.rules = rules
      .filter((rule) => rule.enabled)
      .slice()
      .sort((left, right) => left.priority - right.priority || left.id.localeCompare(right.id));
  }

  public applySource(
    input: PlaybackRuleSourceInput,
    context: PlaybackRuleContext,
  ): PlaybackRuleSourceResult {
    let url = input.url;
    let headers = { ...input.headers };
    const matchedRuleIds: string[] = [];
    const warnings: string[] = [];
    const changedActions = new Set<string>();

    for (const rule of this.rules) {
      const action = rule.action;
      if (action.type === "line-filter" || action.type === "marker-filter" || action.type === "uri-rewrite") continue;
      if (!this.matches(rule, { ...context, url })) continue;
      matchedRuleIds.push(rule.id);
      const actionKey = action.type === "header-merge" ? "headers" : "url";
      if (changedActions.has(actionKey)) warnings.push(`rule conflict in ${actionKey}`);
      changedActions.add(actionKey);
      if (action.type === "url-rewrite") {
        url = replaceLiteral(url, action.from, action.to);
      } else if (action.type === "header-merge") {
        headers = { ...headers, ...action.headers };
      } else if (action.type === "query-parameter") {
        url = updateQuery(url, action.name, action.value, action.mode ?? "set");
      } else if (action.type === "host-replace") {
        url = replaceHost(url, action.host, action.port);
      } else if (action.type === "path-replace") {
        url = replacePath(url, action.from, action.to);
      }
      ensureHttpUrl(url);
    }

    return { url, headers, matchedRuleIds, warnings };
  }

  public applyPlaylist(
    body: string,
    upstreamUrl: string,
    context: PlaybackRuleContext,
  ): PlaybackRulePlaylistResult {
    ensureHttpUrl(upstreamUrl);
    const matchedRuleIds: string[] = [];
    const warnings: string[] = [];
    const lines = body.split(/\r?\n/);
    const rewritten: string[] = [];
    let removedNodes = 0;
    let keptNodes = 0;

    for (const originalLine of lines) {
      const trimmed = originalLine.trim();
      const lineRules = this.rules.filter((rule) => this.matches(rule, { ...context, url: upstreamUrl }, trimmed));
      if (lineRules.some((rule) => shouldFilterLine(rule, trimmed))) {
        for (const rule of lineRules) if (!matchedRuleIds.includes(rule.id)) matchedRuleIds.push(rule.id);
        removedNodes += trimmed ? 1 : 0;
        continue;
      }
      let line = originalLine;
      if (trimmed && !trimmed.startsWith("#")) {
        const uri = new URL(trimmed, upstreamUrl).toString();
        const rewrittenUri = this.rewriteUri(uri, context, matchedRuleIds);
        line = rewrittenUri === uri ? originalLine : rewrittenUri;
        if (trimmed) keptNodes += 1;
      } else if (line.includes("URI=")) {
        line = this.rewriteUriAttributes(line, upstreamUrl, context, matchedRuleIds);
      }
      rewritten.push(line);
    }

    const mediaNodes = rewritten.filter((line) => {
      const value = line.trim();
      return value.length > 0 && !value.startsWith("#");
    }).length;
    if (mediaNodes === 0) {
      throw new PlaybackRuleError("PLAYBACK_RULE_INVALID", "Playback rules removed every media node from the playlist.");
    }
    if (keptNodes === 0) keptNodes = mediaNodes;
    if (matchedRuleIds.length > 1 && new Set(matchedRuleIds).size !== matchedRuleIds.length) {
      warnings.push("duplicate rule matches were collapsed");
    }
    return {
      body: rewritten.join("\n"),
      matchedRuleIds: [...new Set(matchedRuleIds)],
      removedNodes,
      keptNodes,
      warnings,
    };
  }

  public dryRunSource(input: PlaybackRuleSourceInput, context: PlaybackRuleContext): PlaybackRuleDryRun {
    const result = this.applySource(input, context);
    return {
      originalUrl: redactUrl(input.url),
      rewrittenUrl: redactUrl(result.url),
      matchedRuleIds: result.matchedRuleIds,
      removedNodes: 0,
      keptNodes: 1,
      warnings: result.warnings,
      redactedDiff: `${redactUrl(input.url)} -> ${redactUrl(result.url)}`,
    };
  }

  public dryRunPlaylist(body: string, upstreamUrl: string, context: PlaybackRuleContext): PlaybackRuleDryRun {
    const result = this.applyPlaylist(body, upstreamUrl, context);
    return {
      originalUrl: redactUrl(upstreamUrl),
      rewrittenUrl: redactUrl(upstreamUrl),
      matchedRuleIds: result.matchedRuleIds,
      removedNodes: result.removedNodes,
      keptNodes: result.keptNodes,
      warnings: result.warnings,
      redactedDiff: `playlist nodes removed=${result.removedNodes}, kept=${result.keptNodes}`,
    };
  }

  private rewriteUri(uri: string, context: PlaybackRuleContext, matchedRuleIds: string[]): string {
    let rewritten = uri;
    for (const rule of this.rules) {
      if (rule.action.type !== "uri-rewrite"
        || (!this.matches(rule, { ...context, url: rewritten }) && !this.matches(rule, context))) continue;
      if (!matchedRuleIds.includes(rule.id)) matchedRuleIds.push(rule.id);
      rewritten = replaceLiteral(rewritten, rule.action.from, rule.action.to);
      ensureHttpUrl(rewritten);
    }
    return rewritten;
  }

  private rewriteUriAttributes(
    line: string,
    upstreamUrl: string,
    context: PlaybackRuleContext,
    matchedRuleIds: string[],
  ): string {
    return line.replace(/URI=("|')([^"']*)(\1)/gi, (_match, quote: string, value: string) => {
      const uri = new URL(value, upstreamUrl).toString();
      const rewritten = this.rewriteUri(uri, context, matchedRuleIds);
      return `URI=${quote}${rewritten}${quote}`;
    });
  }

  private matches(rule: PlaybackRule, context: PlaybackRuleContext, line?: string): boolean {
    if (rule.sourceId !== context.sourceId) return false;
    if (rule.scope === "playback-session" && !context.playbackSessionId) return false;
    if (rule.scope === "path" && !rule.match.pathPrefix) return false;
    if (rule.match.playbackSessionId && rule.match.playbackSessionId !== context.playbackSessionId) return false;
    let url: URL;
    try {
      url = new URL(context.url);
    } catch {
      return false;
    }
    if (rule.match.origin && normalizeOrigin(rule.match.origin) !== url.origin) return false;
    if (rule.match.pathPrefix && !url.pathname.startsWith(rule.match.pathPrefix)) return false;
    if (rule.match.extension && !url.pathname.toLowerCase().endsWith(rule.match.extension.toLowerCase())) return false;
    if (rule.match.lineContains && !line?.includes(rule.match.lineContains)) return false;
    return true;
  }
}

function shouldFilterLine(rule: PlaybackRule, line: string): boolean {
  if (rule.action.type === "line-filter") return line.includes(rule.action.contains);
  if (rule.action.type === "marker-filter") {
    return line.startsWith("#") && rule.action.markers.some((marker) => line.startsWith(marker));
  }
  return false;
}

function replaceLiteral(value: string, from: string, to: string): string {
  if (!from) throw new PlaybackRuleError("PLAYBACK_RULE_INVALID", "A playback rule replacement must have a non-empty match.");
  return value.split(from).join(to);
}

function updateQuery(value: string, name: string, queryValue: string, mode: "set" | "append"): string {
  if (!name) throw new PlaybackRuleError("PLAYBACK_RULE_INVALID", "A playback rule query parameter must have a name.");
  const url = new URL(value);
  if (mode === "append") url.searchParams.append(name, queryValue);
  else url.searchParams.set(name, queryValue);
  return url.toString();
}

function replaceHost(value: string, host: string, port?: number): string {
  if (!host || /[\s/?#]/.test(host)) throw new PlaybackRuleError("PLAYBACK_RULE_INVALID", "A playback rule host is invalid.");
  const url = new URL(value);
  url.hostname = host;
  if (port !== undefined) {
    if (!Number.isInteger(port) || port <= 0 || port > 65535) {
      throw new PlaybackRuleError("PLAYBACK_RULE_INVALID", "A playback rule port is invalid.");
    }
    url.port = String(port);
  }
  return url.toString();
}

function replacePath(value: string, from: string, to: string): string {
  const url = new URL(value);
  url.pathname = replaceLiteral(url.pathname, from, to);
  return url.toString();
}

function ensureHttpUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new PlaybackRuleError("PLAYBACK_RULE_INVALID", "A playback rule produced an invalid URL.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new PlaybackRuleError("PLAYBACK_RULE_INVALID", "Playback rules only allow HTTP and HTTPS URLs.");
  }
  if (url.username || url.password) {
    throw new PlaybackRuleError("PLAYBACK_RULE_INVALID", "Playback rules cannot add URL credentials.");
  }
  return url;
}

function normalizeOrigin(value: string): string {
  return ensureHttpUrl(value).origin;
}

function redactUrl(value: string): string {
  try {
    const url = ensureHttpUrl(value);
    url.search = url.search ? "?[redacted]" : "";
    url.hash = "";
    return url.toString();
  } catch {
    return "[redacted-url]";
  }
}
