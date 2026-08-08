package com.qx.yingshi.androidhost;

import android.content.Context;
import android.os.Build;

import dalvik.system.DexClassLoader;
import dalvik.system.DexFile;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.Closeable;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.lang.reflect.Constructor;
import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Method;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Enumeration;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.UUID;

final class SpiderRuntime implements Closeable {
    private final Context context;
    private final Map<String, JarHandle> jars = new LinkedHashMap<>();
    private final Map<String, SpiderHandle> spiders = new LinkedHashMap<>();

    SpiderRuntime(Context context) {
        this.context = context.getApplicationContext();
    }

    synchronized JSONObject dispatch(String method, JSONObject params) throws RpcException {
        switch (method) {
            case "health":
                return health();
            case "runtimeInfo":
                return runtimeInfo();
            case "loadJar":
                return loadJar(params);
            case "unloadJar":
                return unloadJar(params);
            case "createSpider":
                return createSpider(params);
            case "destroySpider":
            case "destroy":
                return destroySpider(params);
            case "init":
                return init(params);
            case "homeContent":
                return homeContent(params);
            case "homeVideoContent":
                return homeVideoContent(params);
            case "categoryContent":
                return categoryContent(params);
            case "searchContent":
                return searchContent(params);
            case "detailContent":
                return detailContent(params);
            case "playerContent":
                return playerContent(params);
            case "proxy":
                return proxy(params);
            case "destroyAll":
                destroyAll();
                return object("destroyed", true);
            default:
                throw new RpcException("UNKNOWN_METHOD", "Unknown Android Spider Host method: " + method, "dispatch");
        }
    }

    private JSONObject health() {
        JSONArray abi = new JSONArray();
        for (String value : Build.SUPPORTED_ABIS) {
            abi.put(value);
        }
        return object(
                "status", "ok",
                "version", "0.1.0",
                "androidVersion", Build.VERSION.RELEASE,
                "sdkInt", Build.VERSION.SDK_INT,
                "abi", abi,
                "loadedJars", jars.size(),
                "activeSpiders", spiders.size(),
                "port", AndroidSpiderHost.PORT
        );
    }

    private JSONObject runtimeInfo() {
        return object(
                "packageName", context.getPackageName(),
                "filesDir", context.getFilesDir().getAbsolutePath(),
                "cacheDir", context.getCacheDir().getAbsolutePath(),
                "classLoader", context.getClassLoader().getClass().getName(),
                "internetPermission", "android.permission.INTERNET"
        );
    }

    private JSONObject loadJar(JSONObject params) throws RpcException {
        String sourcePath = firstString(params, "sourcePath", "jarPath");
        if (sourcePath.isEmpty()) {
            throw new RpcException("ARTIFACT_PATH_MISSING", "loadJar requires sourcePath", "loadJar");
        }
        File source = new File(sourcePath);
        if (!source.isFile()) {
            throw artifactError("ARTIFACT_FILE_MISSING", "Spider artifact file is missing: " + sourcePath, sourcePath);
        }
        String actualSha = sha256(source);
        String expectedSha = params.optString("sha256", "").trim().toLowerCase();
        if (!expectedSha.isEmpty() && !actualSha.equals(expectedSha)) {
            JSONObject diagnostics = object("sourcePath", sourcePath, "expectedSha256", expectedSha, "actualSha256", actualSha);
            throw new RpcException("JAR_TRANSFER_HASH_MISMATCH", "Android Host artifact SHA-256 does not match Windows artifact", "loadJar", diagnostics);
        }

        File cacheDir = new File(context.getFilesDir(), "spider-cache");
        if (!cacheDir.exists() && !cacheDir.mkdirs()) {
            throw new RpcException("ARTIFACT_CACHE_CREATE_FAILED", "Unable to create Android Spider cache directory", "loadJar");
        }
        File destination = new File(cacheDir, actualSha + ".jar");
        boolean cacheHit = destination.isFile() && destination.length() == source.length();
        try {
            if (!cacheHit) {
                copyFile(source, destination);
            }
        } catch (IOException error) {
            throw new RpcException("JAR_TRANSFER_FAILED", error.getMessage() == null ? "Unable to copy Spider artifact" : error.getMessage(), "loadJar");
        }
        String jarId = actualSha.substring(0, Math.min(16, actualSha.length()));
        String optimizedDir = new File(context.getCodeCacheDir(), "spider-dex").getAbsolutePath();
        File optimized = new File(optimizedDir);
        if (!optimized.exists()) {
            //noinspection ResultOfMethodCallIgnored
            optimized.mkdirs();
        }
        DexClassLoader loader;
        try {
            loader = new DexClassLoader(destination.getAbsolutePath(), optimizedDir, destination.getParent(), context.getClassLoader());
        } catch (RuntimeException error) {
            throw new RpcException("DEX_CLASSLOADER_FAILED", message(error), "loadJar", object("jarPath", destination.getAbsolutePath()));
        }
        JarHandle handle = new JarHandle(jarId, destination, actualSha, loader, candidateClasses(destination));
        jars.put(jarId, handle);
        return object(
                "jarId", jarId,
                "path", destination.getAbsolutePath(),
                "sha256", actualSha,
                "size", destination.length(),
                "candidateSpiderClasses", handle.candidateClasses,
                "cacheHit", cacheHit
        );
    }

