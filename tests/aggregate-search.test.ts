import { describe, expect, it } from "vitest";

import { AggregateSearchCoordinator } from "../src/search/aggregate-search.js";
import type { VodPage } from "../src/source/media-source.js";

function page(items: Array<Record<string, unknown>>): VodPage {
  return {
    page: 1,
    items: items.map((raw, index) => ({
      ...raw,
      id: String(raw.id ?? index),
      name: String(raw.name ?? raw.title ?? raw.id ?? index),
      raw,
    })),
    raw: { list: items },
  };
}

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

describe("aggregate search", () => {
  it("searches concurrently, reports incremental source status, and deduplicates safely", async () => {
    const updates: string[] = [];
    const coordinator = new AggregateSearchCoordinator([
      {
        id: "fast",
        search: async () => {
          await wait(5);
          return page([{ id: "fast-1", name: "Movie", tmdb_id: 7, year: "2024" }]);
        },
      },
      {
        id: "slow",
        search: async () => {
          await wait(25);
          return page([
            { id: "slow-1", name: "Movie", tmdb_id: 7, year: "2024" },
            { id: "slow-2", name: "Another", year: "2023", type_name: "Drama" },
          ]);
        },
      },
      {
        id: "broken",
        search: async () => {
          throw new Error("upstream failed");
        },
      },
    ]);

    const result = await coordinator.search("movie", {
      timeoutMs: 100,
      onUpdate: (snapshot) => updates.push(`${snapshot.query}:${snapshot.completed}/${snapshot.total}`),
    });

    expect(result.status).toBe("complete");
    expect(result.completed).toBe(3);
    expect(result.groups).toHaveLength(2);
    expect(result.groups[0]?.sourceIds).toEqual(["fast", "slow"]);
    expect(result.sources).toMatchObject([
      { id: "fast", status: "success", count: 1 },
      { id: "slow", status: "success", count: 2 },
      { id: "broken", status: "error", error: "upstream failed" },
    ]);
    expect(updates.some((value) => value === "movie:1/3")).toBe(true);
    expect(updates.at(-1)).toBe("movie:3/3");
  });

  it("isolates timeouts and honors source filters and disabled sources", async () => {
    const coordinator = new AggregateSearchCoordinator([
      {
        id: "timeout",
        search: async () => {
          await wait(50);
          return page([{ id: "late", name: "Late" }]);
        },
      },
      {
        id: "selected",
        search: async () => page([{ id: "selected", name: "Selected", vod_actor: "Actor" }]),
      },
      {
        id: "disabled",
        enabled: false,
        search: async () => page([{ id: "disabled", name: "Disabled" }]),
      },
    ]);

    const result = await coordinator.search("q", { timeoutMs: 5, sourceIds: ["timeout", "selected", "disabled"] });
    expect(result.sources).toMatchObject([
      { id: "timeout", status: "timeout" },
      { id: "selected", status: "success", count: 1 },
      { id: "disabled", status: "skipped" },
    ]);
    expect(result.groups.map((group) => group.name)).toEqual(["Selected"]);
  });

  it("cancels an old query so late results cannot update the new snapshot", async () => {
    const updates: Array<{ query: string; names: string[] }> = [];
    const coordinator = new AggregateSearchCoordinator([{
      id: "source",
      search: async ({ key }) => {
        await wait(key === "old" ? 30 : 1);
        return page([{ id: key, name: key }]);
      },
    }]);

    const oldSearch = coordinator.search("old", {
      onUpdate: (snapshot) => updates.push({ query: snapshot.query, names: snapshot.groups.map((group) => group.name) }),
    });
    await wait(2);
    const newSearch = coordinator.search("new", {
      onUpdate: (snapshot) => updates.push({ query: snapshot.query, names: snapshot.groups.map((group) => group.name) }),
    });
    const current = await newSearch;
    await oldSearch;

    expect(current.query).toBe("new");
    expect(current.groups.map((group) => group.name)).toEqual(["new"]);
    expect(updates.filter((update) => update.query === "old").at(-1)?.names).not.toContain("old");
    expect(updates.at(-1)).toMatchObject({ query: "new", names: ["new"] });
  });
});
