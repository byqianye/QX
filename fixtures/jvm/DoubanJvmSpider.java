package com.qx.spike.fixture;

import com.qx.spike.host.JsonCodec;
import com.qx.spike.host.Spider;

import java.net.URI;
import java.net.URLEncoder;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/**
 * Minimal JVM-native port of csp_Douban.homeContent/categoryContent plus
 * desktop detail/search extensions.
 *
 * The endpoint and field mapping are copied from the decompiled Android DEX;
 * no Android API, Gson, or CatVod runtime is required here.
 */
public final class DoubanJvmSpider implements Spider {
    private static final String API_KEY = "0ac44ae016490db2204ce0a042db2916";
    private static final int PAGE_SIZE = 20;
    private static final int SEARCH_PAGE_SIZE = 15;
    private static final int SEARCH_PRIMARY_ATTEMPTS = 2;
    private static final long SEARCH_RETRY_DELAY_MILLIS = 150L;
    private static final String SEARCH_HOST = "movie.douban.com";
    private static final String DEFAULT_ENDPOINT =
            "https://frodo.douban.com/api/v2/subject_collection/subject_real_time_hotest/items"
                    + "?apikey=" + API_KEY;
    private static final String REFERER =
            "https://servicewechat.com/wx2f9b06c1de1ccfca/84/page-frame.html";
    private static final String USER_AGENT =
            "Mozilla/5.0 (Windows NT 6.1; WOW64) AppleWebKit/537.36 "
                    + "(KHTML, like Gecko) Chrome/53.0.2785.143 Safari/537.36 "
                    + "MicroMessenger/7.0.9.501 NetType/WIFI MiniProgramEnv/Windows WindowsWechat";
    private static final String IMAGE_SUFFIX =
            "@Referer=https://api.douban.com/@User-Agent="
                    + "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                    + "(KHTML, like Gecko) Chrome/117.0.0.0 Safari/537.36";

    private HttpClient client;
    private URI endpoint;

    @Override
    public void init(String ext) {
        String endpointText = ext == null || ext.isBlank() ? DEFAULT_ENDPOINT : ext.trim();
        URI configured = URI.create(endpointText);
        if (!("http".equalsIgnoreCase(configured.getScheme())
                || "https".equalsIgnoreCase(configured.getScheme()))
                || configured.getHost() == null
                || configured.getHost().isBlank()) {
            throw new IllegalArgumentException("Douban endpoint must be an HTTP(S) URL");
        }

        endpoint = configured;
        client = HttpClient.newBuilder()
                .connectTimeout(Duration.ofSeconds(10))
                .build();
    }

    @Override
    public String homeContent(boolean filter) throws Exception {
        if (client == null || endpoint == null) {
            throw new IllegalStateException("DoubanJvmSpider is not initialized");
        }

        // The original csp_Douban.homeContent(boolean) does not use this flag.
        Map<String, Object> document = JsonCodec.parseObject(fetch(endpoint));
        Object rawItems = document.get("subject_collection_items");
        if (!(rawItems instanceof List<?> items)) {
            throw new IllegalStateException(
                    "Douban response is missing subject_collection_items");
        }

        List<Map<String, Object>> list = new ArrayList<>();
        for (Object rawItem : items) {
            Map<String, Object> item = asObject(rawItem, "subject_collection_items item");
            list.add(toVod(item));
        }

        Map<String, Object> result = new LinkedHashMap<>();
        result.put("class", categories());
        result.put("list", list);
        return JsonCodec.stringify(result);
    }