    private JSONObject unloadJar(JSONObject params) {
        String jarId = params.optString("jarId", "");
        ArrayList<String> destroyed = new ArrayList<>();
        for (Map.Entry<String, SpiderHandle> entry : new ArrayList<>(spiders.entrySet())) {
            if (entry.getValue().jarId.equals(jarId)) {
                destroySpiderById(entry.getKey());
                destroyed.add(entry.getKey());
            }
        }
        boolean removed = jars.remove(jarId) != null;
        return object("jarId", jarId, "unloaded", removed, "destroyedSpiders", new JSONArray(destroyed));
    }

    private JSONObject createSpider(JSONObject params) throws RpcException {
        String jarId = params.optString("jarId", "");
        JarHandle jar = jars.get(jarId);
        if (jar == null) {
            throw new RpcException("JAR_NOT_LOADED", "Spider JAR is not loaded: " + jarId, "createSpider");
        }
        String api = params.optString("api", "").trim();
        String expectedClass = params.optString("expectedClass", SpiderClassResolver.expectedClass(api)).trim();
        if (expectedClass.isEmpty()) {
            throw new RpcException("SPIDER_CLASS_NAME_INVALID", "Unable to resolve Spider class from api: " + api, "createSpider", object("api", api, "jarPath", jar.path.getAbsolutePath()));
        }
        Class<?> spiderClass;
        try {
            spiderClass = jar.loader.loadClass(expectedClass);
        } catch (ClassNotFoundException error) {
            throw new RpcException(
                    "SPIDER_CLASS_NOT_FOUND",
                    "Spider class was not found: " + expectedClass,
                    "createSpider",
                    object("api", api, "expectedClass", expectedClass, "jarPath", jar.path.getAbsolutePath(), "classExists", false, "candidateSpiderClasses", jar.candidateClasses)
            );
        }

        Object instance;
        try {
            instance = instantiate(spiderClass);
        } catch (ReflectiveOperationException error) {
            throw new RpcException(
                    "SPIDER_INSTANTIATION_FAILED",
                    message(error),
                    "createSpider",
                    object("api", api, "expectedClass", expectedClass, "jarPath", jar.path.getAbsolutePath(), "classExists", true),
                    debugStack(params, error)
            );
        }
        String spiderId = UUID.randomUUID().toString();
        spiders.put(spiderId, new SpiderHandle(spiderId, jarId, api, expectedClass, instance));
        return object(
                "spiderId", spiderId,
                "jarId", jarId,
                "api", api,
                "resolvedClass", spiderClass.getName(),
                "expectedClass", expectedClass,
                "classExists", true
        );
    }

