import { createServer, type Server, type ServerResponse, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";

const MEDIA_FIXTURE_BYTES = Buffer.from(
  "AAAAIGZ0eXBpc29tAAACAGlzb21pc28yYXZjMW1wNDEAAAMVbW9vdgAAAGxtdmhkAAAAAAAAAAAAAAAAAAAD6AAAA+gAAQAAAQAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAgAAAj90cmFrAAAAXHRraGQAAAADAAAAAAAAAAAAAAABAAAAAAAAA+gAAAAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAABAAAAAQAAAAAAAkZWR0cwAAABxlbHN0AAAAAAAAAAEAAAPoAAAAAAABAAAAAAG3bWRpYQAAACBtZGhkAAAAAAAAAAAAAAAAAABAAAAAQABVxAAAAAAALWhkbHIAAAAAAAAAAHZpZGUAAAAAAAAAAAAAAABWaWRlb0hhbmRsZXIAAAABYm1pbmYAAAAUdm1oZAAAAAEAAAAAAAAAAAAAACRkaW5mAAAAHGRyZWYAAAAAAAAAAQAAAAx1cmwgAAAAAQAAASJzdGJsAAAAvnN0c2QAAAAAAAAAAQAAAK5hdmMxAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAABAAEABIAAAASAAAAAAAAAABFUxhdmM2MC4zMS4xMDIgbGlieDI2NAAAAAAAAAAAAAAAGP//AAAANGF2Y0MBZAAK/+EAF2dkAAqs2V7ARAAAAwAEAAADAAg8SJZYAQAGaOvjyyLA/fj4AAAAABBwYXNwAAAAAQAAAAEAAAAUYnRydAAAAAAAABYoAAAWKAAAABhzdHRzAAAAAAAAAAEAAAABAABAAAAAABxzdHNjAAAAAAAAAAEAAAABAAAAAQAAAAEAAAAUc3RzegAAAAAAAALFAAAAAQAAABRzdGNvAAAAAAAAAAEAAANFAAAAYnVkdGEAAABabWV0YQAAAAAAAAAhaGRscgAAAAAAAAAAbWRpcmFwcGwAAAAAAAAAAAAAAAAtaWxzdAAAACWpdG9vAAAAHWRhdGEAAAABAAAAAExhdmY2MC4xNi4xMDAAAAAIZnJlZQAAAs1tZGF0AAACrQYF//+p3EXpvebZSLeWLNgg2SPu73gyNjQgLSBjb3JlIDE2NCByMzE3MiBjMWM5OTMxIC0gSC4yNjQvTVBFRy00IEFWQyBjb2RlYyAtIENvcHlsZWZ0IDIwMDMtMjAyMyAtIGh0dHA6Ly93d3cudmlkZW9sYW4ub3JnL3gyNjQuaHRtbCAtIG9wdGlvbnM6IGNhYmFjPTEgcmVmPTMgZGVibG9jaz0xOjA6MCBhbmFseXNlPTB4MzoweDExMyBtZT1oZXggc3VibWU9NyBwc3k9MSBwc3lfcmQ9MS4wMDowLjAwIG1peGVkX3JlZj0xIG1lX3JhbmdlPTE2IGNocm9tYV9tZT0xIHRyZWxsaXM9MSA4eDhkY3Q9MSBjcW09MCBkZWFkem9uZT0yMSwxMSBmYXN0X3Bza2lwPTEgY2hyb21hX3FwX29mZnNldD0tMiB0aHJlYWRzPTEgbG9va2FoZWFkX3RocmVhZHM9MSBzbGljZWRfdGhyZWFkcz0wIG5yPTAgZGVjaW1hdGU9MSBpbnRlcmxhY2VkPTAgYmx1cmF5X2NvbXBhdD0wIGNvbnN0cmFpbmVkX2ludHJhPTAgYmZyYW1lcz0zIGJfcHlyYW1pZD0yIGJfYWRhcHQ9MSBiX2JpYXM9MCBkaXJlY3Q9MSB3ZWlnaHRiPTEgb3Blbl9nb3A9MCB3ZWlnaHRwPTIga2V5aW50PTI1MCBrZXlpbnRfbWluPTEgc2NlbmVjdXQ9NDAgaW50cmFfcmVmcmVzaD0wIHJjX2xvb2thaGVhZD00MCByYz1jcmYgbWJ0cmVlPTEgY3JmPTIzLjAgcWNvbXA9MC42MCBxcG1pbj0wIHFwbWF4PTY5IHFwc3RlcD00IGlwX3JhdGlvPTEuNDAgYXE9MToxLjAwAIAAAAAQZYiEABX//vfJ78Cm69vfgQ==",
  "base64",
);

const MEDIA_HLS_INIT_BYTES = Buffer.from(
  "AAAAHGZ0eXBpc281AAACAGlzbzVpc282bXA0MQAAAwttb292AAAAbG12aGQAAAAAAAAAAAAAAAAAAAPoAAAAAAABAAABAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACAAACDXRyYWsAAABcdGtoZAAAAAMAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAEAAAAAAEAAAABAAAAAAACRlZHRzAAAAHGVsc3QAAAAAAAAAAQAAAAAAAAAAAAEAAAAAAYVtZGlhAAAAIG1kaGQAAAAAAAAAAAAAAAAAAEAAAAAAAFXEAAAAAAAtaGRscgAAAAAAAAAAdmlkZQAAAAAAAAAAAAAAAFZpZGVvSGFuZGxlcgAAAAEwbWluZgAAABR2bWhkAAAAAQAAAAAAAAAAAAAAJGRpbmYAAAAcZHJlZgAAAAAAAAABAAAADHVybCAAAAABAAAA8HN0YmwAAACkc3RzZAAAAAAAAAABAAAAlGF2YzEAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAAAEAAQAEgAAABIAAAAAAAAAAEVTGF2YzYwLjMxLjEwMiBsaWJ4MjY0AAAAAAAAAAAAAAAY//8AAAAuYXZjQwFCwB7/4QAWZ0LAHtkewEQAAAMABAAAAwAIPFi5IAEABWjLg8sgAAAAEHBhc3AAAAABAAAAAQAAABBzdHRzAAAAAAAAAAAAAAAQc3RzYwAAAAAAAAAAAAAAFHN0c3oAAAAAAAAAAAAAAAAAAAAQc3RjbwAAAAAAAAAAAAAAKG12ZXgAAAAgdHJleAAAAAAAAAABAAAAAQAAAAAAAAAAAAAAAAAAAGJ1ZHRhAAAAWm1ldGEAAAAAAAAAIWhkbHIAAAAAAAAAAG1kaXJhcHBsAAAAAAAAAAAAAAAALWlsc3QAAAAlqXRvbwAAAB1kYXRhAAAAAQAAAABMYXZmNjAuMTYuMTAw",
  "base64",
);

const MEDIA_HLS_SEGMENT_BYTES = Buffer.from(
  "AAAAGHN0eXBtc2RoAAAAAG1zZGhtc2l4AAAANHNpZHgBAAAAAAAAAQAAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAQAAAvYAAEAAgAAAAAAAAGhtb29mAAAAEG1maGQAAAAAAAAAAQAAAFB0cmFmAAAAHHRmaGQAAgA4AAAAAQAAQAAAAAKGAQEAAAAAABR0ZmR0AQAAAAAAAAAAAAAAAAAAGHRydW4AAAAFAAAAAQAAAHACAAAAAAACjm1kYXQAAAJwBgX//2zcRem95tlIt5Ys2CDZI+7veDI2NCAtIGNvcmUgMTY0IHIzMTcyIGMxYzk5MzEgLSBILjI2NC9NUEVHLTQgQVZDIGNvZGVjIC0gQ29weWxlZnQgMjAwMy0yMDIzIC0gaHR0cDovL3d3dy52aWRlb2xhbi5vcmcveDI2NC5odG1sIC0gb3B0aW9uczogY2FiYWM9MCByZWY9MyBkZWJsb2NrPTE6MDowIGFuYWx5c2U9MHgxOjB4MTExIG1lPWhleCBzdWJtZT03IHBzeT0xIHBzeV9yZD0xLjAwOjAuMDAgbWl4ZWRfcmVmPTEgbWVfcmFuZ2U9MTYgY2hyb21hX21lPTEgdHJlbGxpcz0xIDh4OGRjdD0wIGNxbT0wIGRlYWR6b25lPTIxLDExIGZhc3RfcHNraXA9MSBjaHJvbWFfcXBfb2Zmc2V0PS0yIHRocmVhZHM9MSBsb29rYWhlYWRfdGhyZWFkcz0xIHNsaWNlZF90aHJlYWRzPTAgbnI9MCBkZWNpbWF0ZT0xIGludGVybGFjZWQ9MCBibHVyYXlfY29tcGF0PTAgY29uc3RyYWluZWRfaW50cmE9MCBiZnJhbWVzPTAgd2VpZ2h0cD0wIGtleWludD0yNTAga2V5aW50X21pbj0xIHNjZW5lY3V0PTQwIGludHJhX3JlZnJlc2g9MCByY19sb29rYWhlYWQ9NDAgcmM9Y3JmIG1idHJlZT0xIGNyZj0yMy4wIHFjb21wPTAuNjAgcXBtaW49MCBxcG1heD02OSBxcHN0ZXA9NCBpcF9yYXRpbz0xLjQwIGFxPTE6MS4wMACAAAAADmWIhAV///8PRQABQt+A",
  "base64",
);

const PROTECTED_REFERER = "https://source.example.invalid/";
const PROTECTED_USER_AGENT = "G22-fixture";

export interface MediaFixtureServer {
  readonly baseUrl: string;
  readonly mp4Url: string;
  readonly hlsUrl: string;
  readonly protectedHlsUrl: string;
  readonly playerUrl: string;
  readonly sniffUrl: string;
  readonly parserUrl: string;
  start(): Promise<void>;
  close(): Promise<void>;
}

export function createMediaFixtureServer(host = "127.0.0.1"): MediaFixtureServer {
  let server: Server | undefined;
  let baseUrl = "";

  const resource: MediaFixtureServer = {
    get baseUrl() {
      if (!baseUrl) throw new Error("Media fixture server is not running");
      return baseUrl;
    },
    get mp4Url() {
      return `${resource.baseUrl}/media/fixture.mp4`;
    },
    get hlsUrl() {
      return `${resource.baseUrl}/media/fixture.m3u8`;
    },
    get protectedHlsUrl() {
      return `${resource.baseUrl}/protected/fixture.m3u8`;
    },
    get playerUrl() {
      return `${resource.baseUrl}/player`;
    },
    get sniffUrl() {
      return `${resource.baseUrl}/sniff/page`;
    },
    get parserUrl() {
      return `${resource.baseUrl}/parser/resolve`;
    },
    async start() {
      if (server) return;
      server = createServer((request, response) => {
        void handleRequest(request, response, resource);
      });
      await new Promise<void>((resolve, reject) => {
        server?.once("error", reject);
        server?.listen(0, host, resolve);
      });
      const address = server.address() as AddressInfo;
      baseUrl = `http://${host}:${address.port}`;
    },
    async close() {
      const current = server;
      server = undefined;
      baseUrl = "";
      if (!current) return;
      await new Promise<void>((resolve, reject) => {
        current.close((error) => error ? reject(error) : resolve());
      });
    },
  };

  return resource;
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  fixture: MediaFixtureServer,
): Promise<void> {
  const url = new URL(request.url ?? "/", fixture.baseUrl);
  if (request.method !== "GET" && request.method !== "HEAD") {
    response.writeHead(405, { allow: "GET, HEAD" });
    response.end();
    return;
  }

  if (url.pathname === "/media/fixture.m3u8") {
    servePlaylist(request, response, "/media");
    return;
  }

  if (url.pathname === "/protected/fixture.m3u8") {
    if (!hasProtectedHeaders(request)) {
      response.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
      response.end("protected media requires playback headers");
      return;
    }
    servePlaylist(request, response, "/protected");
    return;
  }

  if (url.pathname === "/player") {
    const id = url.searchParams.get("id");
    const headered = id === "headered";
    if (id === "parse-one") {
      const body = Buffer.from(JSON.stringify({
        parse: 1,
        url: `${fixture.baseUrl}/parser/input`,
        header: {},
      }), "utf8");
      response.writeHead(200, {
        "content-type": "application/json; charset=utf-8",
        "content-length": body.length,
      });
      if (request.method === "HEAD") response.end();
      else response.end(body);
      return;
    }
    const mediaUrl = id === "headered"
      ? fixture.protectedHlsUrl
      : id === "direct-hls" ? fixture.hlsUrl : fixture.mp4Url;
    const body = Buffer.from(JSON.stringify({
      parse: 0,
      url: mediaUrl,
      header: headered ? {
        Referer: PROTECTED_REFERER,
        "User-Agent": PROTECTED_USER_AGENT,
      } : {},
    }), "utf8");
    response.writeHead(200, {
      "content-type": "application/json; charset=utf-8",
      "content-length": body.length,
    });
    if (request.method === "HEAD") response.end();
    else response.end(body);
    return;
  }

  if (url.pathname === "/sniff/page") {
    const mode = url.searchParams.get("mode") ?? "success";
    const scenario = mode === "popup"
      ? "window.open('/sniff/popup-target', '_blank');"
      : mode === "protocol"
        ? "window.setTimeout(() => { window.location = 'file:///qx-sniffer-local-file'; }, 10);"
        : mode === "redirect"
          ? "window.location = '/sniff/redirect';"
        : mode === "infinite"
          ? "window.setInterval(() => fetch('/sniff/api').catch(() => undefined), 5);"
          : mode === "timeout"
            ? ""
            : "fetch('/sniff/api').catch(() => undefined); window.setTimeout(() => fetch('/sniff/delayed.m3u8').catch(() => undefined), 120);";
    const body = Buffer.from(`<!doctype html><html><body>
      <img src="/sniff/poster.jpg" alt="poster">
      <script src="/sniff/app.js"></script>
      <script>
        ${scenario}
      </script>
    </body></html>`, "utf8");
    response.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "content-length": body.length,
      "set-cookie": "qx-sniffer-fixture=isolated; Path=/; HttpOnly",
    });
    if (request.method === "HEAD") response.end();
    else response.end(body);
    return;
  }

  if (url.pathname === "/sniff/redirect") {
    response.writeHead(302, { location: "https://outside.example.invalid/sniff.m3u8" });
    response.end();
    return;
  }

  if (url.pathname === "/sniff/popup-target") {
    response.writeHead(204);
    response.end();
    return;
  }

  if (url.pathname === "/sniff/poster.jpg") {
    serveBytes(request, response, MEDIA_FIXTURE_BYTES, "image/jpeg");
    return;
  }

  if (url.pathname === "/sniff/app.js") {
    const body = Buffer.from("window.__qxSnifferFalseCandidate = true;", "utf8");
    response.writeHead(200, {
      "content-type": "application/javascript; charset=utf-8",
      "content-length": body.length,
    });
    if (request.method === "HEAD") response.end();
    else response.end(body);
    return;
  }

  if (url.pathname === "/sniff/api") {
    const body = Buffer.from(JSON.stringify({ status: "ok" }), "utf8");
    response.writeHead(200, {
      "content-type": "application/json; charset=utf-8",
      "content-length": body.length,
    });
    if (request.method === "HEAD") response.end();
    else response.end(body);
    return;
  }

  if (url.pathname === "/sniff/delayed.m3u8") {
    await new Promise((resolve) => setTimeout(resolve, 120));
    servePlaylist(request, response, "/media");
    return;
  }

  if (url.pathname === "/parser/resolve") {
    const body = Buffer.from(JSON.stringify({
      parse: 0,
      url: fixture.hlsUrl,
      headers: {},
    }), "utf8");
    response.writeHead(200, {
      "content-type": "application/json; charset=utf-8",
      "content-length": body.length,
    });
    if (request.method === "HEAD") response.end();
    else response.end(body);
    return;
  }

  if (url.pathname === "/media/fixture.mp4") {
    serveBytes(request, response, MEDIA_FIXTURE_BYTES, "video/mp4");
    return;
  }

  if (url.pathname === "/media/fixture-init.mp4") {
    serveBytes(request, response, MEDIA_HLS_INIT_BYTES, "video/mp4");
    return;
  }

  if (url.pathname === "/media/fixture-0.m4s") {
    serveBytes(request, response, MEDIA_HLS_SEGMENT_BYTES, "video/iso.segment");
    return;
  }

  if (url.pathname === "/protected/fixture-init.mp4" || url.pathname === "/protected/fixture-0.m4s") {
    if (!hasProtectedHeaders(request)) {
      response.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
      response.end("protected media requires playback headers");
      return;
    }
    const bytes = url.pathname.endsWith(".m4s") ? MEDIA_HLS_SEGMENT_BYTES : MEDIA_HLS_INIT_BYTES;
    const contentType = url.pathname.endsWith(".m4s") ? "video/iso.segment" : "video/mp4";
    serveBytes(request, response, bytes, contentType);
    return;
  }

  response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
  response.end("media fixture not found");
}

