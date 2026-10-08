package com.opendex.tools;

import android.content.Context;
import android.content.pm.PackageManager;
import android.media.AudioFormat;
import android.media.AudioManager;
import android.media.AudioRecord;
import android.os.Build;
import android.os.Process;

import org.json.JSONArray;
import org.json.JSONObject;

import java.lang.reflect.Method;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Per-app audio capture: one AudioPolicy + AudioMix(RULE_MATCH_UID) +
 * AudioRecord per package.
 *
 * Route semantics (per package):
 *   pc    → ROUTE_FLAG_LOOP_BACK        : the app is heard ONLY on the PC (phone speaker silent for this app)
 *   both  → ROUTE_FLAG_LOOP_BACK_RENDER : heard on the PC AND on the phone — the phone plays it at once, the PC copy
 *                                         arrives later (network + buffers): an echo of 100–300 ms
 *   both + target → ROUTE_FLAG_LOOP_BACK + {@link PhoneRender}: the app is silent on the phone and the daemon plays the
 *                                         captured PCM itself, placed so each chunk is PRESENTED {@code target} ms after
 *                                         it was captured (the DeX page uses the same instants): both copies come out
 *                                         TOGETHER. If the phone-side track cannot be built the capture falls back to
 *                                         LOOP_BACK_RENDER (never silence) and the reply says {@code sync:false}.
 *   phone → no policy at all            : the app plays on the phone as if OpenDeX did not exist
 *
 * Everything not matched by a policy (notifications, calls, alarms, apps without a window) keeps playing on the phone
 * untouched. The hidden android.media.audiopolicy API is reached by reflection (same approach as scrcpy's
 * AudioPlaybackCapture, Apache-2.0 — written from scratch here); requires API 33+.
 *
 * Invariant: a registered policy is ALWAYS paired with a live capture in {@link #captures}. A policy left behind
 * keeps its app silent on the phone ("pc" route), so every exit path (route change, stop, capture failure, idle,
 * shutdown) goes through {@link AppCapture#stop()}.
 */
final class AudioRouter {

    static final int SAMPLE_RATE = 48_000;
    static final int CHANNELS = 2;
    static final int BYTES_PER_FRAME = 2 * CHANNELS;
    /** 20 ms per read → 960 frames → 3840 bytes: small enough for latency, large enough for syscall overhead. */
    static final int CHUNK_BYTES = SAMPLE_RATE / 50 * BYTES_PER_FRAME;
    static final int MAX_CAPTURES = 8;
    static final int MIN_SDK = 33;

    enum Route {
        PC, BOTH, PHONE;

        /** Unknown words are rejected (null), never silently mapped to "pc". */
        static Route parse(String s) {
            if (s == null) return null;
            switch (s.toLowerCase()) {
                case "pc": return PC;
                case "both": return BOTH;
                case "phone": return PHONE;
                default: return null;
            }
        }

        String wire() {
            return name().toLowerCase();
        }
    }

    /** Where a capture's PCM goes: the daemon's {@link AudioStreamServer}, or a file for {@link AudioProbe}. */
    interface Sink {
        void onPcm(int streamId, long ptsUs, byte[] data, int len);

        void onEnd(int streamId);
    }

    static final Sink STREAM_SINK = new Sink() {
        @Override
        public void onPcm(int streamId, long ptsUs, byte[] data, int len) {
            AudioStreamServer.send(streamId, 0, ptsUs, data, len);
        }

        @Override
        public void onEnd(int streamId) {
            AudioStreamServer.send(streamId, AudioStreamServer.FLAG_END, System.nanoTime() / 1000, new byte[0], 0);
        }
    };

    private static final Map<String, AppCapture> captures = new LinkedHashMap<>();
    /** Tears down captures that died on their own — never on the capture's own reader thread (it would join itself). */
    private static final ExecutorService reaper = Executors.newSingleThreadExecutor(r -> {
        Thread t = new Thread(r, "OpenDex-AudioReaper");
        t.setDaemon(true);
        return t;
    });
    private static int nextStreamId = 1;
    /** The calibration probe's own phone track (at most one); guarded by AudioRouter.class. */
    private static PhoneRender probeRender;
    private static final int MAX_PROBES = 10;
    private static final int MIN_PROBE_SPACING_MS = 300;
    private static final int MAX_PROBE_SPACING_MS = 1500;
    private static final int MIN_PROBE_LEAD_MS = 300;
    private static final int MAX_PROBE_LEAD_MS = 2000;
    private static final int PROBE_PRIME_MS = 150;
    private static final long PROBE_TAIL_MS = 1000;

    private AudioRouter() {}

    static boolean supported() {
        return Build.VERSION.SDK_INT >= MIN_SDK;
    }

    /** audio_route without alignment: "both" is the app's own phone playback plus the PC copy. */
    static synchronized JSONObject setRoute(String pkg, Route route) {
        return setRoute(pkg, route, -1);
    }

    /**
     * audio_route: idempotent — same package + same route is a no-op returning the live stream.
     * @param phoneTargetMs for {@link Route#BOTH}: &gt;= 0 asks for the phone copy to be presented that many ms after its
     *                      capture time (the DeX page presents the PC copy at the same instants); &lt; 0 keeps the app's
     *                      own, immediate phone playback.
     */
    static synchronized JSONObject setRoute(String pkg, Route route, int phoneTargetMs) {
        if (!supported()) return Json.put(failure(pkg, "unsupported_api"), "sdk", Build.VERSION.SDK_INT);
        final boolean wantSync = route == Route.BOTH && phoneTargetMs >= 0;
        AppCapture existing = captures.get(pkg);
        if (route == Route.PHONE) {
            if (existing != null) {
                captures.remove(pkg);
                existing.stop();
            }
            return result(pkg, null, Route.PHONE);
        }
        if (existing != null && existing.route == route && existing.isLive()
                && existing.wantsSync() == wantSync) {
            if (wantSync && existing.isSyncing()) existing.setTargetMs(phoneTargetMs);   // same capture, retuned in place
            return result(pkg, existing, route);
        }
        if (existing != null) {
            captures.remove(pkg);
            existing.stop();
        }
        if (captures.size() >= MAX_CAPTURES) return failure(pkg, "too_many_captures");
        int uid;
        try {
            uid = resolveUid(pkg);
        } catch (PackageManager.NameNotFoundException e) {
            return failure(pkg, "package_not_found");
        } catch (Throwable t) {
            return failure(pkg, "uid_lookup_failed: " + t.getMessage());
        }
        for (AppCapture c : captures.values()) {
            if (c.uid == uid) {
                // Shared UID (two packages of one vendor): a second policy for the same UID would fight the first.
                return Json.put(failure(pkg, "uid_already_captured"), "owner", c.pkg);
            }
        }
        AppCapture capture = new AppCapture(pkg, uid, route, allocateStreamId(), STREAM_SINK, wantSync ? phoneTargetMs : -1);
        try {
            capture.start();
        } catch (Throwable t) {
            // start() released whatever it had registered — nothing half-built survives.
            Log.warn("AudioRouter", "capture start failed pkg=" + pkg + ": " + t);
            return failure(pkg, "capture_failed: " + rootMessage(t));
        }
        captures.put(pkg, capture);
        return result(pkg, capture, route);
    }

    /** audio_target: retunes the phone copy of a syncing capture without touching the capture itself. */
    static synchronized JSONObject setTarget(String pkg, int targetMs) {
        AppCapture c = captures.get(pkg);
        if (c == null || !c.isSyncing()) return failure(pkg, "not_syncing");
        c.setTargetMs(targetMs);
        return result(pkg, c, c.route);
    }

    /**
     * audio_probe: plays {@code count} test tones (see {@link ProbeTone}) on the phone through a track of its own, each
     * presented {@code phoneTargetMs} after a PTS this call returns — the same rule the live phone copy follows. The DeX
     * page plays its own tone at the PC's matching instants and listens to both with the laptop's microphone; the gap it
     * hears is the alignment's real error (calibration, frontend/src/media/syncCalibration.js). Nothing here touches a
     * live capture. Replies {ok, pts_us: [...], target_ms, spacing_ms} — the first PTS is {@code leadMs} ahead of the reply.
     */
    static synchronized JSONObject probe(int phoneTargetMs, int count, int spacingMs, int leadMs) {
        final int target = Math.max(0, Math.min(PhoneRender.MAX_TARGET_MS, phoneTargetMs));
        final int n = Math.max(2, Math.min(MAX_PROBES, count));
        final int spacing = Math.max(MIN_PROBE_SPACING_MS, Math.min(MAX_PROBE_SPACING_MS, spacingMs));
        final int lead = Math.max(MIN_PROBE_LEAD_MS, Math.min(MAX_PROBE_LEAD_MS, leadMs));
        closeProbe();
        final PhoneRender render;
        try {
            render = PhoneRender.create(target, PROBE_PRIME_MS);
        } catch (Throwable t) {
            Log.warn("AudioRouter", "probe track unavailable: " + t);
            return Json.obj("type", "audio_result", "ok", false, "error", "probe_unavailable: " + rootMessage(t));
        }
        probeRender = render;
        byte[] tone = ProbeTone.phoneChunk(ProbeTone.AMPLITUDE);
        long base = System.nanoTime() + lead * 1_000_000L;            // after the track is primed: the lead is real
        JSONArray pts = new JSONArray();
        for (int i = 0; i < n; i++) {
            long ptsNanos = base + i * spacing * 1_000_000L;
            render.offer(tone, tone.length, ptsNanos);
            pts.put(ptsNanos / 1000L);
        }
        final long lifeMs = lead + (long) n * spacing + target + PROBE_TAIL_MS;
        Thread closer = new Thread(() -> {
            try {
                Thread.sleep(lifeMs);
            } catch (InterruptedException ignored) {
                // the daemon is going down: close below
            }
            synchronized (AudioRouter.class) {
                if (probeRender == render) probeRender = null;
            }
            render.close();
        }, "OpenDex-AudioProbe");
        closer.setDaemon(true);
        closer.start();
        Log.info("AudioRouter", "probe: " + n + " tones, target=" + target + "ms spacing=" + spacing + "ms");
        return Json.obj("type", "audio_result", "ok", true, "pts_us", pts, "target_ms", target, "spacing_ms", spacing);
    }

    private static void closeProbe() {
        PhoneRender r = probeRender;
        probeRender = null;
        if (r != null) r.close();
    }

    static synchronized JSONObject stop(String pkg) {
        AppCapture c = captures.remove(pkg);
        if (c != null) c.stop();
        return result(pkg, null, Route.PHONE);
    }

    /** Every app back to the phone. Shutdown hook / last control client gone. */
    static synchronized void stopAll() {
        closeProbe();
        if (captures.isEmpty()) return;
        for (AppCapture c : captures.values()) c.stop();
        captures.clear();
        Log.info("AudioRouter", "all captures stopped — app sound is back on the phone");
    }

    static synchronized JSONObject list() {
        JSONArray arr = new JSONArray();
        for (AppCapture c : captures.values()) {
            arr.put(Json.obj("package", c.pkg, "uid", c.uid, "stream_id", c.streamId,
                    "route", c.route.wire(), "state", c.state, "sync", c.isSyncing(), "target_ms", c.targetMs()));
        }
        return Json.obj("type", "audio_list", "ok", true, "supported", supported(),
                "sdk", Build.VERSION.SDK_INT, "streams", arr);
    }

    /** Called from a capture's reader thread when AudioRecord died under it (audioserver restart, …). */
    private static void onCaptureDied(AppCapture dead) {
        reaper.execute(() -> {
            synchronized (AudioRouter.class) {
                if (captures.get(dead.pkg) == dead) captures.remove(dead.pkg);
            }
            dead.stop();   // idempotent; sends FLAG_END so the backend knows the stream is gone
        });
    }

    private static int allocateStreamId() {
        int id = nextStreamId;
        nextStreamId = id >= 0xFFFF ? 1 : id + 1;   // u16 on the wire; 0 is never used
        return id;
    }

    private static JSONObject result(String pkg, AppCapture c, Route route) {
        JSONObject o = Json.obj("type", "audio_result", "ok", true, "package", pkg, "route", route.wire());
        if (c != null) {
            Json.put(o, "stream_id", c.streamId);
            Json.put(o, "uid", c.uid);
            Json.put(o, "sync", c.isSyncing());
            if (c.isSyncing()) Json.put(o, "target_ms", c.targetMs());
        }
        return o;
    }

    private static JSONObject failure(String pkg, String error) {
        return Json.obj("type", "audio_result", "ok", false, "package", pkg, "error", error);
    }

    private static String rootMessage(Throwable t) {
        Throwable root = t;
        while (root.getCause() != null && root.getCause() != root) root = root.getCause();
        String msg = root.getMessage();
        return root.getClass().getSimpleName() + (msg != null ? ": " + msg : "");
    }

    static int resolveUid(String pkg) throws Exception {
        Context ctx = ShellContext.get();
        if (ctx == null) throw new IllegalStateException("no system context: " + SystemContext.lastError());
        return ctx.getPackageManager().getPackageUid(pkg, 0);
    }

    static AudioFormat format() {
        // CHANNEL_IN_STEREO == CHANNEL_OUT_STEREO (0xC); the mix is a playback mix and createAudioRecordSink derives
        // the capture mask from it. Same format scrcpy's playback capture uses.
        return new AudioFormat.Builder()
                .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
                .setSampleRate(SAMPLE_RATE)
                .setChannelMask(AudioFormat.CHANNEL_IN_STEREO)
                .build();
    }

    // ------------------------------------------------------------------ one app

    static final class AppCapture {
        final String pkg;
        final int uid;
        final Route route;
        final int streamId;
        private final Sink sink;
        volatile String state = "starting";
        private Object policy;          // android.media.audiopolicy.AudioPolicy
        private AudioRecord record;
        private Thread reader;
        private volatile boolean running;
        private boolean stopped;
        /** How the policy was released (reported by {@link AudioProbe}); null while registered / never was. */
        volatile String unregisterPath;
        /** ≥ 0: "both" with the phone copy presented this many ms after capture; < 0: the app's own playback. */
        private final int phoneTargetMs;
        /** The daemon's own phone playback; non-null only while it is really running (else the app plays natively). */
        private volatile PhoneRender render;

        AppCapture(String pkg, int uid, Route route, int streamId, Sink sink) {
            this(pkg, uid, route, streamId, sink, -1);
        }

        AppCapture(String pkg, int uid, Route route, int streamId, Sink sink, int phoneTargetMs) {
            this.pkg = pkg;
            this.uid = uid;
            this.route = route;
            this.streamId = streamId;
            this.sink = sink;
            this.phoneTargetMs = route == Route.BOTH ? phoneTargetMs : -1;
        }

        /** The caller asked for an aligned "both" (whether or not the phone-side track could be built). */
        boolean wantsSync() {
            return phoneTargetMs >= 0;
        }

        /** The phone copy is rendered by the daemon (and the app is silent on the phone). */
        boolean isSyncing() {
            return render != null;
        }

        int targetMs() {
            PhoneRender r = render;
            return r != null ? r.targetMs() : -1;
        }

        void setTargetMs(int ms) {
            PhoneRender r = render;
            if (r != null) r.setTargetMs(ms);
        }

        boolean isLive() {
            return running && "live".equals(state);
        }

        /** Registers the policy and starts reading. On ANY failure everything registered so far is released. */
        void start() throws Exception {
            try {
                startLocked();
            } catch (Throwable t) {
                closeRender();
                releaseRecord();
                unregister();
                state = "error";
                if (t instanceof Exception) throw (Exception) t;
                throw new IllegalStateException(t);
            }
        }

        private void startLocked() throws Exception {
            Context ctx = ShellContext.get();   // shell identity (AttributionSource uid 2000)
            if (ctx == null) throw new IllegalStateException("no system context: " + SystemContext.lastError());

            Class<?> ruleCls = Class.forName("android.media.audiopolicy.AudioMixingRule");
            Class<?> ruleBuilderCls = Class.forName("android.media.audiopolicy.AudioMixingRule$Builder");
            Object ruleBuilder = ruleBuilderCls.getConstructor().newInstance();
            ruleBuilderCls.getMethod("setTargetMixRole", int.class)
                    .invoke(ruleBuilder, ruleCls.getField("MIX_ROLE_PLAYERS").getInt(null));
            ruleBuilderCls.getMethod("addMixRule", int.class, Object.class)
                    .invoke(ruleBuilder, ruleCls.getField("RULE_MATCH_UID").getInt(null), uid);
            // Video-call apps play the far end as VOICE_COMMUNICATION; without this it is not captured. Must be set
            // BEFORE build() (scrcpy calls it after build, where it has no effect).
            ruleBuilderCls.getMethod("voiceCommunicationCaptureAllowed", boolean.class).invoke(ruleBuilder, true);
            Object rule = ruleBuilderCls.getMethod("build").invoke(ruleBuilder);

            Class<?> mixCls = Class.forName("android.media.audiopolicy.AudioMix");
            Class<?> mixBuilderCls = Class.forName("android.media.audiopolicy.AudioMix$Builder");
            Object mixBuilder = mixBuilderCls.getConstructor(ruleCls).newInstance(rule);
            mixBuilderCls.getMethod("setFormat", AudioFormat.class).invoke(mixBuilder, format());
            // An aligned "both" silences the app on the phone (LOOP_BACK) and plays the phone copy itself; if that track
            // cannot be built the app keeps playing natively (LOOP_BACK_RENDER): sound is never lost, only the alignment.
            if (route == Route.BOTH && wantsSync()) {
                try {
                    render = PhoneRender.create(phoneTargetMs);
                } catch (Throwable t) {
                    Log.warn("AudioRouter", "phone render unavailable for " + pkg + " — plain both: " + rootMessage(t));
                    render = null;
                }
            }
            String flag = route == Route.BOTH && render == null ? "ROUTE_FLAG_LOOP_BACK_RENDER" : "ROUTE_FLAG_LOOP_BACK";
            mixBuilderCls.getMethod("setRouteFlags", int.class).invoke(mixBuilder, mixCls.getField(flag).getInt(null));
            Object mix = mixBuilderCls.getMethod("build").invoke(mixBuilder);

            Class<?> policyCls = Class.forName("android.media.audiopolicy.AudioPolicy");
            Class<?> policyBuilderCls = Class.forName("android.media.audiopolicy.AudioPolicy$Builder");
            Object policyBuilder = policyBuilderCls.getConstructor(Context.class).newInstance(ctx);
            policyBuilderCls.getMethod("addMix", mixCls).invoke(policyBuilder, mix);
            Object built = policyBuilderCls.getMethod("build").invoke(policyBuilder);

            Method register = AudioManager.class.getDeclaredMethod("registerAudioPolicyStatic", policyCls);
            register.setAccessible(true);
            int rc = (Integer) register.invoke(null, built);
            if (rc != 0) throw new IllegalStateException("registerAudioPolicy() returned " + rc);
            policy = built;

            AudioRecord r = (AudioRecord) policyCls.getMethod("createAudioRecordSink", mixCls).invoke(policy, mix);
            if (r == null) throw new IllegalStateException("createAudioRecordSink returned null");
            record = r;
            if (r.getState() != AudioRecord.STATE_INITIALIZED) throw new IllegalStateException("AudioRecord not initialized");
            r.startRecording();
            running = true;
            state = "live";
            reader = new Thread(() -> pump(r), "OpenDex-Audio-" + streamId);
            reader.setDaemon(true);
            reader.start();
            Log.info("AudioRouter", "capture started pkg=" + pkg + " uid=" + uid + " route=" + route.wire()
                    + " stream=" + streamId);
        }

        /** Reads with its OWN AudioRecord reference: stop() may clear the field concurrently. */
        private void pump(AudioRecord r) {
            try {
                Process.setThreadPriority(Process.THREAD_PRIORITY_URGENT_AUDIO);
            } catch (Throwable ignored) {}
            byte[] buf = new byte[CHUNK_BYTES];
            PtsClock timeline = new PtsClock(SAMPLE_RATE);          // smooth PTS: see PtsClock (read() wake-up jitter is not audio)
            int errors = 0;
            try {
                while (running) {
                    int n = r.read(buf, 0, CHUNK_BYTES, AudioRecord.READ_BLOCKING);
                    if (!running) break;
                    if (n <= 0) {
                        // DEAD_OBJECT: audioserver restarted — this AudioRecord will never deliver again.
                        if (n == AudioRecord.ERROR_DEAD_OBJECT || ++errors >= 50) {
                            Log.warn("AudioRouter", "capture lost pkg=" + pkg + " (read=" + n + ")");
                            state = "error";
                            running = false;
                            onCaptureDied(this);
                            return;
                        }
                        timeline.reset();                                 // frames may have been lost: re-anchor on the next read
                        Thread.sleep(20);
                        continue;
                    }
                    errors = 0;
                    // PTS = the capture time of this chunk's first frame on the monotonic clock, from a sample-accurate timeline
                    // (NOT "now minus the chunk's duration": the read's wake-up jitter would make both outputs re-place every chunk).
                    long ptsUs = timeline.stamp(System.nanoTime() / 1000, n / BYTES_PER_FRAME);
                    sink.onPcm(streamId, ptsUs, buf, n);
                    PhoneRender phone = render;
                    if (phone != null) phone.offer(buf, n, ptsUs * 1000L);
                }
            } catch (InterruptedException ignored) {
            } catch (Throwable t) {
                // An uncaught exception on any thread kills the app_process daemon (and with it every capture).
                Log.warn("AudioRouter", "reader crashed pkg=" + pkg + ": " + t);
                state = "error";
                running = false;
                onCaptureDied(this);
            }
        }

        /** Idempotent. Order: stop reading → wait for the reader → release → unregister → tell the sink. */
        void stop() {
            synchronized (this) {
                if (stopped) return;
                stopped = true;
            }
            running = false;
            AudioRecord r = record;
            if (r != null) {
                try { r.stop(); } catch (Throwable ignored) {}   // unblocks a READ_BLOCKING read
            }
            Thread t = reader;
            if (t != null && t != Thread.currentThread()) {
                try { t.join(500); } catch (InterruptedException ignored) {}
            }
            closeRender();
            releaseRecord();
            reader = null;
            unregister();
            state = "stopped";
            try { sink.onEnd(streamId); } catch (Throwable ignored) {}
            Log.info("AudioRouter", "capture stopped pkg=" + pkg + " stream=" + streamId);
        }

        private void closeRender() {
            PhoneRender r = render;
            render = null;
            if (r != null) r.close();
        }

        private void releaseRecord() {
            AudioRecord r = record;
            record = null;
            if (r != null) {
                try { r.release(); } catch (Throwable ignored) {}
            }
        }

        /**
         * The policy MUST be released or the app stays muted on the phone. Hidden static first (pairs with
         * registerAudioPolicyStatic, API 33+), then the @SystemApi instance method.
         */
        private void unregister() {
            Object p = policy;
            policy = null;
            if (p == null) return;
            Class<?> policyCls = p.getClass();
            try {
                Method m = AudioManager.class.getDeclaredMethod("unregisterAudioPolicyAsyncStatic", policyCls);
                m.setAccessible(true);
                m.invoke(null, p);
                unregisterPath = "unregisterAudioPolicyAsyncStatic";
                return;
            } catch (Throwable ignored) {}
            try {
                Context ctx = SystemContext.get();
                AudioManager am = ctx != null ? (AudioManager) ctx.getSystemService(Context.AUDIO_SERVICE) : null;
                if (am == null) throw new IllegalStateException("no AudioManager");
                AudioManager.class.getMethod("unregisterAudioPolicy", policyCls).invoke(am, p);
                unregisterPath = "unregisterAudioPolicy";
            } catch (Throwable t) {
                unregisterPath = "failed: " + rootMessage(t);
                Log.error("AudioRouter", "could not unregister policy for " + pkg + ": " + t
                        + " — the app stays routed until the daemon exits");
            }
        }
    }
}
