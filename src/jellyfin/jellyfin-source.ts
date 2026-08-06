import type {
  JellyfinAdapter,
  JellyfinItem,
  JellyfinLibrary,
} from "./jellyfin-adapter.js";
import {
  MediaSourceError,
  type CategoryRequest,
  type HomeResult,
  type MediaSource,
  type PlayerRequest,
  type PlayerResult,
  type SearchRequest,
  type SourceCapabilities,
  type SourceCategory,
  type SourceInitContext,
  type Vod,
  type VodDetail,
  type VodPage,
} from "../source/media-source.js";

export const JELLYFIN_CAPABILITIES: SourceCapabilities = {
  home: true,
  category: true,
  search: true,
  detail: true,
  playback: true,
  localProxy: false,
  filters: false,
  pagination: false,
  engine: "jellyfin",
};

export class JellyfinMediaSource implements MediaSource {
  public readonly capabilities: SourceCapabilities = { ...JELLYFIN_CAPABILITIES };
  private readonly adapter: JellyfinAdapter;
  private libraries: readonly JellyfinLibrary[] = [];
  private initialized = false;
  private destroyed = false;

  public constructor(adapter: JellyfinAdapter) {
    this.adapter = adapter;
  }

  public async init(_context: SourceInitContext): Promise<void> {
    this.assertAvailable();
    await this.adapter.connect();
    this.libraries = await this.adapter.listLibraries();
    this.initialized = true;
  }

  public async home(): Promise<HomeResult> {
    this.assertInitialized();
    const items = (await Promise.all(this.libraries.map((library) => this.itemsForLibrary(library)))).flat();
    return {
      items,
      categories: this.libraries.map(toCategory),
      raw: { libraries: this.libraries.map((library) => ({ ...library })) },
    };
  }

  public async category(request: CategoryRequest): Promise<VodPage> {
    this.assertInitialized();
    const library = this.libraries.find((candidate) => candidate.id === request.typeId);
    if (!library) {
      throw new MediaSourceError("SOURCE_CATEGORY_NOT_FOUND", `Jellyfin library not found: ${request.typeId}`);
    }
    const items = await this.itemsForLibrary(library);
    return {
      items,
      page: request.page ?? 1,
      raw: { library: { ...library }, items: items.map((item) => item.raw) },
    };
  }

  public async search(request: SearchRequest): Promise<VodPage> {
    this.assertInitialized();
    const items = (await this.adapter.search(request.key)).map(toVod);
    return {
      items,
      page: request.page ?? 1,
      raw: { search: request.key, items: items.map((item) => item.raw) },
    };
  }

  public async detail(ids: string[]): Promise<VodDetail[]> {
    this.assertInitialized();
    return Promise.all(ids.map(async (id) => toVod(await this.adapter.getDetails(id))));
  }

  public async player(request: PlayerRequest): Promise<PlayerResult> {
    this.assertInitialized();
    const playback = await this.adapter.getPlayback(request.id);
    return {
      parse: playback.parse,
      url: playback.url,
      headers: { ...playback.headers },
    };
  }

  public async destroy(): Promise<void> {
    if (this.destroyed) return;
    this.destroyed = true;
    this.initialized = false;
    this.libraries = [];
  }

  private async itemsForLibrary(library: JellyfinLibrary): Promise<Vod[]> {
    const items = library.collectionType === "tvshows"
      ? await this.adapter.listSeries(library.id)
      : await this.adapter.listMovies(library.id);
    return items.map(toVod);
  }

  private assertAvailable(): void {
    if (this.destroyed) throw new MediaSourceError("SOURCE_DESTROYED", "Media source is destroyed");
  }

  private assertInitialized(): void {
    this.assertAvailable();
    if (!this.initialized) {
      throw new MediaSourceError("SOURCE_NOT_INITIALIZED", "Media source is not initialized");
    }
  }
}

export { JellyfinMediaSource as JellyfinSource };

function toCategory(library: JellyfinLibrary): SourceCategory {
  return {
    id: library.id,
    name: library.name,
    raw: { ...library },
  };
}

function toVod(item: JellyfinItem): VodDetail {
  const raw: Record<string, unknown> = {
    vod_id: item.id,
    vod_name: item.name,
    vod_remarks: item.type,
  };
  if (item.overview !== undefined) raw.vod_content = item.overview;
  if (item.year !== undefined) raw.vod_year = item.year;
  if (item.parentId !== undefined) raw.vod_parent_id = item.parentId;
  if (item.seriesId !== undefined) raw.vod_series_id = item.seriesId;
  if (item.seasonId !== undefined) raw.vod_season_id = item.seasonId;
  return { ...raw, id: item.id, name: item.name, raw };
}