    private JSONObject init(JSONObject params) throws RpcException {
        SpiderHandle spider = requireSpider(params, "init");
        Object extValue = params.has("ext") ? params.opt("ext") : "";
        String ext = extValue == null || extValue == JSONObject.NULL ? "" : String.valueOf(extValue);
        long started = System.nanoTime();
        Object[][] candidates = new Object[][]{{context, ext}, {ext}, {context}};
        Method initMethod = findMethod(spider.instance.getClass(), "init", candidates);
        boolean contextDependent = initMethod != null && usesAndroidContext(initMethod);
        InvocationResult invocation;
        try {
            invocation = invokeRequiredDetailed(spider, "init", candidates, params);
        } catch (RpcException error) {
            JSONObject diagnostics = error.diagnostics == null ? new JSONObject() : error.diagnostics;
            put(diagnostics, "initDurationMs", (System.nanoTime() - started) / 1_000_000L);
            put(diagnostics, "initException", error.getMessage());
            put(diagnostics, "contextDependent", contextDependent);
            throw new RpcException(error.code, error.getMessage(), "init", diagnostics, error.debugStack);
        }
        Object result = invocation.value;
        spider.initialized = true;
        return object(
                "initialized", true,
                "initDurationMs", (System.nanoTime() - started) / 1_000_000L,
                "contextDependent", invocation.contextDependent,
                "methodResult", result == null ? JSONObject.NULL : result
        );
    }

    private JSONObject homeContent(JSONObject params) throws RpcException {
        SpiderHandle spider = requireInitialized(params, "homeContent");
        return resultObject(invokeRequired(spider, "homeContent", new Object[][]{{params.optBoolean("filter", false)}}, params));
    }

    private JSONObject homeVideoContent(JSONObject params) throws RpcException {
        SpiderHandle spider = requireInitialized(params, "homeVideoContent");
        return resultObject(invokeRequired(spider, "homeVideoContent", new Object[][]{{}}, params));
    }

    private JSONObject categoryContent(JSONObject params) throws RpcException {
        SpiderHandle spider = requireInitialized(params, "categoryContent");
        String typeId = params.optString("typeId", "");
        String page = params.optString("page", "1");
        boolean filter = params.optBoolean("filter", false);
        HashMap<String, String> extend = stringMap(params.optJSONObject("extend"));
        Object result = invokeRequired(spider, "categoryContent", new Object[][]{
                {typeId, page, filter, extend},
                {typeId, parseInt(page), filter, extend},
                {typeId, page, filter},
                {typeId, parseInt(page), filter}
        }, params);
        return resultObject(result);
    }

    private JSONObject searchContent(JSONObject params) throws RpcException {
        SpiderHandle spider = requireInitialized(params, "searchContent");
        String key = params.optString("keyword", params.optString("key", ""));
        boolean quick = params.optBoolean("quick", false);
        String page = params.optString("page", "1");
        Object result = invokeRequired(spider, "searchContent", new Object[][]{
                {key, quick, page},
                {key, quick, parseInt(page)},
                {key, quick}
        }, params);
        return resultObject(result);
    }

    private JSONObject detailContent(JSONObject params) throws RpcException {
        SpiderHandle spider = requireInitialized(params, "detailContent");
        JSONArray jsonIds = params.optJSONArray("ids");
        ArrayList<String> ids = new ArrayList<>();
        if (jsonIds != null) {
            for (int index = 0; index < jsonIds.length(); index++) {
                ids.add(jsonIds.optString(index));
            }
        }
        return resultObject(invokeRequired(spider, "detailContent", new Object[][]{{ids}}, params));
    }

