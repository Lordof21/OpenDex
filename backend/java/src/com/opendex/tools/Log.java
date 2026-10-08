package com.opendex.tools;

import java.text.SimpleDateFormat;
import java.util.Date;

/**
 * Structured, thread-safe daemon log (stdout/stderr → /data/local/tmp/opendex-daemon.log). Package-level so every
 * daemon component (AudioRouter, AudioStreamServer, …) logs the same way; the last ERROR is kept for the daemon's
 * {@code status} reply. The one-shot CLI tools that stream binary on stdout (IconExtractor) must not use it.
 */
final class Log {

    private static final ThreadLocal<SimpleDateFormat> FMT =
            ThreadLocal.withInitial(() -> new SimpleDateFormat("HH:mm:ss.SSS"));
    private static volatile String lastError;

    private Log() {}

    private static String ts() {
        return FMT.get().format(new Date());
    }

    static void info(String tag, String msg) {
        System.out.println(ts() + " INFO  [" + tag + "] " + msg);
    }

    static void warn(String tag, String msg) {
        System.err.println(ts() + " WARN  [" + tag + "] " + msg);
    }

    static void error(String tag, String msg) {
        lastError = msg;
        System.err.println(ts() + " ERROR [" + tag + "] " + msg);
    }

    static String lastError() {
        return lastError;
    }
}
