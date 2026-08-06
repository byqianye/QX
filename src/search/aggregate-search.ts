import type { SearchRequest, Vod, VodPage } from "../source/media-source.js";
import { sanitizeHealthMessage, type SourceHealthRegistry } from "../health/source-health.js";

export interface AggregateSearchSource {
  id: string;
  label?: string;
  enabled?: boolean;
  search(request: SearchRequest): Promise<VodPage>;
}

export type AggregateSourceStatus = "pending" | "running" | "success" | "timeout" | "error" | "skipped";

export interface AggregateSourceStat {
  id: string;
  label: string;
  status: AggregateSourceStatus;
  count: number;
  elapsedMs: number | null;
  error: string | null;
}

export interface AggregateSearchGroup {
  key: string;
  name: string;
  items: readonly Vod[];
  sourceIds: readonly string[];
}

export interface AggregateSearchSnapshot {
  query: string;
  generation: number;
  status: "running" | "complete" | "cancelled";
  completed: number;
  total: number;
  groups: readonly AggregateSearchGroup[];
  sources: readonly AggregateSourceStat[];
}

export interface AggregateSearchOptions {
  page?: number;
  quick?: boolean;
  timeoutMs?: number;
  sourceIds?: readonly string[];
  health?: SourceHealthRegistry;
  onUpdate?: (snapshot: AggregateSearchSnapshot) => void;
}

export class AggregateSearchCoordinator {
  private generation = 0;
  private active: SearchRun | undefined;
  private snapshotValue: AggregateSearchSnapshot | undefined;

  public constructor(private readonly sources: readonly AggregateSearchSource[]) {
  }

  public get snapshot(): AggregateSearchSnapshot | undefined {
    return this.snapshotValue ? cloneSnapshot(this.snapshotValue) : undefined;
  }

  public cancel(): AggregateSearchSnapshot | undefined {
    const run = this.active;
    if (!run) return this.snapshot;
    run.cancelled = true;
    this.active = undefined;
    const cancelled = {
      ...run.snapshot,
      status: "cancelled" as const,
    };
    run.snapshot = cancelled;
    this.snapshotValue = cancelled;
    return cloneSnapshot(cancelled);
  }

  public async search(query: string, options: AggregateSearchOptions = {}): Promise<AggregateSearchSnapshot> {
    this.cancel();
    const generation = ++this.generation;
    const sourceFilter = options.sourceIds ? new Set(options.sourceIds) : null;
    const selected = this.sources.filter((source) => sourceFilter?.has(source.id) ?? true);
    const stats: AggregateSourceStat[] = this.sources.map((source) => ({
      id: source.id,
      label: source.label ?? source.id,
      status: selected.includes(source)
        ? source.enabled === false || options.health?.isCoolingDown(source.id) ? "skipped" : "pending"
        : "skipped",
      count: 0,
      elapsedMs: null,
      error: source.enabled === false
        ? "Source is disabled"
        : options.health?.isCoolingDown(source.id) ? "Source is cooling down" : null,
    }));
    const groups = new Map<string, AggregateSearchGroup>();
    const run: SearchRun = {
      generation,
      cancelled: false,
      snapshot: makeSnapshot(query, generation, "running", 0, selected.filter((source) => source.enabled !== false).length, groups, stats),
    };
    this.active = run;
    this.snapshotValue = run.snapshot;
    emit(run, options.onUpdate);

    const runnable = selected.filter((source) =>
      source.enabled !== false && !(options.health?.isCoolingDown(source.id) ?? false));
    await Promise.all(runnable.map(async (source) => {
      if (run.cancelled || this.active !== run) return;
      const stat = stats.find((candidate) => candidate.id === source.id);
      if (!stat) return;
      stat.status = "running";
      const startedAt = Date.now();
      try {
        const search = () => source.search({ key: query, page: options.page ?? 1, quick: options.quick ?? false });
        const searchWithTimeout = () => withTimeout(search(), options.timeoutMs ?? 10_000);
        const page = await (options.health
          ? options.health.track(source.id, "search", searchWithTimeout)
          : searchWithTimeout());
        if (run.cancelled || this.active !== run) return;
        stat.status = "success";
        stat.count = page.items.length;
        stat.elapsedMs = Date.now() - startedAt;
        for (const item of page.items) addItem(groups, item, source.id);
      } catch (error) {
        if (run.cancelled || this.active !== run) return;
        stat.status = error instanceof SearchTimeoutError ? "timeout" : "error";
        stat.elapsedMs = Date.now() - startedAt;
        stat.error = sanitizeHealthMessage(error instanceof Error ? error.message : String(error));
      } finally {
        if (run.cancelled || this.active !== run) return;
        run.snapshot = makeSnapshot(
          query,
          generation,
          "running",
          stats.filter((candidate) => candidate.status === "success" || candidate.status === "timeout" || candidate.status === "error").length,
          runnable.length,
          groups,
          stats,
        );
        this.snapshotValue = run.snapshot;
        emit(run, options.onUpdate);
      }
    }));

    if (run.cancelled || this.active !== run) {
      return cloneSnapshot(run.snapshot.status === "cancelled" ? run.snapshot : {
        ...run.snapshot,
        status: "cancelled",
      });
    }
    run.snapshot = makeSnapshot(query, generation, "complete", runnable.length, runnable.length, groups, stats);
    this.snapshotValue = run.snapshot;
    this.active = undefined;
    emit(run, options.onUpdate);
    return cloneSnapshot(run.snapshot);
  }
}