    private JSONObject playerContent(JSONObject params) throws RpcException {
        SpiderHandle spider = requireInitialized(params, "playerContent");
        String flag = params.optString("flag", "");
        String id = params.optString("id", "");
        ArrayList<String> vipFlags = new ArrayList<>();
        JSONArray jsonFlags = params.optJSONArray("vipFlags");
        if (jsonFlags != null) {
            for (int index = 0; index < jsonFlags.length(); index++) {
                vipFlags.add(jsonFlags.optString(index));
            }
        }
        return resultObject(invokeRequired(spider, "playerContent", new Object[][]{{flag, id, vipFlags}, {flag, id}}, params));
    }

    private JSONObject proxy(JSONObject params) throws RpcException {
        SpiderHandle spider = requireInitialized(params, "proxy");
        JSONArray jsonArgs = params.optJSONArray("args");
        if (jsonArgs == null) jsonArgs = params.optJSONArray("params");
        String[] args = new String[jsonArgs == null ? 0 : jsonArgs.length()];
        for (int index = 0; index < args.length; index++) args[index] = jsonArgs.optString(index);
        Object[][] candidates = new Object[][]{{args}, {params.optString("url", "")}, {params}};
        try {
            return resultObject(invokeRequired(spider, "localProxy", candidates, params));
        } catch (RpcException missingLocalProxy) {
            if (!"SPIDER_METHOD_NOT_FOUND".equals(missingLocalProxy.code)) throw missingLocalProxy;
            return resultObject(invokeRequired(spider, "proxy", candidates, params));
        }
    }

    private SpiderHandle requireSpider(JSONObject params, String stage) throws RpcException {
        String spiderId = params.optString("spiderId", "");
        SpiderHandle spider = spiders.get(spiderId);
        if (spider == null) {
            throw new RpcException("SPIDER_NOT_CREATED", "Spider instance is not active: " + spiderId, stage);
        }
        return spider;
    }

    private SpiderHandle requireInitialized(JSONObject params, String stage) throws RpcException {
        SpiderHandle spider = requireSpider(params, stage);
        if (!spider.initialized) {
            throw new RpcException("SPIDER_NOT_INITIALIZED", "Spider instance has not been initialized: " + spider.spiderId, stage);
        }
        return spider;
    }

    private Object invokeRequired(SpiderHandle spider, String methodName, Object[][] candidates, JSONObject params) throws RpcException {
        return invokeRequiredDetailed(spider, methodName, candidates, params).value;
    }

    private InvocationResult invokeRequiredDetailed(SpiderHandle spider, String methodName, Object[][] candidates, JSONObject params) throws RpcException {
        Method method = findMethod(spider.instance.getClass(), methodName, candidates);
        if (method == null) {
            throw new RpcException("SPIDER_METHOD_NOT_FOUND", "Spider method is not available: " + methodName, methodName, object("api", spider.api, "resolvedClass", spider.expectedClass));
        }
        Object[] arguments = compatibleArguments(method, candidates);
        try {
            if (!method.isAccessible()) {
                method.setAccessible(true);
            }
            return new InvocationResult(method.invoke(spider.instance, arguments), usesAndroidContext(method));
        } catch (IllegalAccessException | InvocationTargetException | RuntimeException error) {
            Throwable cause = error instanceof InvocationTargetException && ((InvocationTargetException) error).getCause() != null
                    ? ((InvocationTargetException) error).getCause()
                    : error;
            String failureCode = message(cause).toLowerCase().contains("cleartext http traffic not permitted")
                    ? "CLEARTEXT_NOT_PERMITTED"
                    : "SPIDER_METHOD_FAILED";
            throw new RpcException(
                    failureCode,
                    message(cause),
                    methodName,
                    object("api", spider.api, "resolvedClass", spider.expectedClass, "method", methodName),
                    debugStack(params, cause)
            );
        }
    }

    private static Method findMethod(Class<?> type, String name, Object[][] candidates) {
        Method[] methods = type.getMethods();
        for (Object[] candidate : candidates) {
            for (Method method : methods) {
                if (method.getName().equals(name) && compatible(method.getParameterTypes(), candidate)) {
                    return method;
                }
            }
        }
        return null;
    }

