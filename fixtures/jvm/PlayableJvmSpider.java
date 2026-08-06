package com.qx.spike.fixture;

import com.qx.spike.host.Spider;
import com.qx.spike.host.JsonCodec;

import java.net.URI;
import java.net.URLEncoder;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

public final class PlayableJvmSpider implements Spider {
    private HttpClient client;
    private URI endpoint;

    @Override
    public void init(String ext) {
        if (ext == null || ext.isBlank()) throw new IllegalArgumentException("Playable Spider endpoint is required");
        URI configured = URI.create(ext);
        if (!"http".equalsIgnoreCase(configured.getScheme())
                && !"https".equalsIgnoreCase(configured.getScheme())) {
            throw new IllegalArgumentException("Playable Spider endpoint must use HTTP or HTTPS");
        }
        endpoint = configured;
        client = HttpClient.newBuilder()
                .connectTimeout(Duration.ofSeconds(10))
                .build();
    }

    @Override
    public String homeContent(boolean filter) {
        ensureInitialized();
        Map<String, Object> item = new LinkedHashMap<>();
        item.put("vod_id", "fixture:movie-1");
        item.put("vod_name", "Playable Fixture");
        item.put("vod_remarks", "JVM-native HLS test source");

        Map<String, Object> result = new LinkedHashMap<>();
        result.put("class", List.of(Map.of("type_id", "fixture", "type_name", "Fixture")));
        result.put("list", List.of(item));
        return JsonCodec.stringify(result);
    }

    @Override
    public String categoryContent(
            String typeId,
            int page,
            boolean filter,
            Map<String, String> extend) {
        ensureInitialized();
        Map<String, Object> item = new LinkedHashMap<>();
        item.put("vod_id", "fixture:movie-1");
        item.put("vod_name", "Category Fixture");
        return JsonCodec.stringify(Map.of(
                "page", page,
                "pagecount", 1,
                "limit", 20,
                "total", 1,
                "list", List.of(item)));
    }

    @Override
    public String searchContent(String key, boolean quick, int page) {
        ensureInitialized();
        Map<String, Object> item = new LinkedHashMap<>();
        item.put("vod_id", "fixture:movie-1");
        item.put("vod_name", "Search Fixture: " + key);
        return JsonCodec.stringify(Map.of(
                "page", page,
                "pagecount", 1,
                "limit", 20,
                "total", 1,
                "list", List.of(item)));
    }

    @Override
    public String detailContent(List<String> ids) {
        ensureInitialized();
        String id = ids.isEmpty() ? "fixture:movie-1" : ids.get(0);
        Map<String, Object> item = new LinkedHashMap<>();
        item.put("vod_id", id);
        item.put("vod_name", "Playable Fixture");
        item.put("vod_play_from", "主线$$$备用线");
        item.put("vod_play_url", "第一集$direct-hls#第二集$headered$$$电影$direct-mp4");

        return JsonCodec.stringify(Map.of("list", List.of(item)));
    }

    @Override
    public String playerContent(String flag, String id, List<String> vipFlags) throws Exception {
        ensureInitialized();
        String separator = endpoint.getQuery() == null ? "?" : "&";
        URI requestUri = URI.create(endpoint + separator
                + "flag=" + encode(flag)
                + "&id=" + encode(id)
                + "&vipFlags=" + encode(String.join(",", vipFlags)));
        HttpRequest request = HttpRequest.newBuilder(requestUri)
                .timeout(Duration.ofSeconds(30))
                .header("Accept", "application/json")
                .GET()
                .build();
        HttpResponse<String> response = client.send(
                request,
                HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8));
        if (response.statusCode() < 200 || response.statusCode() >= 300) {
            throw new IllegalStateException("Playable Spider player request failed: " + response.statusCode());
        }

        Map<String, Object> result = JsonCodec.parseObject(response.body());
        Object url = result.get("url");
        if (!(url instanceof String value)
                || !(value.startsWith("http://") || value.startsWith("https://"))) {
            throw new IllegalStateException("Playable Spider player response has no HTTP URL");
        }
        return JsonCodec.stringify(result);
    }

    @Override
    public void destroy() {
        client = null;
        endpoint = null;
    }

    private void ensureInitialized() {
        if (client == null || endpoint == null) throw new IllegalStateException("Spider is not initialized");
    }

    private static String encode(String value) {
        return URLEncoder.encode(value, StandardCharsets.UTF_8);
    }
}
