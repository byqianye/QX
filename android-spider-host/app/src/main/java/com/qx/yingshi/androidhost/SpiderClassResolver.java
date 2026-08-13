package com.qx.yingshi.androidhost;

import java.util.Locale;

final class SpiderClassResolver {
    private SpiderClassResolver() {
    }

    static String expectedClass(String api) {
        if (api == null) {
            return "";
        }
        String normalized = api.trim();
        if (normalized.regionMatches(true, 0, "csp_", 0, 4)) {
            normalized = normalized.substring(4);
        }
        if (normalized.isEmpty() || !normalized.matches("[A-Za-z_$][A-Za-z0-9_$]*")) {
            return "";
        }
        return "com.github.catvod.spider." + normalized;
    }

    static boolean isExpectedClass(String api, String expectedClass) {
        String expected = expectedClass(api);
        return !expected.isEmpty() && expected.equals(expectedClass);
    }

    static String simpleName(String api) {
        String expected = expectedClass(api);
        int separator = expected.lastIndexOf('.');
        return separator < 0 ? expected : expected.substring(separator + 1);
    }

    static String normalizedApi(String api) {
        return api == null ? "" : api.trim().toLowerCase(Locale.ROOT);
    }
}
