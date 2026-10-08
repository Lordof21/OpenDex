package com.opendex.tools;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.FileOutputStream;
import java.io.IOException;
import java.util.ArrayList;
import java.util.List;

/**
 * On-device check for per-app audio. Runs the SAME
 * {@link AudioRouter.AppCapture} the daemon uses, so a pass here means the production path works on this device.
 *
 * Usage (adb shell):
 *   CLASSPATH=/data/local/tmp/opendex-tools.jar app_process / com.opendex.tools.AudioProbe \
 *       <pkg>[,<pkg2>…] [seconds=5] [route=pc|both]
 *
 * Start playback in the app(s) first. Several packages at once show whether N policies coexist in one process. Raw PCM
 * (s16le, stereo, 48 kHz) lands in /data/local/tmp/opendex-audio-probe-<pkg>.pcm; ONE JSON line is printed:
 *   {"ok", "sdk", "results": [{"package", "uid", "registered", "bytes", "peak", "unregister", "error"}]}
 *   registered = the policy was accepted under the shell identity, unregister = how it was released (method name, or
 *   "failed: …"), audible capture = peak > 0.
 * After the probe exits, the app must be audible on the phone again (the policy was really released).
 */
public final class AudioProbe {

    private AudioProbe() {}

    public static void main(String[] args) {
        if (args.length < 1 || args[0].trim().isEmpty()) {
            System.out.println(Json.obj("ok", false, "error", "usage: AudioProbe <pkg>[,<pkg2>] [seconds] [pc|both]"));
            return;
        }
        int seconds = args.length > 1 ? Math.max(1, Math.min(60, Integer.parseInt(args[1]))) : 5;
        AudioRouter.Route route = AudioRouter.Route.parse(args.length > 2 ? args[2] : "pc");
        if (route == null || route == AudioRouter.Route.PHONE) route = AudioRouter.Route.PC;

        List<Probe> probes = new ArrayList<>();
        int streamId = 1;
        for (String pkg : args[0].split(",")) {
            if (!pkg.trim().isEmpty()) probes.add(new Probe(pkg.trim(), streamId++));
        }
        for (Probe p : probes) p.start(route);
        try {
            Thread.sleep(seconds * 1000L);
        } catch (InterruptedException ignored) {}
        JSONArray results = new JSONArray();
        boolean allOk = !probes.isEmpty();
        for (Probe p : probes) {
            p.stop();
            results.put(p.json());
            allOk &= p.error == null && p.capture != null && p.capture.unregisterPath != null
                    && !p.capture.unregisterPath.startsWith("failed");
        }
        System.out.println(Json.obj("ok", allOk, "sdk", android.os.Build.VERSION.SDK_INT, "seconds", seconds,
                "route", route.wire(), "results", results));
        System.exit(0);   // SystemContext's looper/binder threads would otherwise keep app_process alive
    }

    private static final class Probe implements AudioRouter.Sink {
        final String pkg;
        final int streamId;
        AudioRouter.AppCapture capture;
        FileOutputStream out;
        String error;
        int uid = -1;
        long bytes;
        int peak;

        Probe(String pkg, int streamId) {
            this.pkg = pkg;
            this.streamId = streamId;
        }

        void start(AudioRouter.Route route) {
            try {
                uid = AudioRouter.resolveUid(pkg);
                out = new FileOutputStream("/data/local/tmp/opendex-audio-probe-" + pkg + ".pcm");
                capture = new AudioRouter.AppCapture(pkg, uid, route, streamId, this);
                capture.start();
            } catch (Throwable t) {
                error = t.toString();
                capture = null;
            }
        }

        void stop() {
            if (capture != null) capture.stop();
            if (out != null) {
                try { out.close(); } catch (IOException ignored) {}
            }
        }

        @Override
        public synchronized void onPcm(int id, long ptsUs, byte[] data, int len) {
            bytes += len;
            for (int i = 0; i + 1 < len; i += 2) {
                int s = (short) ((data[i] & 0xFF) | (data[i + 1] << 8));
                int a = Math.abs(s);
                if (a > peak) peak = a;
            }
            try {
                out.write(data, 0, len);
            } catch (IOException e) {
                error = "write: " + e.getMessage();
            }
        }

        @Override
        public void onEnd(int id) {}

        synchronized JSONObject json() {
            return Json.obj("package", pkg, "uid", uid, "registered", capture != null, "bytes", bytes,
                    "peak", peak, "unregister", capture != null ? capture.unregisterPath : null, "error", error);
        }
    }
}
