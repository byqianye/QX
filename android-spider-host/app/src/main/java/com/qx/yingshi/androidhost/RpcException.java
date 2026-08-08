package com.qx.yingshi.androidhost;

import org.json.JSONObject;

final class RpcException extends Exception {
    final String code;
    final String stage;
    final JSONObject diagnostics;
    final String debugStack;

    RpcException(String code, String message, String stage) {
        this(code, message, stage, null, null);
    }

    RpcException(String code, String message, String stage, JSONObject diagnostics) {
        this(code, message, stage, diagnostics, null);
    }

    RpcException(String code, String message, String stage, JSONObject diagnostics, String debugStack) {
        super(message);
        this.code = code;
        this.stage = stage;
        this.diagnostics = diagnostics;
        this.debugStack = debugStack;
    }
}
