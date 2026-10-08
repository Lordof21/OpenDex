package com.opendex.tools;

import android.os.IBinder;
import android.os.ParcelFileDescriptor;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.Callable;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;

/**
 * A service's dump read IN this process: what `dumpsys <service>` prints, without forking `sh` + `dumpsys` (and, from
 * the host, adbd's shell service) for it. {@code IBinder.dumpAsync} is oneway, so a service that never finishes writing
 * cannot block the caller: the reader gives up after the timeout and closes the pipe.
 *
 * Only for the few services with no structured API for what OpenDeX needs (see {@link #ALLOWED}); everything that has
 * one (notifications, thermal status, tasks, focus, power) is read through that API instead.
 */
final class BinderDump {

    /** Services the daemon's `dump` RPC may read. */
    static final java.util.Set<String> ALLOWED = new java.util.HashSet<>(java.util.Arrays.asList(
            "battery", "SurfaceFlinger", "window"));

    private static final int MAX_BYTES = 8 * 1024 * 1024;
    private static final ExecutorService READERS = Executors.newCachedThreadPool(r -> {
        Thread t = new Thread(r, "OpenDex-DumpReader");
        t.setDaemon(true);
        return t;
    });

    private BinderDump() {}

    /** The dump text; throws when the service is missing or the dump did not finish within {@code timeoutMs}. */
    static String dump(String service, String[] args, long timeoutMs) throws Exception {
        Object raw = Class.forName("android.os.ServiceManager").getMethod("getService", String.class).invoke(null, service);
        if (!(raw instanceof IBinder)) throw new IllegalStateException("service not found: " + service);
        IBinder binder = (IBinder) raw;

        ParcelFileDescriptor[] pipe = ParcelFileDescriptor.createPipe();
        final ParcelFileDescriptor readEnd = pipe[0];
        Future<String> text = READERS.submit((Callable<String>) () -> {
            try (InputStream in = new ParcelFileDescriptor.AutoCloseInputStream(readEnd)) {
                ByteArrayOutputStream out = new ByteArrayOutputStream(16 * 1024);
                byte[] buf = new byte[16 * 1024];
                int n;
                while ((n = in.read(buf)) > 0) {
                    if (out.size() + n > MAX_BYTES) break; // a runaway dump is cut, never buffered without bound
                    out.write(buf, 0, n);
                }
                return new String(out.toByteArray(), StandardCharsets.UTF_8);
            }
        });
        try {
            binder.dumpAsync(pipe[1].getFileDescriptor(), args == null ? new String[0] : args);
        } finally {
            pipe[1].close(); // the service writes into its own dup; EOF arrives when it is done
        }
        try {
            return text.get(timeoutMs, TimeUnit.MILLISECONDS);
        } catch (java.util.concurrent.TimeoutException e) {
            text.cancel(true);
            try { readEnd.close(); } catch (Throwable ignored) {}
            throw new IllegalStateException("dump " + service + " timed out after " + timeoutMs + " ms");
        }
    }
}