    @Override
    public String categoryContent(
            String typeId,
            int page,
            boolean filter,
            Map<String, String> extend) throws Exception {
        if (client == null || endpoint == null) {
            throw new IllegalStateException("DoubanJvmSpider is not initialized");
        }
        if (typeId == null || typeId.isBlank()) {
            throw new IllegalArgumentException("Douban type_id must not be blank");
        }
        if (page < 1) {
            throw new IllegalArgumentException("Douban page must be at least 1");
        }

        // The original csp_Douban.categoryContent(boolean) does not use this flag.
        Map<String, String> filters = extend == null ? Map.of() : extend;
        CategoryEndpoint request = categoryEndpoint(typeId, page, filters);
        Map<String, Object> document = JsonCodec.parseObject(fetch(request.uri()));
        Object rawItems = document.get(request.itemKey());
        if (!(rawItems instanceof List<?> items)) {
            throw new IllegalStateException(
                    "Douban response is missing " + request.itemKey());
        }

        List<Map<String, Object>> list = new ArrayList<>();
        for (Object rawItem : items) {
            Map<String, Object> item = asObject(rawItem, request.itemKey() + " item");
            list.add(toVod(item));
        }

        int total = integerValue(document.get("total"), Integer.MAX_VALUE);
        int pageCount = total == Integer.MAX_VALUE
                ? Integer.MAX_VALUE
                : (int) Math.ceil(total / (double) PAGE_SIZE);
        Map<String, Object> result = new LinkedHashMap<>();
        result.put("list", list);
        result.put("page", page);
        result.put("pagecount", pageCount);
        result.put("limit", PAGE_SIZE);
        result.put("total", total);
        return JsonCodec.stringify(result);
    }

    @Override
    public String detailContent(List<String> ids) throws Exception {
        if (client == null || endpoint == null) {
            throw new IllegalStateException("DoubanJvmSpider is not initialized");
        }
        if (ids == null || ids.isEmpty()) {
            throw new IllegalArgumentException("Douban detail ids must not be empty");
        }

        List<Map<String, Object>> list = new ArrayList<>();
        for (String rawId : ids) {
            DetailId detailId = parseDetailId(rawId);
            Map<String, Object> detail = fetchDetail(detailId.value());
            list.add(toDetailVod(detailId.raw(), detail));
        }

        Map<String, Object> result = new LinkedHashMap<>();
        result.put("list", list);
        return JsonCodec.stringify(result);
    }

    @Override
    public String searchContent(String key, boolean quick, int page) throws Exception {
        if (client == null || endpoint == null) {
            throw new IllegalStateException("DoubanJvmSpider is not initialized");
        }
        if (key == null || key.isBlank()) {
            throw new IllegalArgumentException("Douban search key must not be blank");
        }
        if (page < 1) {
            throw new IllegalArgumentException("Douban search page must be at least 1");
        }

        // The public web search has one result surface; quick is retained for
        // the CatVod contract but does not select a different Douban endpoint.
        long start = ((long) page - 1L) * SEARCH_PAGE_SIZE;
        if (start > Integer.MAX_VALUE) {
            throw new IllegalArgumentException("Douban search page is too large");
        }

        Map<String, Object> document = readSearchDocument(key, start);
        Object rawItems = document.get("items");
        if (!(rawItems instanceof List<?> items)) {
            throw new IllegalStateException("Douban search response is missing items");
        }

        List<Map<String, Object>> list = new ArrayList<>();
        for (Object rawItem : items) {
            list.add(toSearchVod(searchItem(rawItem)));
        }

        int total = integerValue(document.get("total"), list.size());
        int pageCount = total == Integer.MAX_VALUE
                ? Integer.MAX_VALUE
                : (int) Math.ceil(total / (double) SEARCH_PAGE_SIZE);
        Map<String, Object> result = new LinkedHashMap<>();
        result.put("list", list);
        result.put("page", page);
        result.put("pagecount", pageCount);
        result.put("limit", SEARCH_PAGE_SIZE);
        result.put("total", total);
        return JsonCodec.stringify(result);
    }

    @Override
    public void destroy() {
        client = null;
        endpoint = null;
    }

    private HttpResponse<String> response(URI requestUri) throws Exception {
        return response(requestUri, "application/json");
    }