function servePlaylist(request: IncomingMessage, response: ServerResponse, prefix: string): void {
  const playlist = [
    "#EXTM3U",
    "#EXT-X-VERSION:7",
    "#EXT-X-TARGETDURATION:1",
    "#EXT-X-MEDIA-SEQUENCE:0",
    "#EXT-X-PLAYLIST-TYPE:VOD",
    ...(prefix === "/protected" ? ["#EXT-X-CUE-OUT:DURATION=1"] : []),
    `#EXT-X-MAP:URI=\"${prefix}/fixture-init.mp4\"`,
    "#EXTINF:1.0,",
    `${prefix}/fixture-0.m4s`,
    "#EXT-X-ENDLIST",
    "",
  ].join("\n");
  const body = Buffer.from(playlist, "utf8");
  response.writeHead(200, {
    "content-type": "application/vnd.apple.mpegurl; charset=utf-8",
    "content-length": body.length,
    "cache-control": "no-store",
    "access-control-allow-origin": "*",
  });
  if (request.method === "HEAD") response.end();
  else response.end(body);
}

function hasProtectedHeaders(request: IncomingMessage): boolean {
  return request.headers.referer === PROTECTED_REFERER
    && request.headers["user-agent"] === PROTECTED_USER_AGENT;
}

function serveBytes(
  request: IncomingMessage,
  response: ServerResponse,
  bytes: Buffer,
  contentType: string,
): void {
  const rangeHeader = typeof request.headers.range === "string" ? request.headers.range : null;
  const range = rangeHeader ? parseRange(rangeHeader, bytes.length) : null;
  if (rangeHeader && !range) {
    response.writeHead(416, {
      "content-range": `bytes */${bytes.length}`,
      "accept-ranges": "bytes",
    });
    response.end();
    return;
  }

  const start = range?.start ?? 0;
  const end = range?.end ?? bytes.length - 1;
  const body = bytes.subarray(start, end + 1);
  response.writeHead(range ? 206 : 200, {
    "content-type": contentType,
    "content-length": body.length,
    "accept-ranges": "bytes",
    "access-control-allow-origin": "*",
    ...(range ? { "content-range": `bytes ${start}-${end}/${bytes.length}` } : {}),
  });
  if (request.method === "HEAD") response.end();
  else response.end(body);
}

function parseRange(value: string, length: number): { start: number; end: number } | null {
  const match = /^bytes=(\d*)-(\d*)$/i.exec(value.trim());
  if (!match) return null;
  const startText = match[1] ?? "";
  const endText = match[2] ?? "";
  if (!startText && !endText) return null;

  if (!startText) {
    const suffixLength = Number(endText);
    if (!Number.isInteger(suffixLength) || suffixLength <= 0) return null;
    return { start: Math.max(0, length - suffixLength), end: length - 1 };
  }

  const start = Number(startText);
  const requestedEnd = endText ? Number(endText) : length - 1;
  if (!Number.isInteger(start) || !Number.isInteger(requestedEnd) || start < 0 || start >= length) return null;
  const end = Math.min(requestedEnd, length - 1);
  return end >= start ? { start, end } : null;
}
