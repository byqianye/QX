import { describe, expect, it } from "vitest";

import {
  createSpiderRequest,
  parseSpiderLine,
  parseSpiderResponseLine,
  routeSpiderApi,
  spiderMethods,
} from "../src/spider/rpc.js";

describe("Spider RPC boundary", () => {
  it("routes the four configured API families", () => {
    expect(routeSpiderApi("csp_Demo")).toBe("java");
    expect(routeSpiderApi("js:./demo.js")).toBe("quickjs");
    expect(routeSpiderApi("./demo.py")).toBe("python");
    expect(routeSpiderApi("https://example.invalid/api")).toBe("http");
  });

  it("creates and parses line-delimited requests using the shared method set", () => {
    const request = createSpiderRequest("search", { wd: "demo", quick: true }, "probe-1");
    const roundTrip = parseSpiderLine(JSON.stringify(request));

    expect(spiderMethods).toContain("search");
    expect(spiderMethods).not.toContain("live");
    expect(roundTrip).toEqual(request);
  });

  it("rejects unknown methods and malformed responses", () => {
    expect(() => createSpiderRequest("unknown" as never, {})).toThrow(/method/);
    expect(() => parseSpiderLine("{}" )).toThrow(/request/);
    expect(() => parseSpiderResponseLine("{}" )).toThrow(/response/);
  });

  it("parses successful and failed response lines", () => {
    expect(parseSpiderResponseLine('{"id":"ok-1","ok":true,"result":{"ready":true}}')).toEqual({
      id: "ok-1",
      ok: true,
      result: { ready: true },
    });
    expect(parseSpiderResponseLine('{"id":"err-1","ok":false,"error":{"code":"E_TEST","message":"failed"}}')).toEqual({
      id: "err-1",
      ok: false,
      error: { code: "E_TEST", message: "failed" },
    });
  });
});