    private HttpResponse<String> response(URI requestUri, String accept) throws Exception {
        HttpRequest request = HttpRequest.newBuilder(requestUri)
                .timeout(Duration.ofSeconds(30))
                .header("Accept", accept)
                .header("Referer", REFERER)
                .header("User-Agent", USER_AGENT)
                .GET()
                .build();
        return client.send(request, HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8));
    }

    private String fetch(URI requestUri) throws Exception {
        return fetch(requestUri, "application/json");
    }

    private String fetch(URI requestUri, String accept) throws Exception {
        HttpResponse<String> response = response(requestUri, accept);
        if (response.statusCode() < 200 || response.statusCode() >= 300) {
            throw new IllegalStateException(
                "Douban HTTP request failed: " + response.statusCode());
        }
        return response.body();
    }

    private Map<String, Object> readSearchDocument(String key, long start) throws Exception {
        Exception primaryFailure = null;
        for (int attempt = 0; attempt < SEARCH_PRIMARY_ATTEMPTS; attempt++) {
            try {
                Map<String, Object> document = parseSearchDocument(
                        fetch(searchEndpoint(key, start), "text/html,application/xhtml+xml"));
                String upstreamError = stringValue(document.get("error_info"));
                if (!upstreamError.isBlank()) {
                    throw new IllegalStateException(
                            "Douban search upstream error: " + upstreamError);
                }
                return document;
            } catch (Exception error) {
                primaryFailure = error;
                if (!isRetryableSearchFailure(error) || attempt + 1 >= SEARCH_PRIMARY_ATTEMPTS) {
                    break;
                }
                try {
                    Thread.sleep(SEARCH_RETRY_DELAY_MILLIS);
                } catch (InterruptedException interrupted) {
                    Thread.currentThread().interrupt();
                    throw interrupted;
                }
            }
        }

        if (primaryFailure == null || !isRetryableSearchFailure(primaryFailure)) {
            throw primaryFailure == null
                    ? new IllegalStateException("Douban primary search failed")
                    : primaryFailure;
        }

        try {
            return readFallbackSearchDocument(key, start);
        } catch (Exception fallbackFailure) {
            fallbackFailure.addSuppressed(primaryFailure);
            throw new IllegalStateException(
                    "Douban primary and fallback search failed", fallbackFailure);
        }
    }

    private Map<String, Object> readFallbackSearchDocument(String key, long start) throws Exception {
        Map<String, Object> response = JsonCodec.parseObject(
                fetch(fallbackSearchEndpoint(key, start), "application/json"));
        Map<String, Object> subjects = asObject(response.get("subjects"), "subjects");
        Object rawItems = subjects.get("items");
        if (!(rawItems instanceof List<?>)) {
            throw new IllegalStateException(
                    "Douban fallback search response is missing subjects.items");
        }

        Map<String, Object> normalized = new LinkedHashMap<>();
        normalized.put("items", rawItems);
        normalized.put("total", subjects.get("total"));
        return normalized;
    }

    private static boolean isRetryableSearchFailure(Throwable error) {
        for (Throwable current = error; current != null; current = current.getCause()) {
            String message = current.getMessage();
            if (message == null) continue;
            String lower = message.toLowerCase(Locale.ROOT);
            if (message.contains("频繁")
                    || lower.contains("rate limit")
                    || lower.contains("too many")
                    || message.contains("429")
                    || message.contains("403")
                    || message.matches(".*\\b5\\d{2}\\b.*")) {
                return true;
            }
        }
        return false;
    }

    private URI searchEndpoint(String key, long start) {
        return URI.create(searchOrigin() + "/subject_search?search_text="
                + encodeQuery(key) + "&cat=1002&start=" + start);
    }

    private URI fallbackSearchEndpoint(String key, long start) {
        return URI.create(fallbackSearchOrigin() + "/rexxar/api/v2/search/subjects?q="
                + encodeQuery(key)
                + "&type=movie&start=" + start
                + "&count=" + SEARCH_PAGE_SIZE);
    }

    private String searchOrigin() {
        if (SEARCH_HOST.equalsIgnoreCase(endpoint.getHost())) {
            return endpoint.getScheme() + "://" + endpoint.getRawAuthority();
        }
        if ("frodo.douban.com".equalsIgnoreCase(endpoint.getHost())) {
            return "https://" + SEARCH_HOST;
        }
        return endpoint.getScheme() + "://" + endpoint.getRawAuthority();
    }

    private String fallbackSearchOrigin() {
        String host = endpoint.getHost();
        if ("127.0.0.1".equals(host) || "localhost".equalsIgnoreCase(host)) {
            return searchOrigin();
        }
        return "https://m.douban.com";
    }

    private static Map<String, Object> parseSearchDocument(String html) {
        String marker = "window.__DATA__";
        int markerIndex = html.indexOf(marker);
        if (markerIndex < 0) {
            throw new IllegalStateException("Douban search response is missing window.__DATA__");
        }

        int objectStart = html.indexOf('{', markerIndex + marker.length());
        if (objectStart < 0) {
            throw new IllegalStateException("Douban search response is missing JSON data");
        }
        int depth = 0;
        boolean inString = false;
        boolean escaped = false;
        for (int index = objectStart; index < html.length(); index++) {
            char character = html.charAt(index);
            if (inString) {
                if (escaped) {
                    escaped = false;
                } else if (character == '\\') {
                    escaped = true;
                } else if (character == '"') {
                    inString = false;
                }
                continue;
            }
            if (character == '"') {
                inString = true;
            } else if (character == '{') {
                depth++;
            } else if (character == '}') {
                depth--;
                if (depth == 0) {
                    return JsonCodec.parseObject(html.substring(objectStart, index + 1));
                }
            }
        }
        throw new IllegalStateException("Douban search response has incomplete JSON data");
    }

    private static Map<String, Object> toSearchVod(Map<String, Object> source) {
        String id = idValue(source.get("id"));
        String title = stringValue(source.get("title"));
        if (id.isEmpty() || title.isEmpty()) {
            throw new IllegalStateException("Douban search item is missing id/title");
        }

        Map<String, Object> result = new LinkedHashMap<>();
        result.put("vod_id", "msearch:" + id);
        result.put("vod_name", title);
        result.put("vod_pic", stringValue(source.get("cover_url")));

        Map<String, Object> rating = optionalObject(source.get("rating"));
        String ratingInfo = stringValue(rating.get("rating_info"));
        String ratingValue = stringValue(rating.get("value"));
        result.put("vod_remarks", ratingInfo.isEmpty()
                ? (ratingValue.isEmpty() ? "" : "评分：" + ratingValue)
                : ratingInfo);
        String abstractText = stringValue(source.get("abstract"));
        if (abstractText.isEmpty()) abstractText = stringValue(source.get("abstract_2"));
        if (abstractText.isEmpty()) abstractText = stringValue(source.get("card_subtitle"));
        result.put("vod_content", abstractText);
        return result;
    }

    private static Map<String, Object> searchItem(Object value) {
        Map<String, Object> item = asObject(value, "search item");
        Object target = item.get("target");
        return target instanceof Map<?, ?> ? asObject(target, "search item target") : item;
    }

    private static String idValue(Object value) {
        if (value instanceof Number number) {
            try {
                return new java.math.BigDecimal(number.toString())
                        .toBigIntegerExact()
                        .toString();
            } catch (ArithmeticException ignored) {
                // Fall through for a non-integer numeric ID.
            }
        }
        return stringValue(value);
    }

    private Map<String, Object> fetchDetail(String id) throws Exception {
        Exception movieFailure;
        try {
            return readDetail("movie", id);
        } catch (Exception error) {
            movieFailure = error;
        }

        try {
            return readDetail("tv", id);
        } catch (Exception tvFailure) {
            tvFailure.addSuppressed(movieFailure);
            throw new IllegalStateException("Douban detail failed for id: " + id, tvFailure);
        }
    }

    private Map<String, Object> readDetail(String media, String id) throws Exception {
        Map<String, Object> document = JsonCodec.parseObject(fetch(detailEndpoint(media, id)));
        if (stringValue(document.get("id")).isEmpty()
                || stringValue(document.get("title")).isEmpty()) {
            throw new IllegalStateException("Douban detail response is missing id/title");
        }
        return document;
    }

    private URI detailEndpoint(String media, String id) {
        return URI.create(apiBase() + "/" + media + "/" + encodePath(id) + "?apikey=" + API_KEY);
    }

    private static DetailId parseDetailId(String rawId) {
        if (rawId == null || rawId.isBlank()) {
            throw new IllegalArgumentException("Douban detail id must not be blank");
        }
        String value = rawId.trim();
        if (value.startsWith("msearch:")) {
            value = value.substring("msearch:".length());
        }
        if (value.isBlank()) {
            throw new IllegalArgumentException("Douban detail id must not be blank");
        }
        return new DetailId(rawId, value);
    }

    private static Map<String, Object> toDetailVod(String id, Map<String, Object> source) {
        Map<String, Object> result = new LinkedHashMap<>();
        result.put("vod_id", id);
        result.put("vod_name", stringValue(source.get("title")));
        result.put("vod_pic", stringValue(source.get("cover_url")));

        Map<String, Object> rating = optionalObject(source.get("rating"));
        String ratingValue = stringValue(rating.get("value"));
        result.put("vod_remarks", ratingValue.isEmpty() ? "" : "评分：" + ratingValue);
        result.put("vod_year", stringValue(source.get("year")));
        result.put("vod_area", joinValues(source.get("countries")));
        result.put("vod_class", joinValues(source.get("genres")));
        result.put("vod_director", joinNames(source.get("directors")));
        result.put("vod_actor", joinNames(source.get("actors")));
        result.put("vod_content", stringValue(source.get("intro")));
        result.put("vod_pubdate", joinValues(source.get("pubdate")));

        int episodes = integerValue(source.get("episodes_count"), 0);
        if (episodes > 0) result.put("vod_total", episodes);
        return result;
    }

    private static String joinValues(Object value) {
        if (!(value instanceof List<?> values)) return stringValue(value);
        List<String> result = new ArrayList<>();
        for (Object item : values) {
            String text = stringValue(item);
            if (!text.isEmpty()) result.add(text);
        }
        return String.join(",", result);
    }

    private static String joinNames(Object value) {
        if (!(value instanceof List<?> values)) return "";
        List<String> result = new ArrayList<>();
        for (Object item : values) {
            Map<String, Object> person = optionalObject(item);
            String name = stringValue(person.get("name"));
            if (!name.isEmpty()) result.add(name);
        }
        return String.join(",", result);
    }

    private CategoryEndpoint categoryEndpoint(
            String typeId,
            int page,
            Map<String, String> filters) {
        long start = ((long) page - 1L) * PAGE_SIZE;
        if (start > Integer.MAX_VALUE) {
            throw new IllegalArgumentException("Douban page is too large");
        }
        String base = apiBase();
        String startQuery = "&start=" + start + "&count=" + PAGE_SIZE;
        return switch (typeId) {
            case "hot_gaia" -> new CategoryEndpoint(
                    URI.create(base + "/movie/hot_gaia?apikey=" + API_KEY
                            + "&sort=" + encodeQuery(valueOr(filters, "sort", "recommend"))
                            + "&area=" + encodeQuery(valueOr(filters, "area", "全部"))
                            + startQuery),
                    "items");
            case "tv_hot" -> collectionEndpoint(
                    base,
                    valueOr(filters, "type", "tv_hot"),
                    start,
                    "subject_collection_items");
            case "show_hot" -> collectionEndpoint(
                    base,
                    valueOr(filters, "type", "show_hot"),
                    start,
                    "subject_collection_items");
            case "movie" -> recommendEndpoint(
                    base,
                    "movie",
                    valueOr(filters, "sort", "T"),
                    tags(filters),
                    start);
            case "tv" -> recommendEndpoint(
                    base,
                    "tv",
                    valueOr(filters, "sort", "T"),
                    tags(filters),
                    start);
            case "rank_list_movie" -> collectionEndpoint(
                    base,
                    valueOr(filters, "榜单", "movie_real_time_hotest"),
                    start,
                    "subject_collection_items");
            case "rank_list_tv" -> collectionEndpoint(
                    base,
                    valueOr(filters, "榜单", "tv_real_time_hotest"),
                    start,
                    "subject_collection_items");
            default -> throw new IllegalArgumentException("Unsupported Douban type_id: " + typeId);
        };
    }

    private CategoryEndpoint collectionEndpoint(
            String base,
            String collection,
            long start,
            String itemKey) {
        return new CategoryEndpoint(
                URI.create(base + "/subject_collection/" + encodePath(collection)
                        + "/items?apikey=" + API_KEY
                        + "&start=" + start + "&count=" + PAGE_SIZE),
                itemKey);
    }

    private CategoryEndpoint recommendEndpoint(
            String base,
            String media,
            String sort,
            String tags,
            long start) {
        return new CategoryEndpoint(
                URI.create(base + "/" + media + "/recommend?apikey=" + API_KEY
                        + "&sort=" + encodeQuery(sort)
                        + "&tags=" + encodeQuery(tags)
                        + "&start=" + start + "&count=" + PAGE_SIZE),
                "items");
    }

    private String apiBase() {
        String configured = endpoint.toString();
        int apiPath = configured.indexOf("/api/v2");
        if (apiPath < 0) {
            throw new IllegalStateException("Douban endpoint must contain /api/v2");
        }
        return configured.substring(0, apiPath) + "/api/v2";
    }

    private static String tags(Map<String, String> filters) {
        StringBuilder result = new StringBuilder();
        for (Map.Entry<String, String> entry : filters.entrySet()) {
            if ("sort".equals(entry.getKey())) {
                continue;
            }
            if (result.length() > 0) {
                result.append(',');
            }
            result.append(entry.getValue());
        }
        return result.toString();
    }

    private static String valueOr(Map<String, String> values, String key, String fallback) {
        String value = values.get(key);
        return value == null || value.isBlank() ? fallback : value;
    }

    private static String encodeQuery(String value) {
        return URLEncoder.encode(value, StandardCharsets.UTF_8);
    }

    private static String encodePath(String value) {
        return encodeQuery(value).replace("+", "%20");
    }

    private static List<Map<String, String>> categories() {
        String[] ids = {
                "hot_gaia",
                "tv_hot",
                "show_hot",
                "movie",
                "tv",
                "rank_list_movie",
                "rank_list_tv",
        };
        String[] names = {
                " 热门电影",
                "热播剧集",
                "热播综艺",
                "电影筛选",
                "电视筛选",
                "电影榜单",
                "电视剧榜单",
        };

        List<Map<String, String>> result = new ArrayList<>();
        for (int index = 0; index < ids.length; index++) {
            Map<String, String> category = new LinkedHashMap<>();
            category.put("type_id", ids[index]);
            category.put("type_name", names[index]);
            result.add(category);
        }
        return result;
    }

    private static Map<String, Object> toVod(Map<String, Object> source) {
        Map<String, Object> result = new LinkedHashMap<>();
        String id = stringValue(source.get("id"));
        result.put("vod_id", "msearch:" + id);
        result.put("vod_name", stringValue(source.get("title")));

        Map<String, Object> picture = optionalObject(source.get("pic"));
        String normalPicture = stringValue(picture.get("normal"));
        result.put("vod_pic", normalPicture.isEmpty() ? "" : normalPicture + IMAGE_SUFFIX);

        Map<String, Object> rating = optionalObject(source.get("rating"));
        String ratingValue = stringValue(rating.get("value"));
        result.put("vod_remarks", ratingValue.isEmpty() ? "" : "评分：" + ratingValue);
        return result;
    }

    private static Map<String, Object> asObject(Object value, String field) {
        if (value instanceof Map<?, ?> raw) {
            Map<String, Object> result = new LinkedHashMap<>();
            for (Map.Entry<?, ?> entry : raw.entrySet()) {
                if (entry.getKey() instanceof String key) {
                    result.put(key, entry.getValue());
                }
            }
            return result;
        }
        throw new IllegalStateException("Douban response field is not an object: " + field);
    }

    private static Map<String, Object> optionalObject(Object value) {
        return value instanceof Map<?, ?> ? asObject(value, "nested object") : Map.of();
    }

    private static String stringValue(Object value) {
        return value == null ? "" : String.valueOf(value);
    }

    private static int integerValue(Object value, int fallback) {
        if (value instanceof Number number) {
            long integer = number.longValue();
            if (number.doubleValue() == integer
                    && integer >= 0
                    && integer <= Integer.MAX_VALUE) {
                return (int) integer;
            }
        }
        if (value instanceof String text) {
            try {
                int integer = Integer.parseInt(text);
                if (integer >= 0) return integer;
            } catch (NumberFormatException ignored) {
                // Fall through to the supplied fallback.
            }
        }
        return fallback;
    }

    private record CategoryEndpoint(URI uri, String itemKey) {
    }

    private record DetailId(String raw, String value) {
    }

}
