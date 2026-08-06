package com.qx.spike.host;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.io.OutputStreamWriter;
import java.io.PrintWriter;
import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Method;
import java.net.URL;
import java.net.URLClassLoader;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

public final class JvmSpiderHost {
    private static final PrintWriter OUTPUT = new PrintWriter(
            new OutputStreamWriter(System.out, StandardCharsets.UTF_8), true);

    private JvmSpiderHost() {
    }

    public static void main(String[] args) throws Exception {
        Options options = Options.parse(args);
        URL spiderUrl = Path.of(options.spiderJar).toUri().toURL();
        try (URLClassLoader loader = new URLClassLoader(
                new URL[]{spiderUrl},
                JvmSpiderHost.class.getClassLoader())) {
            Class<?> spiderClass = Class.forName(options.spiderClass, true, loader);
            if (!Spider.class.isAssignableFrom(spiderClass)) {
                throw new IllegalArgumentException("Spider class does not implement the host contract");
            }

            Object spider = spiderClass.getDeclaredConstructor().newInstance();
            Method init = spiderClass.getMethod("init", String.class);
            Method homeContent = spiderClass.getMethod("homeContent", boolean.class);
            Method categoryContent = spiderClass.getMethod(
                    "categoryContent",
                    String.class,
                    int.class,
                    boolean.class,
                    Map.class);
            Method detailContent = spiderClass.getMethod("detailContent", List.class);
            Method searchContent = spiderClass.getMethod(
                    "searchContent",
                    String.class,
                    boolean.class,
                    int.class);
            Method playerContent = spiderClass.getMethod(
                    "playerContent",
                    String.class,
                    String.class,
                    List.class);
            Method destroy = spiderClass.getMethod("destroy");
            boolean destroyed = false;

            emit(readyMessage());
            try (BufferedReader input = new BufferedReader(
                    new InputStreamReader(System.in, StandardCharsets.UTF_8))) {
                String line;
                while ((line = input.readLine()) != null) {
                    if (line.isBlank()) continue;

                    Map<String, Object> request;
                    Object requestId = null;
                    try {
                        request = JsonCodec.parseObject(line);
                        requestId = request.get("id");
                        String method = requireString(request.get("method"), "method");
                        Map<String, Object> params = requireObject(request.get("params"), "params");
                        Object result;
                        boolean stop = false;
                        switch (method) {
                            case "init" -> result = invoke(init, spider, requireString(params.get("ext"), "ext"));
                            case "home" -> result = normalizeJsonResult(
                                    invoke(homeContent, spider, requireBoolean(params.getOrDefault("filter", false), "filter")));
                            case "category" -> result = normalizeJsonResult(invoke(
                                    categoryContent,
                                    spider,
                                    requireString(params.get("typeId"), "typeId"),
                                    requireInt(params.get("page"), "page"),
                                    requireBoolean(params.getOrDefault("filter", false), "filter"),
                                    requireStringMap(params.getOrDefault("extend", Map.of()), "extend")));
                            case "detail" -> result = normalizeJsonResult(invoke(
                                    detailContent,
                                    spider,
                                    requireStringList(params.get("ids"), "ids")));
                            case "search" -> result = normalizeJsonResult(invoke(
                                    searchContent,
                                    spider,
                                    requireString(params.get("key"), "key"),
                                    requireBoolean(params.getOrDefault("quick", false), "quick"),
                                    requireInt(params.get("page"), "page")));
                            case "player" -> result = normalizeJsonResult(invoke(
                                    playerContent,
                                    spider,
                                    requireString(params.get("flag"), "flag"),
                                    requireString(params.get("id"), "id"),
                                    requireStringList(params.getOrDefault("vipFlags", List.of()), "vipFlags")));
                            case "destroy" -> {
                                result = invoke(destroy, spider);
                                destroyed = true;
                                stop = true;
                            }
                            default -> throw new IllegalArgumentException("Unsupported JVM Spider method: " + method);
                        }
                        if (method.equals("init")) {
                            Map<String, Object> initialized = new LinkedHashMap<>();
                            initialized.put("initialized", true);
                            result = initialized;
                        } else if (method.equals("destroy")) {
                            Map<String, Object> destroyedResult = new LinkedHashMap<>();
                            destroyedResult.put("destroyed", true);
                            result = destroyedResult;
                        }
                        emit(successResponse(requestId, result));
                        if (stop) break;
                    } catch (Throwable error) {
                        emit(errorResponse(requestId, error));
                    }
                }
            } finally {
                if (!destroyed) invoke(destroy, spider);
            }
        }
    }

