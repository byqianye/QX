package com.qx.spike.fixture;

import com.qx.spike.host.Spider;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;

public final class HttpSpider implements Spider {
    private HttpClient client;
    private URI endpoint;

    @Override
    public void init(String ext) {
        if (ext == null || ext.isBlank()) throw new IllegalArgumentException("Spider ext URL is required");
        URI configured = URI.create(ext);
        if (!"http".equalsIgnoreCase(configured.getScheme())
                && !"https".equalsIgnoreCase(configured.getScheme())) {
            throw new IllegalArgumentException("Spider ext URL must use HTTP or HTTPS");
        }
        endpoint = configured;
        client = HttpClient.newBuilder()
                .connectTimeout(Duration.ofSeconds(10))
                .build();
    }

    @Override
    public String homeContent(boolean filter) throws Exception {
        if (client == null || endpoint == null) throw new IllegalStateException("Spider is not initialized");

        String separator = endpoint.getQuery() == null ? "?" : "&";
        URI requestUri = URI.create(endpoint + separator + "filter=" + filter);
        HttpRequest request = HttpRequest.newBuilder(requestUri)
                .timeout(Duration.ofSeconds(30))
                .header("Accept", "application/json")
                .GET()
                .build();
        HttpResponse<String> response = client.send(
                request,
                HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8));
        if (response.statusCode() < 200 || response.statusCode() >= 300) {
            throw new IllegalStateException("Spider HTTP request failed: " + response.statusCode());
        }
        return response.body();
    }

    @Override
    public void destroy() {
        client = null;
        endpoint = null;
    }
}