    private static Object[] compatibleArguments(Method method, Object[][] candidates) {
        for (Object[] candidate : candidates) {
            if (compatible(method.getParameterTypes(), candidate)) {
                return candidate;
            }
        }
        return new Object[0];
    }

    private static boolean compatible(Class<?>[] types, Object[] values) {
        if (types.length != values.length) {
            return false;
        }
        for (int index = 0; index < types.length; index++) {
            if (values[index] == null) {
                if (types[index].isPrimitive()) {
                    return false;
                }
            } else if (!box(types[index]).isAssignableFrom(values[index].getClass())) {
                return false;
            }
        }
        return true;
    }

    private static Class<?> box(Class<?> type) {
        if (!type.isPrimitive()) return type;
        if (type == int.class) return Integer.class;
        if (type == boolean.class) return Boolean.class;
        if (type == long.class) return Long.class;
        if (type == double.class) return Double.class;
        if (type == float.class) return Float.class;
        if (type == short.class) return Short.class;
        if (type == byte.class) return Byte.class;
        if (type == char.class) return Character.class;
        return type;
    }

    private Object instantiate(Class<?> type) throws ReflectiveOperationException {
        try {
            Constructor<?> constructor = type.getDeclaredConstructor();
            if (!constructor.isAccessible()) constructor.setAccessible(true);
            return constructor.newInstance();
        } catch (NoSuchMethodException missingDefault) {
            Constructor<?> constructor = type.getDeclaredConstructor(Context.class);
            if (!constructor.isAccessible()) constructor.setAccessible(true);
            return constructor.newInstance(context);
        }
    }

    private void destroyAll() {
        for (String spiderId : new ArrayList<>(spiders.keySet())) {
            destroySpiderById(spiderId);
        }
        spiders.clear();
        jars.clear();
    }

    private JSONObject destroySpider(JSONObject params) {
        String spiderId = params.optString("spiderId", "");
        return object("spiderId", spiderId, "destroyed", destroySpiderById(spiderId));
    }

    private boolean destroySpiderById(String spiderId) {
        SpiderHandle spider = spiders.remove(spiderId);
        if (spider == null) return false;
        Method method = findMethod(spider.instance.getClass(), "destroy", new Object[][]{{}});
        if (method != null) {
            try {
                method.invoke(spider.instance);
            } catch (Exception ignored) {
                // Destruction must not bring down the Host.
            }
        }
        return true;
    }

    private static JSONObject resultObject(Object result) {
        if (result instanceof JSONObject) return (JSONObject) result;
        if (result instanceof JSONArray) return object("value", result);
        if (result == null) return object("value", JSONObject.NULL);
        String raw = String.valueOf(result).trim();
        try {
            return new JSONObject(raw);
        } catch (Exception ignored) {
            try {
                return object("value", new JSONArray(raw));
            } catch (Exception arrayIgnored) {
                return object("raw", raw);
            }
        }
    }

    private static boolean usesAndroidContext(Method method) {
        for (Class<?> parameter : method.getParameterTypes()) {
            if (Context.class.isAssignableFrom(parameter)) return true;
        }
        return false;
    }

    private static RpcException artifactError(String code, String message, String path) {
        return new RpcException(code, message, "loadJar", object("path", path));
    }

    private static String firstString(JSONObject params, String first, String second) {
        String value = params.optString(first, "").trim();
        return value.isEmpty() ? params.optString(second, "").trim() : value;
    }

    private static int parseInt(String value) {
        try {
            return Integer.parseInt(value);
        } catch (NumberFormatException ignored) {
            return 1;
        }
    }

    private static HashMap<String, String> stringMap(JSONObject value) {
        HashMap<String, String> result = new HashMap<>();
        if (value == null) return result;
        JSONArray names = value.names();
        if (names == null) return result;
        for (int index = 0; index < names.length(); index++) {
            String name = names.optString(index);
            result.put(name, value.optString(name, ""));
        }
        return result;
    }

