package com.github.catvod.crawler;

import android.util.Log;

public final class SpiderDebug {
    private static final String TAG = SpiderDebug.class.getSimpleName();

    private SpiderDebug() {
    }

    public static void log(Throwable error) {
        Log.d(TAG, error == null ? "null" : String.valueOf(error.getMessage()), error);
    }

    public static void log(String message) {
        Log.d(TAG, message);
    }
}