    private static Object invoke(Method method, Object target, Object... args) throws Exception {
        try {
            return method.invoke(target, args);
        } catch (InvocationTargetException error) {
            Throwable cause = error.getCause();
            if (cause instanceof Exception exception) throw exception;
            if (cause instanceof Error fatal) throw fatal;
            throw new Exception(cause);
        }
    }

    private static Map<String, Object> readyMessage() {
        Map<String, Object> message = new LinkedHashMap<>();
        message.put("type", "ready");
        message.put("protocol", "jvm-spider-rpc/1");
        return message;
    }

    private static Map<String, Object> successResponse(Object requestId, Object result) {
        Map<String, Object> response = new LinkedHashMap<>();
        response.put("id", requestId);
        response.put("ok", true);
        response.put("result", result);
        return response;
    }

    private static Map<String, Object> errorResponse(Object requestId, Throwable error) {
        Map<String, Object> response = new LinkedHashMap<>();
        response.put("id", requestId);
        response.put("ok", false);
        Map<String, Object> details = new LinkedHashMap<>();
        details.put("code", "JVM_SPIDER_ERROR");
        details.put("message", error.getMessage() == null ? error.getClass().getName() : error.getMessage());
        response.put("error", details);
        return response;
    }

    private static String requireString(Object value, String field) {
        if (value instanceof String string) return string;
        throw new IllegalArgumentException("JVM RPC field must be a string: " + field);
    }

    private static boolean requireBoolean(Object value, String field) {
        if (value instanceof Boolean booleanValue) return booleanValue;
        throw new IllegalArgumentException("JVM RPC field must be a boolean: " + field);
    }

    private static Object normalizeJsonResult(Object value) {
        if (!(value instanceof String json)) {
            throw new IllegalArgumentException("Spider JSON method must return a JSON string");
        }
        return JsonCodec.parse(json);
    }

    private static int requireInt(Object value, String field) {
        if (value instanceof Number number) {
            long integer = number.longValue();
            if (number.doubleValue() == integer
                    && integer >= Integer.MIN_VALUE
                    && integer <= Integer.MAX_VALUE) {
                return (int) integer;
            }
        }
        throw new IllegalArgumentException("JVM RPC field must be an integer: " + field);
    }

    private static Map<String, String> requireStringMap(Object value, String field) {
        Map<String, Object> raw = requireObject(value, field);
        Map<String, String> result = new LinkedHashMap<>();
        for (Map.Entry<String, Object> entry : raw.entrySet()) {
            if (!(entry.getValue() instanceof String string)) {
                throw new IllegalArgumentException(
                        "JVM RPC map values must be strings: " + field);
            }
            result.put(entry.getKey(), string);
        }
        return result;
    }

    private static List<String> requireStringList(Object value, String field) {
        if (!(value instanceof List<?> raw)) {
            throw new IllegalArgumentException("JVM RPC field must be an array: " + field);
        }
        java.util.ArrayList<String> result = new java.util.ArrayList<>();
        for (Object item : raw) {
            if (!(item instanceof String string)) {
                throw new IllegalArgumentException(
                        "JVM RPC array values must be strings: " + field);
            }
            result.add(string);
        }
        return result;
    }

    private static Map<String, Object> requireObject(Object value, String field) {
        if (!(value instanceof Map<?, ?> raw)) {
            throw new IllegalArgumentException("JVM RPC field must be an object: " + field);
        }
        Map<String, Object> result = new LinkedHashMap<>();
        for (Map.Entry<?, ?> entry : raw.entrySet()) {
            if (!(entry.getKey() instanceof String key)) {
                throw new IllegalArgumentException("JVM RPC object key must be a string: " + field);
            }
            result.put(key, entry.getValue());
        }
        return result;
    }

    private static void emit(Map<String, Object> message) {
        OUTPUT.println(JsonCodec.stringify(message));
    }

    private static final class Options {
        private final String spiderJar;
        private final String spiderClass;

        private Options(String spiderJar, String spiderClass) {
            this.spiderJar = spiderJar;
            this.spiderClass = spiderClass;
        }

        private static Options parse(String[] args) {
            String spiderJar = null;
            String spiderClass = null;
            for (int index = 0; index < args.length; index++) {
                switch (args[index]) {
                    case "--spider" -> spiderJar = next(args, ++index, "--spider");
                    case "--class" -> spiderClass = next(args, ++index, "--class");
                    default -> throw new IllegalArgumentException("Unknown argument: " + args[index]);
                }
            }
            if (spiderJar == null || spiderClass == null) {
                throw new IllegalArgumentException("Required arguments: --spider <jar> --class <name>");
            }
            return new Options(spiderJar, spiderClass);
        }

        private static String next(String[] args, int index, String option) {
            if (index >= args.length) throw new IllegalArgumentException("Missing value for " + option);
            return args[index];
        }
    }
}