    private static JSONArray candidateClasses(File jar) {
        JSONArray values = new JSONArray();
        try {
            DexFile dex = new DexFile(jar);
            Enumeration<String> entries = dex.entries();
            int count = 0;
            while (entries.hasMoreElements() && count < 200) {
                String name = entries.nextElement();
                if (name.contains(".spider.") || name.endsWith("Spider")) {
                    values.put(name);
                    count++;
                }
            }
            dex.close();
        } catch (IOException | RuntimeException ignored) {
            // Candidate enumeration is diagnostic only; class loading remains authoritative.
        }
        return values;
    }

    private static String sha256(File file) throws RpcException {
        try (FileInputStream input = new FileInputStream(file)) {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            byte[] buffer = new byte[64 * 1024];
            int read;
            while ((read = input.read(buffer)) >= 0) {
                if (read > 0) digest.update(buffer, 0, read);
            }
            StringBuilder result = new StringBuilder(64);
            for (byte value : digest.digest()) {
                result.append(String.format("%02x", value & 0xff));
            }
            return result.toString();
        } catch (Exception error) {
            throw new RpcException("ARTIFACT_HASH_FAILED", message(error), "loadJar");
        }
    }

    private static void copyFile(File source, File destination) throws IOException {
        File temporary = new File(destination.getParentFile(), destination.getName() + ".tmp");
        try (FileInputStream input = new FileInputStream(source); FileOutputStream output = new FileOutputStream(temporary)) {
            byte[] buffer = new byte[64 * 1024];
            int read;
            while ((read = input.read(buffer)) >= 0) {
                if (read > 0) output.write(buffer, 0, read);
            }
            output.getFD().sync();
        }
        if (!temporary.renameTo(destination)) {
            //noinspection ResultOfMethodCallIgnored
            temporary.delete();
            throw new IOException("Unable to atomically install Android Spider artifact");
        }
    }

    private static String message(Throwable error) {
        String value = error.getMessage();
        return value == null || value.trim().isEmpty() ? error.getClass().getName() : value;
    }

    private static String debugStack(JSONObject params, Throwable error) {
        if (!params.optBoolean("debugStack", false)) return null;
        StringBuilder result = new StringBuilder();
        for (StackTraceElement element : error.getStackTrace()) {
            result.append("\n  at ").append(element);
        }
        return result.toString();
    }

    private static JSONObject object(Object... values) {
        JSONObject result = new JSONObject();
        for (int index = 0; index + 1 < values.length; index += 2) {
            try {
                result.put(String.valueOf(values[index]), values[index + 1]);
            } catch (Exception error) {
                throw new IllegalStateException(error);
            }
        }
        return result;
    }

    private static void put(JSONObject object, String key, Object value) {
        try {
            object.put(key, value);
        } catch (Exception error) {
            throw new IllegalStateException(error);
        }
    }

    @Override
    public synchronized void close() {
        destroyAll();
    }

    private static final class JarHandle {
        final String jarId;
        final File path;
        final String sha256;
        final DexClassLoader loader;
        final JSONArray candidateClasses;

        JarHandle(String jarId, File path, String sha256, DexClassLoader loader, JSONArray candidateClasses) {
            this.jarId = jarId;
            this.path = path;
            this.sha256 = sha256;
            this.loader = loader;
            this.candidateClasses = candidateClasses;
        }
    }

    private static final class SpiderHandle {
        final String spiderId;
        final String jarId;
        final String api;
        final String expectedClass;
        final Object instance;
        boolean initialized;

        SpiderHandle(String spiderId, String jarId, String api, String expectedClass, Object instance) {
            this.spiderId = spiderId;
            this.jarId = jarId;
            this.api = api;
            this.expectedClass = expectedClass;
            this.instance = instance;
        }
    }

    private static final class InvocationResult {
        final Object value;
        final boolean contextDependent;

        InvocationResult(Object value, boolean contextDependent) {
            this.value = value;
            this.contextDependent = contextDependent;
        }
    }
}
