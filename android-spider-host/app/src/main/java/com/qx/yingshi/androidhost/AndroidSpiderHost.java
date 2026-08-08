package com.qx.yingshi.androidhost;

import android.content.Context;

import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.BufferedWriter;
import java.io.Closeable;
import java.io.IOException;
import java.io.InputStreamReader;
import java.io.OutputStreamWriter;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

final class AndroidSpiderHost implements Closeable {
    static final int PROTOCOL_VERSION = 1;
    static final int PORT = 8765;

    private final SpiderRuntime runtime;
    private final ExecutorService clients = Executors.newCachedThreadPool();
    private volatile boolean running;
    private ServerSocket server;
    private Thread acceptThread;

    AndroidSpiderHost(Context context) {
        runtime = new SpiderRuntime(context);
    }

    synchronized void start() throws IOException {
        if (running) return;
        server = new ServerSocket(PORT, 32, InetAddress.getByName("127.0.0.1"));
        running = true;
        acceptThread = new Thread(this::acceptLoop, "qx-android-spider-accept");
        acceptThread.setDaemon(true);
        acceptThread.start();
    }

    private void acceptLoop() {
        while (running) {
            try {
                Socket socket = server.accept();
                clients.execute(() -> serve(socket));
            } catch (IOException error) {
                if (running) {
                    // The next health request will expose that the Host is offline.
                }
            }
        }
    }

    private void serve(Socket socket) {
        try (Socket active = socket;
             BufferedReader reader = new BufferedReader(new InputStreamReader(active.getInputStream(), StandardCharsets.UTF_8));
             BufferedWriter writer = new BufferedWriter(new OutputStreamWriter(active.getOutputStream(), StandardCharsets.UTF_8))) {
            String line;
            while (running && (line = reader.readLine()) != null) {
                if (line.trim().isEmpty()) continue;
                JSONObject response = handle(line);
                writer.write(response.toString());
                writer.write('\n');
                writer.flush();
            }
        } catch (IOException ignored) {
            // A disconnected Bridge is expected during stop/restart.
        }
    }

    private JSONObject handle(String line) {
        JSONObject request;
        try {
            request = new JSONObject(line);
        } catch (Exception error) {
            return errorResponse(null, new RpcException("PROTOCOL_INVALID_JSON", "Invalid JSON request", "protocol"));
        }
        Object requestId = request.has("id") ? request.opt("id") : JSONObject.NULL;
        int protocolVersion = request.optInt("protocolVersion", 0);
        if (protocolVersion != PROTOCOL_VERSION) {
            return errorResponse(requestId, new RpcException("PROTOCOL_VERSION_UNSUPPORTED", "Expected protocolVersion 1", "protocol"));
        }
        String method = request.optString("method", "").trim();
        if (method.isEmpty()) {
            return errorResponse(requestId, new RpcException("PROTOCOL_METHOD_MISSING", "RPC method is missing", "protocol"));
        }
        JSONObject params = request.optJSONObject("params");
        if (params == null) params = new JSONObject();
        try {
            JSONObject result = runtime.dispatch(method, params);
            return successResponse(requestId, result);
        } catch (RpcException error) {
            return errorResponse(requestId, error);
        } catch (RuntimeException error) {
            RpcException wrapped = new RpcException("HOST_INTERNAL_ERROR", error.getMessage() == null ? "Host internal error" : error.getMessage(), method);
            return errorResponse(requestId, wrapped);
        }
    }

    private static JSONObject successResponse(Object id, JSONObject result) {
        return object("id", id == null ? JSONObject.NULL : id, "protocolVersion", PROTOCOL_VERSION, "success", true, "result", result);
    }

    private static JSONObject errorResponse(Object id, RpcException error) {
        JSONObject details = object("code", error.code, "message", error.getMessage(), "stage", error.stage);
        if (error.diagnostics != null) put(details, "diagnostics", error.diagnostics);
        if (error.debugStack != null) put(details, "debugStack", error.debugStack);
        return object("id", id == null ? JSONObject.NULL : id, "protocolVersion", PROTOCOL_VERSION, "success", false, "error", details);
    }

    private static void put(JSONObject object, String key, Object value) {
        try {
            object.put(key, value);
        } catch (Exception error) {
            throw new IllegalStateException(error);
        }
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

    @Override
    public synchronized void close() {
        running = false;
        runtime.close();
        clients.shutdownNow();
        if (server != null) {
            try {
                server.close();
            } catch (IOException ignored) {
                // Already stopped.
            }
        }
        server = null;
    }
}
