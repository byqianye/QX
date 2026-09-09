// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  homeObservationExpression,
  playbackNavigationEvidence,
  playbackProxyObservationExpression,
  watchPlaybackActivationExpression,
} from "../scripts/tauri-cdp-playback-flow.js";

afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("Tauri CDP playback activation", () => {
  it("clicks the explicit Watch-page start action after detail navigation", () => {
    document.body.innerHTML = '<button data-action="core-watch-play">开始播放</button>';
    const button = document.querySelector('[data-action="core-watch-play"]') as HTMLButtonElement;
    const click = vi.fn();
    button.addEventListener("click", click);

    expect(window.eval(watchPlaybackActivationExpression(false))).toBe("watch-ready");
    expect(window.eval(watchPlaybackActivationExpression(true))).toBe("watch-start-clicked");
    expect(click).toHaveBeenCalledTimes(1);
  });

  it("does not click again after the embedded player exists", () => {
    document.body.innerHTML = [
      '<video data-testid="embedded-player"></video>',
      '<button data-action="core-watch-play">开始播放</button>',
    ].join("");
    const button = document.querySelector('[data-action="core-watch-play"]') as HTMLButtonElement;
    const click = vi.fn();
    button.addEventListener("click", click);

    expect(window.eval(watchPlaybackActivationExpression(true))).toBe("player-ready");
    expect(click).not.toHaveBeenCalled();
  });

  it("waits for the initial player request before considering a retry click", () => {
    document.body.innerHTML = [
      '<main id="vue-renderer" data-pending="player"></main>',
      '<button data-action="core-watch-play">开始播放</button>',
    ].join("");
    const button = document.querySelector('[data-action="core-watch-play"]') as HTMLButtonElement;
    const click = vi.fn();
    button.addEventListener("click", click);

    expect(window.eval(watchPlaybackActivationExpression(true))).toBe(false);
    expect(click).not.toHaveBeenCalled();
  });
});

describe("Tauri CDP playback evidence", () => {
  it("allows an empty home only for direct-detail evidence", () => {
    document.body.innerHTML = `
      <main data-testid="core-app-shell" data-route="home">
        <section data-testid="core-browse-page" data-route="home"></section>
      </main>
    `;

    expect(window.eval(homeObservationExpression(false))).toBe(false);
    expect(JSON.parse(String(window.eval(homeObservationExpression(true))))).toEqual({
      homeCardCount: 0,
      homeFirstTitle: null,
      homePosterLoaded: false,
      homePosterNaturalWidth: 0,
      homePosterNaturalHeight: 0,
    });
  });

  it("keeps the first home title when a later card supplies the decoded poster evidence", () => {
    document.body.innerHTML = `
      <main data-testid="core-app-shell" data-route="home">
        <section data-testid="core-browse-page" data-route="home">
          <article data-testid="vod-card"><h3>无图条目</h3></article>
          <article data-testid="vod-card">
            <h3>有图条目</h3>
            <img data-testid="vod-poster" />
          </article>
        </section>
      </main>
    `;
    const poster = document.querySelector('[data-testid="vod-poster"]') as HTMLImageElement;
    Object.defineProperties(poster, {
      complete: { value: true },
      naturalWidth: { value: 270 },
      naturalHeight: { value: 405 },
    });

    expect(JSON.parse(String(window.eval(homeObservationExpression(false))))).toEqual({
      homeCardCount: 2,
      homeFirstTitle: "无图条目",
      homePosterLoaded: true,
      homePosterNaturalWidth: 270,
      homePosterNaturalHeight: 405,
    });
  });

  it("detects the playback proxy from resource timing when HLS.js uses a blob URL", () => {
    document.body.innerHTML = '<video data-testid="embedded-player" src="blob:http://localhost/player"></video>';
    vi.spyOn(performance, "getEntriesByType").mockReturnValue([
      { name: "http://127.0.0.1:56560/__qx_playback/session-token" } as PerformanceResourceTiming,
    ]);

    expect(window.eval(playbackProxyObservationExpression())).toBe(true);
  });

  it("records direct detail navigation without claiming a search", () => {
    expect(playbackNavigationEvidence({
      detailId: "https://www.4kcz.com/movie/23677.html",
      searchKey: "流浪地球",
    })).toEqual({
      navigationMode: "direct-detail",
      detailId: "https://www.4kcz.com/movie/23677.html",
      homeTitle: null,
      searchKey: null,
      nativeSearchAndDetail: false,
    });
  });

  it("records search navigation only when search actually runs", () => {
    expect(playbackNavigationEvidence({ searchKey: "流浪地球" })).toEqual({
      navigationMode: "search",
      detailId: null,
      homeTitle: null,
      searchKey: "流浪地球",
      nativeSearchAndDetail: true,
    });
  });

  it("records home-card navigation without claiming a search", () => {
    expect(playbackNavigationEvidence({ homeTitle: "峡谷", searchKey: "流浪地球" })).toEqual({
      navigationMode: "home-card",
      detailId: null,
      homeTitle: "峡谷",
      searchKey: null,
      nativeSearchAndDetail: false,
    });
  });
});