interface SearchRun {
  generation: number;
  cancelled: boolean;
  snapshot: AggregateSearchSnapshot;
}

class SearchTimeoutError extends Error {
  public constructor(timeoutMs: number) {
    super(`Search timed out after ${timeoutMs}ms`);
    this.name = "SearchTimeoutError";
  }
}

function addItem(groups: Map<string, AggregateSearchGroup>, item: Vod, sourceId: string): void {
  const key = dedupeKey(item, sourceId, groups.size);
  const existing = groups.get(key);
  if (!existing) {
    groups.set(key, {
      key,
      name: item.name,
      items: [item],
      sourceIds: [sourceId],
    });
    return;
  }
  const sourceIds = existing.sourceIds.includes(sourceId)
    ? existing.sourceIds
    : [...existing.sourceIds, sourceId];
  groups.set(key, {
    ...existing,
    items: [...existing.items, item],
    sourceIds,
  });
}

function dedupeKey(item: Vod, sourceId: string, fallbackIndex: number): string {
  const external = firstString(item.raw, [
    "douban_id",
    "tmdb_id",
    "imdb_id",
    "external_id",
    "externalId",
  ]);
  if (external) return `external:${normalizeText(external)}`;
  const year = firstString(item.raw, ["year", "vod_year", "release_year"]);
  const type = firstString(item.raw, ["type", "type_name", "vod_class"]);
  const title = normalizeText(item.name);
  if (title && (year || type)) return `title:${title}|year:${normalizeText(year)}|type:${normalizeText(type)}`;
  const actors = firstString(item.raw, ["vod_actor", "actor", "actors"]);
  if (title && actors) return `title-actor:${title}|${normalizeText(actors)}`;
  return `source:${sourceId}|item:${item.id}|fallback:${fallbackIndex}`;
}

function firstString(raw: Record<string, unknown>, keys: readonly string[]): string {
  for (const key of keys) {
    if (typeof raw[key] === "string" && raw[key].trim()) return raw[key].trim();
    if (typeof raw[key] === "number" && Number.isFinite(raw[key])) return String(raw[key]);
  }
  return "";
}

function normalizeText(value: string): string {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\[\]【】（）()：:，,。.!！?？'"“”‘’·\s]/g, "")
    .replace(/第\d+季/g, "")
    .trim();
}

function makeSnapshot(
  query: string,
  generation: number,
  status: AggregateSearchSnapshot["status"],
  completed: number,
  total: number,
  groups: Map<string, AggregateSearchGroup>,
  stats: readonly AggregateSourceStat[],
): AggregateSearchSnapshot {
  return {
    query,
    generation,
    status,
    completed,
    total,
    groups: [...groups.values()].map((group) => ({
      ...group,
      items: [...group.items],
      sourceIds: [...group.sourceIds],
    })),
    sources: stats.map((stat) => ({ ...stat })),
  };
}

function emit(run: SearchRun, callback: ((snapshot: AggregateSearchSnapshot) => void) | undefined): void {
  if (!callback || run.cancelled) return;
  callback(cloneSnapshot(run.snapshot));
}

function cloneSnapshot(snapshot: AggregateSearchSnapshot): AggregateSearchSnapshot {
  return {
    ...snapshot,
    groups: snapshot.groups.map((group) => ({
      ...group,
      items: group.items.map((item) => ({ ...item, raw: { ...item.raw } })),
      sourceIds: [...group.sourceIds],
    })),
    sources: snapshot.sources.map((source) => ({ ...source })),
  };
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new SearchTimeoutError(timeoutMs)), Math.max(1, timeoutMs));
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
