package com.opendex.tools;

import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Rect;
import android.hardware.camera2.CameraManager;
import android.media.AudioManager;
import android.media.MediaMetadata;
import android.media.session.MediaController;
import android.media.session.MediaSession;
import android.media.session.MediaSessionManager;
import android.media.session.PlaybackState;
import android.net.Credentials;
import android.net.LocalServerSocket;
import android.net.LocalSocket;
import android.net.Uri;
import android.os.Build;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.IBinder;
import android.os.PowerManager;
import android.os.SystemClock;
import android.provider.Settings;
import android.util.Base64;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileReader;
import java.io.IOException;
import java.io.InputStreamReader;
import java.io.OutputStreamWriter;
import java.io.PrintWriter;
import java.lang.reflect.Field;
import java.lang.reflect.Method;
import java.nio.charset.StandardCharsets;
import java.util.*;
import java.util.concurrent.*;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * OpenDeX Persistent Event & Bridge Daemon.
 *
 * Runs on Android as UID 2000 (shell) via app_process, reached from the host
 * through `adb forward tcp:<port> localabstract:opendex_daemon`. Every
 * accepted peer's UID is verified via SO_PEERCRED before any data is read or
 * written — only the device's own shell/root can talk to it, unlike a plain
 * loopback TCP socket which any app with INTERNET could reach.
 *
 * Protocol contract is kept intentionally stable field-for-field since v1.1
 * (active_clients, stream_id, on, status as BatteryManager int, etc.) — the
 * Python backend's own test suite asserts against these exact names/types.
 * v1.2 only ADDS: push sources and reads that replace the backend's periodic
 * `dumpsys` / `logcat` / `ps` / app_process forks (notification listener,
 * thermal listener, logd reader, load probe, task/power queries — see the
 * capability list), each with the backend's shell path kept as its fallback.
 * Internally this build consolidates a long review chain: deadlock-free
 * shell exec, void-method-safe reflection, OEM-fragmentation-proof
 * battery/state/focus reads, and bandwidth-aware poller diffing — none of
 * which changed the wire protocol clients already depend on.
 */
public class OpenDexDaemon {

    private static final String DEFAULT_SOCKET_NAME = "opendex_daemon";
    private static final String PROTOCOL_VERSION = "1.2"; // additive over 1.1 — see class javadoc
    /** md5 of the jar this process was started from, echoed in the greeting so the backend can tell a daemon still
     * running OLD bytecode after a jar update; null when the class path cannot be read. */
    private static String buildId;

    private static String jarMd5() {
        try {
            File jar = new File(System.getProperty("java.class.path", "").split(":")[0]);
            java.security.MessageDigest md = java.security.MessageDigest.getInstance("MD5");
            try (java.io.FileInputStream in = new java.io.FileInputStream(jar)) {
                byte[] buf = new byte[16 * 1024];
                int n;
                while ((n = in.read(buf)) > 0) md.update(buf, 0, n);
            }
            StringBuilder hex = new StringBuilder();
            for (byte b : md.digest()) hex.append(String.format(Locale.ROOT, "%02x", b));
            return hex.toString();
        } catch (Throwable t) {
            return null;
        }
    }
    private static final int TRUSTED_ROOT = 0, TRUSTED_SHELL = 2000;
    private static final long START_TIME_MS = System.currentTimeMillis();
    private static final long IDLE_TIMEOUT_MS = 5 * 60 * 1000;
    /** Per-app audio policies outlive a control client only this long: a brief reconnect (transport switch, backend
     * restart) keeps the captures, a real disconnect (cable pulled, backend gone) hands every app back to the phone
     * instead of leaving "pc"-routed apps silent until the idle timeout. */
    private static final long AUDIO_RELEASE_GRACE_MS = 3000;
    /** A panel WE blanked is lit again this long after the last control client left. Long
     * enough that a transport switch (USB ↔ Wi-Fi) or a backend restart does not flash the phone. */
    private static final long RESTORE_SCREEN_AFTER_MS = 30_000;
    /** Survives a SIGKILL / crash of this process: the NEXT daemon start finds it and lights the panel. */
    private static final File SCREEN_BLANKED_MARKER = new File("/data/local/tmp/opendex-screen-blanked");

    private static volatile long lastClientDisconnectedTime = System.currentTimeMillis();
    private static volatile boolean lastTorchState = false;

    // Screen fail-safe state — guarded by SCREEN_LOCK. True ONLY while the panel is blanked by one of OUR raw paths
    // (IDisplayManager.requestDisplayPower / SurfaceControl power mode): PowerManager still believes the device is
    // awake, so nothing in Android would ever light it again, and the phone looks dead. A real sleep through
    // KEYCODE_SLEEP is NOT tracked — PowerManager owns it and the power button undoes it.
    private static final Object SCREEN_LOCK = new Object();
    private static boolean screenOffByUs = false;
    private static ScheduledFuture<?> pendingScreenRestore;

    private static final List<ClientConnection> activeClients = new CopyOnWriteArrayList<>();
    private static final ScheduledExecutorService scheduler = Executors.newSingleThreadScheduledExecutor();
    private static final Pattern ID_PREFIX_PATTERN = Pattern.compile("^#(\\S+)\\s+");

    /**
     * Read-only commands that take tens to hundreds of milliseconds (a logd seek, the notification list, a service
     * dump, a /proc walk). They run on this pool so they never hold up the connection's other commands; the reply
     * carries its req_id, so answering out of order is part of the protocol.
     */
    private static final ExecutorService rpcPool = Executors.newFixedThreadPool(2, r -> {
        Thread t = new Thread(r, "OpenDex-Rpc");
        t.setDaemon(true);
        return t;
    });
    private static final Set<String> POOLED_COMMANDS = new HashSet<>(Arrays.asList(
            "notifications_list", "notif_invoke", "event_log", "load_sample", "proc_scan", "dump", "thermal_get"));

    /**
     * Secret the backend started this daemon with (OPENDEX_DAEMON_TOKEN). Present: every client must pass the
     * challenge-response (DaemonAuth) before ANY command is read, and {@code shell} is offered. Absent (an older
     * backend, or started by hand): the socket is open as it always was, and nothing that runs a command is offered.
     */
    private static final String AUTH_TOKEN = readToken();
    private static final int AUTH_TIMEOUT_MS = 5000;
    private static final ShellService SHELL = new ShellService(6, 24);
    /** The file manager's control plane (fs_*): own small pool, offered — like shell — only to authenticated clients. */
    private static final FsService FS = new FsService(FsPolicy.android(), java.nio.file.Paths.get("/storage"), java.nio.file.Paths.get("/data/local/tmp"), 3, 16);

    private static String readToken() {
        String t = System.getenv("OPENDEX_DAEMON_TOKEN");
        return t == null || t.trim().isEmpty() ? null : t.trim();
    }

    private static final List<String> CAPABILITIES = Arrays.asList(
            "ping", "proc_probe", "media_get", "media_action", "media_seek", "get_focus",
            "set_density", "set_task_density", "set_task_windowing", "get_task_geometry", "move_task", "move_task_to_display", "move_task_wct", "restart_task_activity", "task_density_info", "volumes_get", "volume_set",
            "states_get", "state_set", "battery_get", "battery_health", "display_power", "status",
            "audio_route", "audio_stop", "audio_list", "audio_playout", "audio_probe",
            "task_events", "tasks_list", "display_events",
            "bluetooth", "bt_list", "bt_connect", "bt_disconnect", "bt_forget", "wifi_connect_saved", "wifi_disconnect", "quit", "exit",
            // 1.2 — what the backend used to fork `dumpsys` / `logcat` / `ps` / app_process for
            "notification_events", "notifications_list", "notif_invoke", "thermal_events", "thermal_get", "event_log",
            "load_sample", "proc_scan", "find_task", "task_info", "top_activities", "power_get", "dump",
            // the phone panel's density/size over Binder (PhoneDisplay); DisplayEvents pushes display-0 changes
            "display_get",
            // set_task_windowing takes l,t,r,b: mode and placement in one transaction
            "set_task_windowing_bounds"
    );

    // =========================================================================
    // 1. Core System Helpers (Safe Context, Type-Safe Reflection; Binder lookup lives in Binders)
    // =========================================================================

    private static Context getSystemContext() {
        Context ctx = SystemContext.get();
        if (ctx == null) Log.error("Context", "SystemContext init failed: " + SystemContext.lastError());
        return ctx;
    }

    /** Marks "the reflective call itself failed" — distinct from a successful call that returned null (void). */
    private static final Object INVOKE_FAILED = new Object();

    /** Exact signature first; if it doesn't exist (OEM/version drift), any public overload with the same name and
     * arity. Returns the call's result (null for a void method) or {@link #INVOKE_FAILED}. */
    private static Object invoke(Object target, String method, Class<?>[] paramTypes, Object... args) {
        if (target == null) return INVOKE_FAILED;
        try {
            Method m = target.getClass().getMethod(method, paramTypes);
            m.setAccessible(true);
            return m.invoke(target, args);
        } catch (NoSuchMethodException e) {
            for (Method m2 : target.getClass().getMethods()) {
                if (m2.getName().equals(method) && m2.getParameterTypes().length == args.length) {
                    try { return m2.invoke(target, args); } catch (Throwable ignored) {}
                }
            }
        } catch (Throwable ignored) {}
        return INVOKE_FAILED;
    }

    /** For VOID AIDL/Binder methods. Method.invoke() returns null on success for a
     * void method — treating that as "failure" caused double-invocation bugs
     * (media play/pause fired twice, display power toggled twice). */
    private static boolean invokeVoid(Object target, String method, Class<?>[] paramTypes, Object... args) {
        return invoke(target, method, paramTypes, args) != INVOKE_FAILED;
    }

    /** For methods that actually return a value (null on failure). */
    private static Object invokeReturn(Object target, String method, Class<?>[] paramTypes, Object... args) {
        Object result = invoke(target, method, paramTypes, args);
        return result == INVOKE_FAILED ? null : result;
    }

    /** Deadlock-free & timeout-protected shell exec. stdout+stderr merged (an
     * unread stderr stream filling its pipe buffer would otherwise hang
     * p.waitFor() forever); a hard 3s ceiling guarantees no single command
     * can freeze the daemon. */
    static String execCommand(String cmd) {
        Process p = null;
        try {
            p = new ProcessBuilder("sh", "-c", cmd).redirectErrorStream(true).start();
            StringBuilder sb = new StringBuilder();
            try (BufferedReader br = new BufferedReader(new InputStreamReader(p.getInputStream(), StandardCharsets.UTF_8))) {
                String l;
                while ((l = br.readLine()) != null) {
                    if (sb.length() > 0) sb.append("\n");
                    sb.append(l);
                }
            }
            boolean finished = p.waitFor(3, TimeUnit.SECONDS);
            if (!finished) { p.destroyForcibly(); return "ERROR: timeout"; }
            return sb.toString().trim();
        } catch (Throwable t) { return "ERROR: " + t.getMessage(); }
        finally { if (p != null) p.destroy(); }
    }

    /** Exit-code aware variant — `wm density`/`am display move-stack` print NOTHING
     * on success, so comparing execCommand()'s stdout ("") against "0" always lied. */
    private static boolean execCommandOk(String cmd) {
        Process p = null;
        try {
            p = new ProcessBuilder("sh", "-c", cmd).redirectErrorStream(true).start();
            boolean finished = p.waitFor(3, TimeUnit.SECONDS);
            if (!finished) { p.destroyForcibly(); return false; }
            return p.exitValue() == 0;
        } catch (Throwable t) { return false; }
        finally { if (p != null) p.destroy(); }
    }

    // =========================================================================
    // 2. DRY Helpers
    // =========================================================================

    /** A target latency in ms: 0..PhoneRender.MAX_TARGET_MS (larger is clamped); negative or unparsable is -1 (= none). */
    static int parseTargetMs(String s) {
        try {
            int v = Integer.parseInt(s.trim());
            return v < 0 ? -1 : Math.min(v, PhoneRender.MAX_TARGET_MS);
        } catch (NumberFormatException e) {
            return -1;
        }
    }

    /** parts[at] as an int; {@code fallback} when absent or not a number (AudioRouter.probe clamps the range). */
    static int parseIntOr(String[] parts, int at, int fallback) {
        if (parts.length <= at) return fallback;
        try {
            return Integer.parseInt(parts[at].trim());
        } catch (NumberFormatException e) {
            return fallback;
        }
    }

    static String sanitizePkg(String pkg) {
        if (pkg == null) return null;
        String t = pkg.trim();
        return (t.isEmpty() || "null".equalsIgnoreCase(t) || "undefined".equalsIgnoreCase(t)) ? null : pkg;
    }

    /**
     * Global media key — reaches whichever app Android currently routes media buttons to, NOT a chosen one. So it is
     * only a fallback for commands that named no package (see executeMediaCommand). PLAY (126) / PAUSE (127) are
     * absolute; PLAY_PAUSE (85) is a toggle and would pause music that is already playing when asked to "play".
     */
    private static boolean tryKeyEventFallback(String action) {
        int keyCode = 0;
        switch (action.toLowerCase()) {
            case "play": keyCode = 126; break;
            case "pause": keyCode = 127; break;
            case "toggle": case "play_pause": keyCode = 85; break;
            case "next": keyCode = 87; break;
            case "prev": case "previous": keyCode = 88; break;
            default: return false;
        }
        final int code = keyCode;
        scheduler.execute(() -> execCommand("input keyevent " + code));
        return true;
    }

    // =========================================================================
    // 3. Connection Handling
    // =========================================================================

    /** Nobody can control the phone any more: hand app audio back to it soon, and light a panel we blanked. */
    private static void onLastClientGone() {
        try {
            scheduler.schedule(() -> {
                if (activeClients.isEmpty()) AudioRouter.stopAll();
            }, AUDIO_RELEASE_GRACE_MS, TimeUnit.MILLISECONDS);
        } catch (RejectedExecutionException ignored) {
            // shutting down — the shutdown hook releases the policies
        }
        scheduleScreenRestore();
    }

    // ---- screen power fail-safe -------------------------------------------------------------

    private static void scheduleScreenRestore() {
        synchronized (SCREEN_LOCK) {
            cancelScreenRestoreLocked();
            if (!screenOffByUs) return;
            try {
                pendingScreenRestore = scheduler.schedule(() -> {
                    if (activeClients.isEmpty()) restoreScreenIfOurs("no control client for 30 s");
                }, RESTORE_SCREEN_AFTER_MS, TimeUnit.MILLISECONDS);
            } catch (RejectedExecutionException ignored) {
                // shutting down — the shutdown hook restores the panel
            }
        }
    }

    private static void cancelScreenRestore() {
        synchronized (SCREEN_LOCK) {
            cancelScreenRestoreLocked();
        }
    }

    private static void cancelScreenRestoreLocked() {
        if (pendingScreenRestore != null) {
            pendingScreenRestore.cancel(false);
            pendingScreenRestore = null;
        }
    }

    /**
     * Lights the panel again, but ONLY if we blanked it. If PowerManager went to sleep meanwhile (the user pressed
     * the power button), Android owns the panel again: the flag is dropped and nothing is woken.
     */
    static void restoreScreenIfOurs(String reason) {
        synchronized (SCREEN_LOCK) {
            if (!screenOffByUs) return;
            if (!isInteractive()) {
                Log.info("Daemon", "Screen fail-safe (" + reason + "): device went to sleep meanwhile, nothing to restore");
                markScreenBlanked(false);
                return;
            }
            Log.info("Daemon", "Screen fail-safe: restoring the panel (" + reason + ")");
            setDisplayPower(0, true);
        }
    }

    /** PowerManager's view; true when unknown (a panel we blanked must never stay dark by mistake). */
    private static boolean isInteractive() {
        try {
            Context ctx = getSystemContext();
            PowerManager pm = ctx != null ? (PowerManager) ctx.getSystemService(Context.POWER_SERVICE) : null;
            return pm == null || pm.isInteractive();
        } catch (Throwable t) {
            return true;
        }
    }

    private static void markScreenBlanked(boolean blanked) {
        screenOffByUs = blanked;
        try {
            if (blanked) {
                if (!SCREEN_BLANKED_MARKER.exists()) SCREEN_BLANKED_MARKER.createNewFile();
            } else if (SCREEN_BLANKED_MARKER.exists() && !SCREEN_BLANKED_MARKER.delete()) {
                Log.warn("Daemon", "could not delete " + SCREEN_BLANKED_MARKER);
            }
        } catch (Throwable t) {
            Log.warn("Daemon", "screen marker: " + t.getMessage());
        }
    }

    static boolean isScreenBlankedByUs() {
        synchronized (SCREEN_LOCK) {
            return screenOffByUs;
        }
    }

    /** A previous daemon blanked the panel and died without restoring it (SIGKILL, crash): light it now. */
    private static void restoreScreenLeftBlankedByPreviousRun() {
        if (!SCREEN_BLANKED_MARKER.exists()) return;
        synchronized (SCREEN_LOCK) {
            screenOffByUs = true;
        }
        restoreScreenIfOurs("left blanked by a previous daemon");
    }

    private static void broadcast(String msg) {
        for (ClientConnection conn : activeClients) conn.enqueue(msg);
    }
    private static void broadcast(JSONObject json) {
        broadcast(json.toString());
    }

    /** Pushed events from the daemon's listeners (TaskEvents, DisplayEvents, …). */
    static void broadcastEvent(JSONObject json) {
        broadcast(json.toString());
    }

    private static final Object FOCUS_LOCK = new Object();
    private static String lastFocusSent = "";   // guarded by FOCUS_LOCK

    /** focus_update, only when it changed — shared by the poller (safety net) and TaskEvents (push). */
    static void broadcastFocusIfChanged() {
        String focus = getFocusedWindowJson().toString();
        synchronized (FOCUS_LOCK) {
            if (focus.equals(lastFocusSent)) return;
            lastFocusSent = focus;
        }
        broadcast(focus);
    }

    private static final class ClientConnection {
        private static final int MAX_QUEUED_EVENTS = 64;
        /** A client that stops reading must not make us hold unbounded replies. */
        private static final long MAX_QUEUED_RESPONSE_BYTES = 32L * 1024 * 1024;

        private final LocalSocket socket;
        private final PrintWriter writer;
        /** Pushed events (media, focus, battery…): lossy by design — a slow client gets the newest, not a backlog. */
        private final ArrayDeque<String> events = new ArrayDeque<>();
        /** Replies to the client's own requests: NEVER dropped. A lost reply reads as a dead daemon to its caller. */
        private final ArrayDeque<String> responses = new ArrayDeque<>();
        private long queuedResponseBytes = 0;
        private final Thread writerThread;
        private volatile boolean closed = false;

        ClientConnection(LocalSocket socket, PrintWriter writer) {
            this.socket = socket;
            this.writer = writer;
            this.writerThread = new Thread(this::writeLoop, "OpenDex-Writer");
            this.writerThread.setDaemon(true);
            this.writerThread.start();
        }

        /** A pushed event (lossy: the oldest queued event goes first when the client lags). */
        void enqueue(String json) {
            synchronized (this) {
                if (closed) return;
                if (events.size() >= MAX_QUEUED_EVENTS) events.pollFirst();
                events.addLast(json);
                notifyAll();
            }
        }

        /** The reply to one of this client's requests (kept in order, sent before any pending event). */
        void enqueueResponse(String json) {
            boolean overflow;
            synchronized (this) {
                if (closed) return;
                responses.addLast(json);
                queuedResponseBytes += json.length();
                overflow = queuedResponseBytes > MAX_QUEUED_RESPONSE_BYTES;
                notifyAll();
            }
            if (overflow) {
                Log.warn("Conn", "Client is not reading its replies; dropping the connection");
                close();
            }
        }

        private synchronized String take() throws InterruptedException {
            while (!closed && responses.isEmpty() && events.isEmpty()) wait();
            if (closed) throw new InterruptedException();
            if (!responses.isEmpty()) {
                String r = responses.pollFirst();
                queuedResponseBytes -= r.length();
                return r;
            }
            return events.pollFirst();
        }

        private void writeLoop() {
            try {
                while (!Thread.currentThread().isInterrupted()) {
                    writer.println(take());
                    writer.flush();
                    if (writer.checkError()) break; // PrintWriter swallows IOExceptions — this is the only signal
                }
            } catch (InterruptedException ignored) {
            } catch (Throwable t) { Log.warn("Conn", "Writer died: " + t.getMessage()); }
            finally { close(); }
        }

        void close() {
            if (closed) return;
            synchronized (this) {
                closed = true;
                notifyAll();
            }
            writerThread.interrupt();
            try { writer.close(); } catch (Throwable ignored) {}
            try { socket.close(); } catch (Throwable ignored) {}
            activeClients.remove(this);
            if (activeClients.isEmpty()) {
                lastClientDisconnectedTime = System.currentTimeMillis();
                onLastClientGone();
            }
        }
    }

    // =========================================================================
    // 4. MediaSession (Proxy-Aware, Zero-Reencode, Bandwidth-Correct)
    // =========================================================================

    private static final class CachedArt {
        final String trackKey;
        final String base64OrUri;
        CachedArt(String trackKey, String base64OrUri) {
            this.trackKey = trackKey;
            this.base64OrUri = base64OrUri;
        }
    }
    private static final Map<String, CachedArt> artCache = new ConcurrentHashMap<>();
    private static final java.util.concurrent.atomic.AtomicLong mediaSeq = new java.util.concurrent.atomic.AtomicLong(0);

    private static Bitmap extractBitmapFromMetadata(MediaMetadata meta) {
        if (meta == null) return null;
        try {
            Bitmap art = meta.getBitmap(MediaMetadata.METADATA_KEY_ALBUM_ART);
            if (art != null && art.getWidth() > 0) return art;

            art = meta.getBitmap(MediaMetadata.METADATA_KEY_ART);
            if (art != null && art.getWidth() > 0) return art;

            art = meta.getBitmap(MediaMetadata.METADATA_KEY_DISPLAY_ICON);
            if (art != null && art.getWidth() > 0) return art;
        } catch (Throwable ignored) {}

        try {
            android.media.MediaDescription desc = meta.getDescription();
            if (desc != null) {
                Bitmap art = desc.getIconBitmap();
                if (art != null && art.getWidth() > 0) return art;
            }
        } catch (Throwable ignored) {}

        try {
            Set<String> keys = meta.keySet();
            if (keys != null) {
                for (String k : keys) {
                    if (k != null) {
                        String lk = k.toLowerCase();
                        if (lk.contains("art") || lk.contains("icon") || lk.contains("thumb") || lk.contains("picture") || lk.contains("image") || lk.contains("cover")) {
                            try {
                                Bitmap b = meta.getBitmap(k);
                                if (b != null && b.getWidth() > 0) return b;
                            } catch (Throwable ignored) {}
                        }
                    }
                }
            }
        } catch (Throwable ignored) {}

        return null;
    }

    private static String extractUriFromMetadata(MediaMetadata meta) {
        if (meta == null) return null;

        try {
            android.media.MediaDescription desc = meta.getDescription();
            if (desc != null && desc.getIconUri() != null) {
                String u = desc.getIconUri().toString();
                if (u != null && !u.trim().isEmpty()) return u.trim();
            }
        } catch (Throwable ignored) {}

        try {
            CharSequence cs = meta.getText(MediaMetadata.METADATA_KEY_ALBUM_ART_URI);
            if (cs == null) cs = meta.getText(MediaMetadata.METADATA_KEY_ART_URI);
            if (cs == null) cs = meta.getText(MediaMetadata.METADATA_KEY_DISPLAY_ICON_URI);
            if (cs != null && cs.length() > 0) return cs.toString().trim();
        } catch (Throwable ignored) {}

        try {
            Set<String> keys = meta.keySet();
            if (keys != null) {
                for (String k : keys) {
                    if (k != null) {
                        String lk = k.toLowerCase();
                        if (lk.contains("uri") || lk.contains("url")) {
                            CharSequence cs = meta.getText(k);
                            if (cs != null && cs.length() > 0) {
                                String u = cs.toString().trim();
                                if (!u.isEmpty()) return u;
                            }
                        }
                    }
                }
            }
        } catch (Throwable ignored) {}

        return null;
    }

    private static Bitmap decodeUriToBitmap(String uriStr) {
        if (uriStr == null || uriStr.trim().isEmpty()) return null;
        try {
            Uri uri = Uri.parse(uriStr);
            String scheme = uri.getScheme();
            if (scheme == null) return null;

            if ("content".equalsIgnoreCase(scheme) || "android.resource".equalsIgnoreCase(scheme) || "file".equalsIgnoreCase(scheme)) {
                Context ctx = getSystemContext();
                if (ctx != null && ctx.getContentResolver() != null) {
                    try (java.io.InputStream is = ctx.getContentResolver().openInputStream(uri)) {
                        if (is != null) {
                            return BitmapFactory.decodeStream(is);
                        }
                    }
                }
            } else if ("http".equalsIgnoreCase(scheme) || "https".equalsIgnoreCase(scheme)) {
                try {
                    java.net.URL url = new java.net.URL(uriStr);
                    java.net.HttpURLConnection conn = (java.net.HttpURLConnection) url.openConnection();
                    conn.setConnectTimeout(2500);
                    conn.setReadTimeout(3000);
                    conn.setInstanceFollowRedirects(true);
                    try (java.io.InputStream is = conn.getInputStream()) {
                        if (is != null) {
                            return BitmapFactory.decodeStream(is);
                        }
                    }
                } catch (Throwable ignored) {}
            }
        } catch (Throwable t) {
            Log.warn("Daemon", "Failed to decode URI to Bitmap: " + uriStr + " -> " + t.getMessage());
        }
        return null;
    }

    private static String bitmapToBase64(Bitmap art) {
        if (art == null || art.getWidth() <= 0 || art.getHeight() <= 0) return "";
        try {
            if (art.getWidth() > 512 || art.getHeight() > 512) {
                float r = Math.min(512f / art.getWidth(), 512f / art.getHeight());
                art = Bitmap.createScaledBitmap(art, Math.max(1, Math.round(art.getWidth() * r)), Math.max(1, Math.round(art.getHeight() * r)), true);
            }
            ByteArrayOutputStream baos = new ByteArrayOutputStream();
            art.compress(Bitmap.CompressFormat.JPEG, 85, baos);
            return "data:image/jpeg;base64," + Base64.encodeToString(baos.toByteArray(), Base64.NO_WRAP);
        } catch (Throwable t) {
            return "";
        }
    }

    /** Reads a text metadata field, "" when absent. */
    private static String metaText(MediaMetadata meta, String key) {
        try {
            CharSequence v = meta != null ? meta.getText(key) : null;
            return v != null ? v.toString() : "";
        } catch (Throwable t) {
            return "";
        }
    }

    /**
     * Stable identity of the CURRENT track: package + MEDIA_ID + title + artist + duration. The cover cache and the
     * wire protocol (`track_id`) are keyed by this, so a cover can never be carried over to a different track.
     */
    private static String trackKeyOf(MediaMetadata meta, String pkg) {
        String mediaId = "";
        try {
            String id = meta != null ? meta.getString(MediaMetadata.METADATA_KEY_MEDIA_ID) : null;
            if (id != null) mediaId = id;
        } catch (Throwable ignored) {}
        long duration = 0;
        try { duration = meta != null ? meta.getLong(MediaMetadata.METADATA_KEY_DURATION) : 0; } catch (Throwable ignored) {}
        return pkg + "::" + mediaId + "::" + metaText(meta, MediaMetadata.METADATA_KEY_TITLE)
                + "::" + metaText(meta, MediaMetadata.METADATA_KEY_ARTIST) + "::" + duration;
    }

    /**
     * Returns the cover for the CURRENT track, or "" when it isn't available yet. Apps usually publish the title first
     * and the cover bitmap a moment later: in that window this used to store the NEW track key and return the previous
     * track's cover (and, since the key then matched, never looked again). Now a missing cover is never papered over
     * with the previous track's — the caller gets "" (art_ready=false) and the settle ladder retries.
     */
    private static String getOrExtractArtwork(MediaMetadata meta, String pkg, String trackKey, boolean forceFullArt) {
        if (meta == null || pkg == null) return "";
        CachedArt cached = artCache.get(pkg);
        boolean sameTrack = (cached != null && trackKey.equals(cached.trackKey));

        if (!forceFullArt && sameTrack && cached.base64OrUri != null && !cached.base64OrUri.isEmpty()) {
            return cached.base64OrUri;
        }

        Bitmap art = extractBitmapFromMetadata(meta);
        if (art == null) {
            String uriStr = extractUriFromMetadata(meta);
            if (uriStr != null && !uriStr.isEmpty()) {
                art = decodeUriToBitmap(uriStr);
                if (art == null && (uriStr.startsWith("http://") || uriStr.startsWith("https://") || uriStr.startsWith("data:"))) {
                    artCache.put(pkg, new CachedArt(trackKey, uriStr));
                    return uriStr;
                }
            }
        }

        if (art != null) {
            String b64 = bitmapToBase64(art);
            if (!b64.isEmpty()) {
                artCache.put(pkg, new CachedArt(trackKey, b64));
                return b64;
            }
        }

        // No cover (yet) for this track: NEVER return the previous track's cover and do NOT record the new key, so the
        // next call (poller / settle ladder / media_get) tries again instead of trusting a stale entry.
        if (!sameTrack) {
            artCache.remove(pkg);
            return "";
        }
        return (cached != null && cached.base64OrUri != null) ? cached.base64OrUri : "";
    }

    private static final long[] ART_SETTLE_DELAYS_MS = {250, 700, 1500, 3000};

    /**
     * After a metadata change whose cover isn't ready yet, retry on a short ladder and broadcast the moment the cover
     * appears (instead of waiting for the 1.2 s poller). A step is a no-op once the cover is known or the track changed
     * (the newer metadata callback owns its own ladder).
     */
    private static void scheduleArtSettle(final String pkg, MediaMetadata metadata) {
        if (pkg == null || metadata == null) return;
        final String trackKey = trackKeyOf(metadata, pkg);
        for (long delay : ART_SETTLE_DELAYS_MS) {
            scheduler.schedule(() -> {
                try {
                    CachedArt cached = artCache.get(pkg);
                    if (cached != null && trackKey.equals(cached.trackKey) && cached.base64OrUri != null && !cached.base64OrUri.isEmpty()) {
                        return; // already announced
                    }
                    MediaController mc = activeMediaControllers.get(pkg);
                    MediaMetadata current = mc != null ? mc.getMetadata() : null;
                    if (current == null || !trackKey.equals(trackKeyOf(current, pkg))) return; // track changed
                    if (!getOrExtractArtwork(current, pkg, trackKey, false).isEmpty()) {
                        Log.info("RealtimeMedia", "🖼️ [ART:SETTLED] " + pkg + " cover arrived after " + delay + "ms");
                        triggerInstantMediaBroadcast();
                    }
                } catch (Throwable ignored) {}
            }, delay, TimeUnit.MILLISECONDS);
        }
    }

    /** Resolves an ISessionController from a raw MediaSessionManager session
     * token — the token is already an IBinder on modern Android, or exposes
     * one via a getBinder() accessor on older/OEM builds. Shared by
     * getActiveSessionController and getMediaJson (previously duplicated
     * verbatim in both). */
    private static Object resolveSessionController(Object token, Method asInterface) throws Throwable {
        if (token instanceof IBinder) {
            return asInterface.invoke(null, token);
        }
        Object binder = invokeReturn(token, "getBinder", new Class[0]);
        if (binder instanceof IBinder) return asInterface.invoke(null, binder);
        return (binder != null) ? binder : token;
    }

    // ── Realtime Push MediaSession Listeners ─────────────────────────────────
    private static HandlerThread mediaListenerThread = null;
    private static Handler mediaListenerHandler = null;
    private static final Map<String, MediaController.Callback> activeMediaCallbacks = new ConcurrentHashMap<>();
    private static final Map<String, MediaController> activeMediaControllers = new ConcurrentHashMap<>();
    private static Object sessionsChangedListener = null;

    private static synchronized void initRealtimeMediaListeners() {
        if (mediaListenerThread != null && mediaListenerThread.isAlive()) return;
        try {
            Context ctx = getSystemContext();
            if (ctx == null) {
                Log.warn("RealtimeMedia", "getSystemContext() returned null; will rely on poller fallback");
                return;
            }

            mediaListenerThread = new HandlerThread("OpenDex-MediaEvents");
            mediaListenerThread.start();
            mediaListenerHandler = new Handler(mediaListenerThread.getLooper());

            MediaSessionManager msm = (MediaSessionManager) ctx.getSystemService(Context.MEDIA_SESSION_SERVICE);
            if (msm != null) {
                MediaSessionManager.OnActiveSessionsChangedListener listener = new MediaSessionManager.OnActiveSessionsChangedListener() {
                    @Override
                    public void onActiveSessionsChanged(List<MediaController> controllers) {
                        Log.info("RealtimeMedia", "⚡ Active sessions changed, count=" + (controllers != null ? controllers.size() : 0));
                        syncMediaControllers(controllers);
                        triggerInstantMediaBroadcast();
                    }
                };
                sessionsChangedListener = listener;
                msm.addOnActiveSessionsChangedListener(listener, null, mediaListenerHandler);

                List<MediaController> active = msm.getActiveSessions(null);
                syncMediaControllers(active);
                Log.info("RealtimeMedia", "✅ Realtime MediaSessionManager listener registered!");
            }
        } catch (Throwable t) {
            Log.warn("RealtimeMedia", "MediaSessionManager listener init fallback: " + t.getMessage());
        }
    }

    /**
     * Idempotent: registers the realtime callback for this controller's package if it isn't bound yet. NEVER unbinds
     * anything else — safe to call per session from anywhere (getMediaJson's single-token path used to go through the
     * pruning sync below, so with two active sessions each call unbound the other one's callback).
     */
    private static void bindController(final MediaController controller) {
        if (controller == null || mediaListenerHandler == null) return;
        final String pkg = controller.getPackageName();
        if (pkg == null || pkg.isEmpty() || activeMediaCallbacks.containsKey(pkg)) return;

        MediaController.Callback cb = new MediaController.Callback() {
            @Override
            public void onPlaybackStateChanged(PlaybackState state) {
                Log.info("RealtimeMedia", "⚡ [PUSH:PLAY_STATE] " + pkg + " state=" + (state != null ? state.getState() : "null"));
                triggerInstantMediaBroadcast();
            }

            @Override
            public void onMetadataChanged(MediaMetadata metadata) {
                Log.info("RealtimeMedia", "⚡ [PUSH:TRACK_CHANGE] " + pkg + " track/meta changed!");
                triggerInstantMediaBroadcast();
                scheduleArtSettle(pkg, metadata); // title first, cover a moment later: retry until the cover arrives
            }

            @Override
            public void onSessionDestroyed() {
                Log.info("RealtimeMedia", "⚡ [PUSH:DESTROYED] " + pkg);
                activeMediaCallbacks.remove(pkg);
                activeMediaControllers.remove(pkg);
                triggerInstantMediaBroadcast();
            }
        };

        try {
            controller.registerCallback(cb, mediaListenerHandler);
            activeMediaCallbacks.put(pkg, cb);
            activeMediaControllers.put(pkg, controller);
            Log.info("RealtimeMedia", "Bound realtime MediaController.Callback to: " + pkg);
        } catch (Throwable t) {
            Log.warn("RealtimeMedia", "Failed to register callback for " + pkg + ": " + t.getMessage());
        }
    }

    /**
     * AUTHORITATIVE sync — only for the full active-session list (onActiveSessionsChanged / init): binds every listed
     * controller and unbinds the ones that are no longer in the list.
     */
    private static void syncMediaControllers(List<MediaController> controllers) {
        if (controllers == null || mediaListenerHandler == null) return;
        Set<String> currentPkgs = new HashSet<>();

        for (final MediaController controller : controllers) {
            if (controller == null) continue;
            final String pkg = controller.getPackageName();
            if (pkg == null || pkg.isEmpty()) continue;
            currentPkgs.add(pkg);
            bindController(controller);
        }

        // Cleanup controllers that are no longer active
        Iterator<Map.Entry<String, MediaController.Callback>> it = activeMediaCallbacks.entrySet().iterator();
        while (it.hasNext()) {
            Map.Entry<String, MediaController.Callback> entry = it.next();
            if (!currentPkgs.contains(entry.getKey())) {
                try {
                    MediaController mc = activeMediaControllers.remove(entry.getKey());
                    if (mc != null) mc.unregisterCallback(entry.getValue());
                } catch (Throwable ignored) {}
                it.remove();
            }
        }
    }

    private static void ensureControllerCallbackForToken(Object token) {
        if (mediaListenerHandler == null || !(token instanceof MediaSession.Token)) return;
        try {
            Context ctx = getSystemContext();
            if (ctx == null) return;
            MediaController mc = new MediaController(ctx, (MediaSession.Token) token);
            bindController(mc); // bind only — never prune the other sessions' callbacks
        } catch (Throwable ignored) {}
    }

    private static void triggerInstantMediaBroadcast() {
        if (activeClients.isEmpty()) return;
        scheduler.execute(() -> {
            try {
                JSONObject mediaObj = getMediaJson(null, false);
                broadcast(mediaObj.toString());
            } catch (Throwable ignored) {}
        });
    }

    private static Object getActiveSessionController(String targetPkg) {
        try {
            Object sm = Binders.service("media_session", "android.media.session.ISessionManager$Stub");
            List<?> tokens = (List<?>) invokeReturn(sm, "getSessions", new Class[]{ComponentName.class, int.class}, null, 0);
            if (tokens == null || tokens.isEmpty()) return null;

            Class<?> stubClass = Class.forName("android.media.session.ISessionController$Stub");
            Method asInterface = stubClass.getMethod("asInterface", IBinder.class);

            // A named package is a TARGET, never a hint: only that app's own session may be returned. This used to fall
            // back to "whichever session is active" when the named app had no session any more — so play/pause on the
            // card of an app that had just been closed (YouTube) silently toggled a different, still-running one
            // (YouTube Music). No session for the named package now means null; the caller reports it instead.
            // An exact match is searched over the WHOLE list (getSessions() orders by Android's session stack).
            Object fallback = null;
            Object anyActive = null;
            for (Object token : tokens) {
                Object controller = resolveSessionController(token, asInterface);
                if (controller == null) continue;

                String pkg = (String) invokeReturn(controller, "getPackageName", new Class[0]);
                if (targetPkg != null) {
                    if (targetPkg.equalsIgnoreCase(pkg)) return controller;
                    continue;
                }

                if (anyActive == null) {
                    PlaybackState state = (PlaybackState) invokeReturn(controller, "getPlaybackState", new Class[0]);
                    if (state != null && (state.getState() == PlaybackState.STATE_PLAYING || state.getState() == PlaybackState.STATE_PAUSED)) {
                        anyActive = controller;
                    }
                }
                if (fallback == null) fallback = controller;
            }
            if (targetPkg != null) return null;
            // No package requested at all: whichever session is actually active, else the first resolvable one.
            return anyActive != null ? anyActive : fallback;
        } catch (Throwable t) { return null; }
    }

    public static JSONObject getMediaJson(String targetPkg, boolean forceFullArt) {
        JSONObject res = new JSONObject();
        try {
            res.put("type", "media_update");
            // Ordering: `seq` grows per snapshot (an older event must never overwrite a newer one); `epoch` identifies this
            // daemon process so a restart (seq back to 1) is not mistaken for a stale event.
            res.put("seq", mediaSeq.incrementAndGet());
            res.put("epoch", START_TIME_MS);
            Object sm = Binders.service("media_session", "android.media.session.ISessionManager$Stub");
            List<?> tokens = (List<?>) invokeReturn(sm, "getSessions", new Class[]{ComponentName.class, int.class}, null, 0);
            // `active:false` WITHOUT an error is a promise: "the phone has no media session at all" — the frontend then
            // clears every card. A list that could not be read is an error, never that promise.
            if (tokens == null) return res.put("active", false).put("error", "sessions_unavailable");
            if (tokens.isEmpty()) return res.put("active", false);

            Class<?> stubClass = Class.forName("android.media.session.ISessionController$Stub");
            Method asInterface = stubClass.getMethod("asInterface", IBinder.class);

            Object primaryController = null;
            JSONArray sessionsArr = new JSONArray();

            for (Object token : tokens) {
                ensureControllerCallbackForToken(token);
                Object controller = resolveSessionController(token, asInterface);
                if (controller == null) continue;

                String pkg = (String) invokeReturn(controller, "getPackageName", new Class[0]);
                if (pkg == null || pkg.isEmpty()) continue;

                PlaybackState state = (PlaybackState) invokeReturn(controller, "getPlaybackState", new Class[0]);
                MediaMetadata meta = (MediaMetadata) invokeReturn(controller, "getMetadata", new Class[0]);

                long pos = (state != null) ? state.getPosition() : 0;
                float speed = (state != null) ? state.getPlaybackSpeed() : 0;
                int stateCode = (state != null) ? state.getState() : 0;
                String stateStr = "NONE";
                if (state != null) {
                    if (stateCode == PlaybackState.STATE_PLAYING && speed > 0) {
                        pos += (long) ((SystemClock.elapsedRealtime() - state.getLastPositionUpdateTime()) * speed);
                    }
                    switch (stateCode) {
                        case PlaybackState.STATE_PLAYING: stateStr = "PLAYING"; break;
                        case PlaybackState.STATE_PAUSED: stateStr = "PAUSED"; break;
                        case PlaybackState.STATE_STOPPED: stateStr = "STOPPED"; break;
                        case PlaybackState.STATE_BUFFERING: stateStr = "BUFFERING"; break;
                        default: stateStr = "STATE_" + stateCode; break;
                    }
                }

                String title = meta != null && meta.getText(MediaMetadata.METADATA_KEY_TITLE) != null ? meta.getText(MediaMetadata.METADATA_KEY_TITLE).toString() : "";
                String artist = meta != null && meta.getText(MediaMetadata.METADATA_KEY_ARTIST) != null ? meta.getText(MediaMetadata.METADATA_KEY_ARTIST).toString() : "";
                String album = meta != null && meta.getText(MediaMetadata.METADATA_KEY_ALBUM) != null ? meta.getText(MediaMetadata.METADATA_KEY_ALBUM).toString() : "";
                long duration = meta != null ? meta.getLong(MediaMetadata.METADATA_KEY_DURATION) : 0;

                String trackKey = trackKeyOf(meta, pkg);
                String artB64 = getOrExtractArtwork(meta, pkg, trackKey, forceFullArt);

                JSONObject sessionObj = new JSONObject()
                        .put("package", pkg)
                        .put("track_id", trackKey)
                        .put("title", title)
                        .put("artist", artist)
                        .put("album", album)
                        .put("album_art", artB64)
                        .put("art_ready", !artB64.isEmpty())
                        .put("state", stateStr)
                        .put("is_playing", stateCode == PlaybackState.STATE_PLAYING)
                        .put("position", Math.min(pos, duration > 0 ? duration : pos))
                        .put("duration", duration)
                        .put("speed", speed);

                sessionsArr.put(sessionObj);

                if (targetPkg != null && targetPkg.equalsIgnoreCase(pkg)) {
                    primaryController = controller;
                } else if (primaryController == null && (stateCode == PlaybackState.STATE_PLAYING || stateCode == PlaybackState.STATE_PAUSED)) {
                    primaryController = controller;
                }
            }

            if (sessionsArr.length() == 0) return res.put("active", false).put("error", "sessions_unreadable");

            JSONObject mainSession = null;
            if (primaryController != null) {
                String primaryPkg = (String) invokeReturn(primaryController, "getPackageName", new Class[0]);
                for (int i = 0; i < sessionsArr.length(); i++) {
                    JSONObject s = sessionsArr.getJSONObject(i);
                    if (s.optString("package", "").equalsIgnoreCase(primaryPkg)) {
                        mainSession = s;
                        break;
                    }
                }
            }
            if (mainSession == null) {
                mainSession = sessionsArr.getJSONObject(0);
            }

            res.put("active", true)
               .put("package", mainSession.optString("package", ""))
               .put("track_id", mainSession.optString("track_id", ""))
               .put("title", mainSession.optString("title", ""))
               .put("artist", mainSession.optString("artist", ""))
               .put("album", mainSession.optString("album", ""))
               .put("album_art", mainSession.optString("album_art", ""))
               .put("art_ready", mainSession.optBoolean("art_ready", false))
               .put("state", mainSession.optString("state", "NONE"))
               .put("is_playing", mainSession.optBoolean("is_playing", false))
               .put("position", mainSession.optLong("position", 0))
               .put("duration", mainSession.optLong("duration", 0))
               .put("speed", mainSession.optDouble("speed", 0.0))
               .put("sessions", sessionsArr);

            return res;
        } catch (Throwable t) {
            return Json.obj("type", "media_update", "active", false, "error", Json.reason(t));
        }
    }

    private static String mediaDiffKey(JSONObject media) {
        return media.optBoolean("active", false) + "|" +
               media.optString("package", "") + "|" +
               media.optString("track_id", "") + "|" +
               media.optString("title", "") + "|" +
               media.optString("artist", "") + "|" +
               media.optString("state", "") + "|" +
               media.optBoolean("is_playing", false) + "|" +
               media.optLong("duration", 0) + "|" +
               media.optString("album_art", "").hashCode();
    }

    private static boolean invokeControllerAction(Object controller, String action, String pkg, long seekMs) {
        if (controller == null) return false;
        String[] callerPkgs = new String[]{
            (pkg != null && !pkg.isEmpty()) ? pkg : "com.android.shell",
            "com.android.shell",
            "android",
            "com.android.systemui"
        };
        if ("seek".equals(action)) {
            for (String caller : callerPkgs) {
                if (invokeVoid(controller, "seekTo", new Class[]{String.class, long.class}, caller, seekMs)) return true;
            }
            return invokeVoid(controller, "seekTo", new Class[]{long.class}, seekMs);
        } else {
            for (String caller : callerPkgs) {
                if (invokeVoid(controller, action, new Class[]{String.class}, caller)) return true;
            }
            return invokeVoid(controller, action, new Class[0]);
        }
    }

    /**
     * Daemon path: MediaSession first; the global media key only when no package was named — for a named package it
     * would land on whichever app holds media focus, i.e. act on the wrong app exactly when the named one is gone.
     */
    private static boolean executeMediaCommand(String action, String pkg, long targetMs) {
        return invokeMediaSession(action, pkg, targetMs) || (pkg == null && tryKeyEventFallback(action));
    }

    /** True when `pkg` currently owns a media session on the phone (exact package match, see getActiveSessionController). */
    static boolean hasMediaSession(String pkg) {
        return pkg != null && getActiveSessionController(pkg) != null;
    }

    /** A failed command for a named package: "session_gone" when that app has no media session any more. */
    private static JSONObject withMediaFailure(JSONObject res, boolean ok, String pkg) throws Exception {
        if (!ok && pkg != null && !hasMediaSession(pkg)) res.put("error", "session_gone").put("package", pkg);
        return res;
    }

    /**
     * MediaSession path only — no key-event fallback. Also used by the MediaBridge CLI, whose caller
     * (media_control.py) owns the key-event tier itself; a fallback here would press the key twice and, in the
     * short-lived CLI process, run on the daemon's scheduler thread after main() returned.
     * False = no session to target, or the call failed.
     */
    static boolean invokeMediaSession(String action, String pkg, long targetMs) {
        Object controller = getActiveSessionController(pkg);
        if (controller == null) return false;

        String act = action.toLowerCase();
        if ("prev".equals(act)) act = "previous"; // AIDL method is previous(), not prev()

        if ("toggle".equals(act) || "play_pause".equals(act)) {
            PlaybackState s = (PlaybackState) invokeReturn(controller, "getPlaybackState", new Class[0]);
            act = (s != null && s.getState() == PlaybackState.STATE_PLAYING) ? "pause" : "play";
        }

        return invokeControllerAction(controller, act, pkg, targetMs);
    }

    // =========================================================================
    // 5. Subsystems (Focus, Volumes, Hardware, Battery, Display/Task Ops)
    // =========================================================================

    private static JSONObject getFocusedWindowJson() {
        Object atm = Binders.activityTaskManager();

        // Preferred path: query the focused task directly. Own try/catch —
        // if this reflection path throws (different field/return shape on
        // some OEM), it must NOT take down the proven fallback below with it.
        try {
            JSONObject focus = focusJson(invokeReturn(atm, "getFocusedRootTaskInfo", new Class[0]));
            if (focus != null) return focus;
        } catch (Throwable ignored) {}

        // Fallback: the first visible root task.
        try {
            for (Object task : rootTasks(atm)) {
                if (task != null && task.getClass().getField("visible").getBoolean(task)) {
                    JSONObject focus = focusJson(task);
                    if (focus != null) return focus;
                }
            }
        } catch (Throwable ignored) {}
        return Json.obj("type", "focus_update", "displayId", 0, "package", "", "taskId", -1);
    }

    /** focus_update for a TaskInfo, or null when there is no task / no top activity. */
    private static JSONObject focusJson(Object task) throws Exception {
        if (task == null) return null;
        ComponentName cn = (ComponentName) task.getClass().getField("topActivity").get(task);
        if (cn == null) return null;
        return new JSONObject().put("type", "focus_update")
                .put("displayId", task.getClass().getField("displayId").getInt(task))
                .put("taskId", task.getClass().getField("taskId").getInt(task))
                .put("package", cn.getPackageName()).put("activity", cn.getClassName());
    }

    private static JSONObject getVolumesJson() {
        JSONObject res = new JSONObject();
        try {
            int[] streams = {3, 2, 5, 4};
            String[] names = {"MUSIC", "RING", "NOTIFICATION", "ALARM"};
            String[] labels = {"Medya", "Zil Sesi", "Bildirim", "Alarm"};
            AudioManager am = (AudioManager) getSystemContext().getSystemService(Context.AUDIO_SERVICE);

            JSONArray arr = new JSONArray();
            for (int i = 0; i < names.length; i++) {
                int id = streams[i];
                int curr = (am != null) ? am.getStreamVolume(id) : 0;
                int max = (am != null) ? am.getStreamMaxVolume(id) : 15;
                int min = (am != null && Build.VERSION.SDK_INT >= 28) ? am.getStreamMinVolume(id) : 0;
                // Some strict OEM builds throw SecurityException on isStreamMute() for
                // shell UID — must not let one stream's mute-check sink the whole payload.
                boolean mute = false;
                if (am != null && Build.VERSION.SDK_INT >= 23) {
                    try { mute = am.isStreamMute(id); } catch (Throwable ignored) {}
                }

                arr.put(new JSONObject().put("id", id).put("name", names[i]).put("label", labels[i])
                        .put("current", curr).put("max", max).put("min", min).put("muted", mute));
            }
            return res.put("type", "volumes_update").put("ok", true).put("streams", arr);
        } catch (Throwable t) {
            return Json.error("volumes_update", t);
        }
    }

    /** Which way the toggles were last read (logged once per way: a phone that rejects one identity is then visible in the log). */
    private static volatile String statesReadPath;

    private static final class Toggles {
        boolean wifi, bt, airplane, mobileData, rotLock, mute;
    }

    /** One read of the toggles through `cr`; throws what the Settings provider throws (a SecurityException for a wrong identity). */
    private static Toggles readToggles(android.content.ContentResolver cr, Context audioContext) {
        Toggles t = new Toggles();
        t.wifi = Settings.Global.getInt(cr, "wifi_on", 0) == 1;
        t.bt = Settings.Global.getInt(cr, "bluetooth_on", 0) == 1;
        t.airplane = Settings.Global.getInt(cr, "airplane_mode_on", 0) == 1;
        t.mobileData = Settings.Global.getInt(cr, "mobile_data", 0) == 1;
        t.rotLock = Settings.System.getInt(cr, "accelerometer_rotation", 1) == 0;
        AudioManager am = (AudioManager) audioContext.getSystemService(Context.AUDIO_SERVICE);
        if (am != null) t.mute = (am.getRingerMode() == AudioManager.RINGER_MODE_SILENT);
        return t;
    }

    private static void noteStatesPath(String path) {
        if (!path.equals(statesReadPath)) {
            statesReadPath = path;
            Log.info("States", "toggles are read " + path);
        }
    }

    private static JSONObject getHardwareStatesJson() {
        JSONObject res = new JSONObject();
        try {
            Context ctx = getSystemContext();
            Toggles t = null;
            Throwable shellFailure = null;
            Throwable systemFailure = null;

            if (ctx != null && ctx.getContentResolver() != null) {
                // The Settings provider is called with the package name its ContentResolver was built with. The system
                // context's says "android", which a uid-2000 caller may not claim (Android 12+: "Given calling package android
                // does not match caller's uid 2000", seen on HyperOS) — so the shell-identity resolver goes first, and the
                // system one stays as the way it always was if that cannot be built or is refused.
                ShellContext shell = ShellContext.get();
                if (shell != null && shell.hasShellResolver()) {
                    try {
                        t = readToggles(shell.getContentResolver(), ctx);
                        noteStatesPath("with the shell identity (com.android.shell)");
                    } catch (Throwable e) {
                        shellFailure = e;
                    }
                }
                if (t == null) {
                    try {
                        t = readToggles(ctx.getContentResolver(), ctx);
                        noteStatesPath("with the system context" + (shellFailure != null ? " (the shell identity failed: " + Json.reason(shellFailure) + ")" : ""));
                    } catch (Throwable e) {
                        systemFailure = e;
                    }
                }
                if (t == null) {
                    String why = (shellFailure != null ? "shell identity: " + Json.reason(shellFailure) + "; " : "") + "system context: " + Json.reason(systemFailure);
                    if (!why.equals(statesReadPath)) {
                        statesReadPath = why;
                        Log.warn("States", "toggles unreadable — " + why);
                    }
                    return res.put("type", "states_update").put("ok", false).put("error", why);
                }
            } else {
                t = new Toggles();
                t.wifi = "1".equals(execCommand("settings get global wifi_on"));
                t.bt = "1".equals(execCommand("settings get global bluetooth_on"));
                t.airplane = "1".equals(execCommand("settings get global airplane_mode_on"));
                t.mobileData = "1".equals(execCommand("settings get global mobile_data"));
                t.rotLock = "0".equals(execCommand("settings get system accelerometer_rotation"));
                // MODE_RINGER is historically a System-table key (like accelerometer_rotation
                // above), not Global — this branch only runs when ctx itself is unavailable,
                // which in practice never happens for this daemon (see getSystemContext()).
                t.mute = "0".equals(execCommand("settings get system mode_ringer"));
            }

            JSONObject states = new JSONObject()
                    .put("wifi", t.wifi).put("bluetooth", t.bt).put("mobile_data", t.mobileData)
                    .put("airplane_mode", t.airplane).put("rotation_lock", t.rotLock).put("mute", t.mute).put("torch", lastTorchState);
            return res.put("type", "states_update").put("ok", true).put("states", states);
        } catch (Throwable t) {
            return Json.error("states_update", t);
        }
    }

    /** 3-tier fallback: direct Binder call, then SurfaceControl (an explicit
     * power-mode SET — unlike a raw keyevent toggle, which can leave the
     * display in the wrong state if it was already off), then keyevent as
     * the last resort. */
    private static boolean setDisplayPower(int displayId, boolean on) {
        synchronized (SCREEN_LOCK) {
            cancelScreenRestoreLocked();
            String path = applyDisplayPower(displayId, on);
            // Only the raw paths are invisible to PowerManager (see screenOffByUs). Tracked for the physical panel only.
            if (displayId == 0) markScreenBlanked(!on && !"keyevent".equals(path));
            return true;
        }
    }

    /** Returns the path that applied the state: "display_manager", "surface_control" or "keyevent". */
    private static String applyDisplayPower(int displayId, boolean on) {
        Object dm = Binders.service("display", "android.hardware.display.IDisplayManager$Stub");
        if (dm != null) {
            boolean success = invokeVoid(dm, "requestDisplayPower", new Class[]{int.class, int.class}, displayId, on ? 2 : 1);
            if (success) {
                if (on) execCommand("input keyevent 224");
                return "display_manager";
            }
        }

        try {
            Class<?> scClass = Class.forName("android.view.SurfaceControl");
            Method getIds = scClass.getMethod("getPhysicalDisplayIds");
            long[] ids = (long[]) getIds.invoke(null);
            if (ids != null && ids.length > 0) {
                Method getToken = scClass.getMethod("getPhysicalDisplayToken", long.class);
                IBinder token = (IBinder) getToken.invoke(null, ids[0]);
                Method setPower = scClass.getMethod("setDisplayPowerMode", IBinder.class, int.class);
                setPower.invoke(null, token, on ? 2 : 0);
                if (on) execCommand("input keyevent 224");
                return "surface_control";
            }
        } catch (Throwable ignored) {}

        // KEYCODE_POWER (26) is a TOGGLE: with the panel already dark it would turn it ON. WAKEUP (224) and
        // SLEEP (223) are absolute, so a repeated command can never flip the state.
        execCommand(on ? "input keyevent 224" : "input keyevent 223");
        return "keyevent";
    }

    private static boolean setDisplayDensity(int displayId, int density) {
        Object wm = Binders.service("window", "android.view.IWindowManager$Stub");
        if (wm != null) {
            // -2 = UserHandle.USER_CURRENT
            if (invokeVoid(wm, "setForcedDisplayDensityForUser", new Class[]{int.class, int.class, int.class}, displayId, density, -2)) {
                return true;
            }
        }
        return execCommandOk("wm density " + density + " -d " + displayId);
    }

    private static boolean moveTaskToDisplay(int taskId, int displayId) {
        JSONObject res = moveTaskWct(taskId, displayId, 0, false, null);
        return res != null && res.optBoolean("ok", false);
    }

    /**
     * All root tasks. Some Android 10/11 and OEM ROMs (MIUI/HyperOS, ColorOS) return a raw RootTaskInfo[] instead of a
     * List — Object[] does NOT implement Iterable, so a bare cast throws ClassCastException and silently kills every
     * caller (focus tracking, task lookup) on those devices. Empty list when unavailable.
     */
    private static List<?> rootTasks(Object atm) {
        List<?> tasks = listOf(invokeReturn(atm, "getAllRootTaskInfos", new Class[0]));
        // Android 10/11: the same information is ActivityManager.StackInfo from getAllStackInfos().
        if (tasks.isEmpty() && Build.VERSION.SDK_INT < 31) tasks = listOf(invokeReturn(atm, "getAllStackInfos", new Class[0]));
        return tasks;
    }

    private static List<?> listOf(Object raw) {
        if (raw instanceof List) return (List<?>) raw;
        if (raw instanceof Object[]) return Arrays.asList((Object[]) raw);
        if (raw instanceof Iterable) {
            List<Object> out = new ArrayList<>();
            for (Object o : (Iterable<?>) raw) out.add(o);
            return out;
        }
        return Collections.emptyList();
    }

    /**
     * Every leaf task of every root task: [{id, display, visible, package?}] (tasks_update / tasks_list). Field
     * names: RootTaskInfo (API 31+) childTaskIds/childTaskNames, StackInfo (API 29–30) taskIds/taskNames. A name is
     * the task's root component "pkg/cls", or just a package, or "unknown" (ActivityTaskManagerService).
     */
    static JSONArray rootTasksJson() throws Exception {
        Object atm = Binders.activityTaskManager();
        if (atm == null) throw new IllegalStateException("activity_task service unavailable");
        List<?> roots = rootTasks(atm);
        // A real device always has at least the home task: nothing at all means the read failed (reflection drift).
        // Reported as a failure, never as "every app is gone" — the backend closes windows on missing tasks.
        if (roots.isEmpty()) throw new IllegalStateException("no root tasks readable");
        JSONArray out = new JSONArray();
        for (Object root : roots) {
            if (root == null) continue;
            int displayId = intField(root, "displayId", -1);
            boolean visible = boolField(root, "visible");
            int[] ids = (int[]) firstField(root, "childTaskIds", "taskIds");
            String[] names = (String[]) firstField(root, "childTaskNames", "taskNames");
            for (int i = 0; ids != null && i < ids.length; i++) {
                JSONObject t = new JSONObject().put("id", ids[i]).put("display", displayId).put("visible", visible);
                String pkg = packageOfTaskName(names != null && i < names.length ? names[i] : null);
                if (pkg != null) t.put("package", pkg);
                out.put(t);
            }
        }
        return out;
    }

    private static String packageOfTaskName(String name) {
        if (name == null || name.isEmpty() || "unknown".equals(name)) return null;
        int slash = name.indexOf('/');
        return slash > 0 ? name.substring(0, slash) : name;
    }

    private static Object firstField(Object o, String... names) {
        for (String n : names) {
            try {
                return o.getClass().getField(n).get(o);
            } catch (Throwable ignored) {}
        }
        return null;
    }

    private static int intField(Object o, String name, int fallback) {
        try {
            return o.getClass().getField(name).getInt(o);
        } catch (Throwable t) {
            return fallback;
        }
    }

    private static boolean boolField(Object o, String name) {
        try {
            return o.getClass().getField(name).getBoolean(o);
        } catch (Throwable t) {
            return false;
        }
    }

    /**
     * The TaskInfo for {@code taskId}: direct lookup (getRootTaskInfo, then the OEM getTaskInfo) and, failing that, a
     * scan of all root tasks. ONE lookup order for every caller — token resolution and geometry used to search in
     * different orders and could disagree about which object "the task" was.
     */
    private static Object findTaskInfo(Object atm, int taskId) {
        Object info = invokeReturn(atm, "getRootTaskInfo", new Class[]{int.class}, taskId);
        if (info == null) info = invokeReturn(atm, "getTaskInfo", new Class[]{int.class}, taskId);
        if (info != null) return info;
        for (Object t : rootTasks(atm)) {
            if (t == null) continue;
            try {
                if (t.getClass().getField("taskId").getInt(t) == taskId) return t;
            } catch (Throwable ignored) {}
        }
        return null;
    }

    /** A task's WindowContainerToken (TaskInfo.token field, or getToken() on builds that hide it); null if not found. */
    private static Object findTaskToken(Object atm, int taskId) {
        Object info = findTaskInfo(atm, taskId);
        if (info == null) return null;
        try {
            return info.getClass().getField("token").get(info);
        } catch (Throwable ignored) {}
        try {
            return info.getClass().getMethod("getToken").invoke(info);
        } catch (Throwable ignored) {}
        return null;
    }

    /** Fills a WindowContainerTransaction for one task; false = nothing to apply (the step logs why). */
    private interface WctStep {
        boolean fill(Object wct, Object token, Class<?> wctClass, Class<?> tokenClass) throws Throwable;
    }

    /**
     * Builds and applies a WindowContainerTransaction for one task via WindowOrganizerController — the shared shell of
     * setTaskWindowing and setTaskDensity (token lookup, WCT construction, applyTransaction, error logging).
     */
    private static boolean applyTaskTransaction(int taskId, String tag, WctStep step) {
        if (taskId < 0) return false;
        try {
            Object atm = Binders.activityTaskManager();
            if (atm == null) return false;

            Object token = findTaskToken(atm, taskId);
            if (token == null) {
                Log.warn("Daemon", tag + ": WindowContainerToken not found for taskId=" + taskId);
                return false;
            }

            Class<?> wctClass = Class.forName("android.window.WindowContainerTransaction");
            Class<?> tokenClass = Class.forName("android.window.WindowContainerToken");
            Object wct = wctClass.getDeclaredConstructor().newInstance();
            if (!step.fill(wct, token, wctClass, tokenClass)) return false;

            Object woc = invokeReturn(atm, "getWindowOrganizerController", new Class[0]);
            if (woc == null) return false;
            woc.getClass().getMethod("applyTransaction", wctClass).invoke(woc, wct);
            return true;
        } catch (Throwable t) {
            Log.error("Daemon", tag + " failed for taskId=" + taskId + ": " + t.getMessage());
            return false;
        }
    }

    /**
     * A task's windowing mode (1 = fullscreen, 5 = freeform) — and its bounds: cleared ({@code clearBounds}: an empty
     * Rect, so a task that left a Workspace fills the target display instead of keeping a small offset frame) or placed
     * ({@code place}: a task moving INTO a freeform display) — in ONE WindowContainerTransaction, so the task never shows
     * the new mode at the old size. The mode set here is the task's
     * REQUESTED mode and survives a move to another display: a task pinned to fullscreen on the phone stays fullscreen on
     * a freeform display until it is set back (there is no `am`/`cmd activity` command for this).
     */
    private static boolean setTaskWindowing(int taskId, int windowingMode, boolean clearBounds, Rect place) {
        boolean ok = applyTaskTransaction(taskId, "setTaskWindowing", (wct, token, wctClass, tokenClass) -> {
            wctClass.getMethod("setWindowingMode", tokenClass, int.class).invoke(wct, token, windowingMode);
            if (clearBounds || place != null) {
                try {
                    wctClass.getMethod("setBounds", tokenClass, Rect.class).invoke(wct, token, place != null ? place : new Rect());
                } catch (NoSuchMethodException nsme) {
                    Log.warn("Daemon", "setBounds not found on WCT; leaving bounds to the system");
                }
            }
            try {
                wctClass.getMethod("setFocusable", tokenClass, boolean.class).invoke(wct, token, true);
            } catch (Throwable ignored) {}
            try {
                wctClass.getMethod("reorder", tokenClass, boolean.class).invoke(wct, token, true);
            } catch (Throwable ignored) {}
            return true;
        });
        if (ok) Log.info("Daemon", "setTaskWindowing: taskId=" + taskId + " mode=" + windowingMode + " clearBounds=" + clearBounds
                + (place != null ? " bounds=" + place.toShortString() : ""));
        return ok;
    }

    /** "l,t,r,b" → Rect (a non-empty box); null for anything else ("true"/"false" are the legacy clear flag). */
    static Rect parseRect(String arg) {
        if (arg == null) return null;
        String[] p = arg.split(",");
        if (p.length != 4) return null;
        try {
            Rect r = new Rect(Integer.parseInt(p[0]), Integer.parseInt(p[1]), Integer.parseInt(p[2]), Integer.parseInt(p[3]));
            return r.width() > 0 && r.height() > 0 ? r : null;
        } catch (NumberFormatException e) {
            return null;
        }
    }

    /**
     * Resolves the target TaskDisplayArea's WindowContainerToken for a given displayId.
     * Tries multiple AOSP reflection paths:
     * 1. getAllRootTaskInfosOnDisplay(displayId)
     * 2. rootTasks(atm) scan for matching displayId -> displayAreaToken
     * 3. getRootTaskInfoOnDisplay(0, 0, displayId)
     * 4. getDisplayAreaInfo(displayId)
     */
    private static Object findTaskDisplayAreaToken(Object atm, int displayId) {
        if (atm == null) return null;
        try {
            // 1. Try getAllRootTaskInfosOnDisplay if available on atm
            try {
                Object list = atm.getClass().getMethod("getAllRootTaskInfosOnDisplay", int.class).invoke(atm, displayId);
                if (list instanceof List) {
                    for (Object t : (List<?>) list) {
                        if (t == null) continue;
                        Object daToken = extractDisplayAreaToken(t);
                        if (daToken != null) return daToken;
                    }
                }
            } catch (Throwable ignored) {}

            // 2. Search rootTasks(atm)
            for (Object t : rootTasks(atm)) {
                if (t == null) continue;
                try {
                    int dId = -1;
                    try {
                        dId = t.getClass().getField("displayId").getInt(t);
                    } catch (Throwable t1) {
                        try {
                            dId = (int) t.getClass().getMethod("getDisplayId").invoke(t);
                        } catch (Throwable ignored) {}
                    }
                    if (dId == displayId) {
                        Object daToken = extractDisplayAreaToken(t);
                        if (daToken != null) return daToken;
                    }
                } catch (Throwable ignored) {}
            }

            // 3. Try getRootTaskInfoOnDisplay(windowingMode, activityType, displayId)
            try {
                Object rootTask = atm.getClass().getMethod("getRootTaskInfoOnDisplay", int.class, int.class, int.class)
                        .invoke(atm, 0, 0, displayId);
                if (rootTask != null) {
                    Object daToken = extractDisplayAreaToken(rootTask);
                    if (daToken != null) return daToken;
                }
            } catch (Throwable ignored) {}

            // 4. Try getDisplayAreaInfo(displayId)
            try {
                Object dai = atm.getClass().getMethod("getDisplayAreaInfo", int.class).invoke(atm, displayId);
                if (dai != null) {
                    try {
                        Object tok = dai.getClass().getField("token").get(dai);
                        if (tok != null) return tok;
                    } catch (Throwable ignored) {}
                    try {
                        Object tok = dai.getClass().getMethod("getToken").invoke(dai);
                        if (tok != null) return tok;
                    } catch (Throwable ignored) {}
                }
            } catch (Throwable ignored) {}
        } catch (Throwable ignored) {}
        return null;
    }

    private static Object extractDisplayAreaToken(Object taskInfo) {
        if (taskInfo == null) return null;
        try {
            return taskInfo.getClass().getField("displayAreaToken").get(taskInfo);
        } catch (Throwable ignored) {}
        try {
            return taskInfo.getClass().getMethod("getDisplayAreaToken").invoke(taskInfo);
        } catch (Throwable ignored) {}
        return null;
    }

    /**
     * Pure WindowContainerTransaction (WCT) atomic task movement without silent fallbacks.
     * Moves task to target display's TaskDisplayArea, applies windowingMode, bounds, and focus
     * in a single VSYNC transaction.
     */
    private static JSONObject moveTaskWct(int taskId, int targetDisplayId, int windowingMode, boolean clearBounds, Rect place) {
        JSONObject res = Json.obj("type", "move_task_wct_result", "task_id", taskId, "display_id", targetDisplayId);
        if (taskId <= 0) {
            return Json.put(Json.put(res, "ok", false), "error", "bad_task_id");
        }

        Object atm = Binders.activityTaskManager();
        if (atm == null) {
            return Json.put(Json.put(res, "ok", false), "error", "atm_null");
        }

        Object taskToken = findTaskToken(atm, taskId);
        if (taskToken == null) {
            Log.warn("Daemon", "[WCT_PURE] WindowContainerToken not found for taskId=" + taskId);
            return Json.put(Json.put(res, "ok", false), "error", "task_token_null");
        }

        Object targetTdaToken = findTaskDisplayAreaToken(atm, targetDisplayId);
        // Tier 1: Full Atomic WCT Reparent + Bounds + Mode + Density Reset
        if (taskToken != null && targetTdaToken != null) {
            try {
                Class<?> wctClass = Class.forName("android.window.WindowContainerTransaction");
                Class<?> tokenClass = Class.forName("android.window.WindowContainerToken");
                Object wct = wctClass.getDeclaredConstructor().newInstance();

                // 1. Reparent to target display area
                try {
                    wctClass.getMethod("reparent", tokenClass, tokenClass, boolean.class)
                            .invoke(wct, taskToken, targetTdaToken, true);
                } catch (Throwable t) {
                    Log.warn("Daemon", "wct.reparent reflection failed: " + t);
                }

                // 2. Set windowing mode if specified (1=fullscreen, 5=freeform)
                if (windowingMode > 0) {
                    try {
                        wctClass.getMethod("setWindowingMode", tokenClass, int.class)
                                .invoke(wct, taskToken, windowingMode);
                    } catch (Throwable ignored) {}
                }

                // 3. Set bounds if specified
                if (clearBounds || place != null) {
                    try {
                        wctClass.getMethod("setBounds", tokenClass, Rect.class)
                                .invoke(wct, taskToken, place != null ? place : new Rect());
                    } catch (Throwable ignored) {}
                }

                // 4. Reset per-task density override to 0 so the task inherits the target display's native density
                try {
                    wctClass.getMethod("setDensityDpi", tokenClass, int.class)
                            .invoke(wct, taskToken, 0);
                } catch (Throwable ignored) {}

                // 5. Focus & Reorder on top
                try {
                    wctClass.getMethod("setFocusable", tokenClass, boolean.class).invoke(wct, taskToken, true);
                } catch (Throwable ignored) {}
                try {
                    wctClass.getMethod("reorder", tokenClass, boolean.class).invoke(wct, taskToken, true);
                } catch (Throwable ignored) {}

                // Apply transaction
                Object woc = invokeReturn(atm, "getWindowOrganizerController", new Class[0]);
                if (woc != null) {
                    woc.getClass().getMethod("applyTransaction", wctClass).invoke(woc, wct);
                    Log.info("Daemon", "⚡ [WCT:TIER1_ATOMIC_SUCCESS] taskId=" + taskId + " -> display=" + targetDisplayId
                            + " mode=" + windowingMode + (place != null ? " bounds=" + place.toShortString() : ""));
                    return Json.put(Json.put(res, "ok", true), "tier", "wct_atomic");
                }
            } catch (Throwable t) {
                Log.warn("Daemon", "Tier 1 WCT move failed for taskId=" + taskId + ": " + t + "; falling back to Tier 2 (Plan B)");
            }
        }

        // Tier 2 (Plan B): ATM Binder moveRootTaskToDisplay + atomic WCT Windowing + Density Reset
        boolean moveOk = invokeVoid(atm, "moveRootTaskToDisplay", new Class[]{int.class, int.class}, taskId, targetDisplayId);
        if (!moveOk) {
            moveOk = execCommandOk("am display move-stack " + taskId + " " + targetDisplayId);
        }

        if (moveOk) {
            if (windowingMode > 0 || clearBounds || place != null) {
                setTaskWindowing(taskId, windowingMode > 0 ? windowingMode : 1, clearBounds, place);
            }
            setTaskDensity(taskId, 0); // Reset density override on target display
        }

        Log.info("Daemon", "⚡ [WCT:TIER2_BINDER_SUCCESS] taskId=" + taskId + " -> display=" + targetDisplayId
                + " ok=" + moveOk + " mode=" + windowingMode);
        return Json.put(Json.put(res, "ok", moveOk), "tier", "atm_binder");
    }

    private static boolean setTaskDensity(int taskId, int density) {
        boolean ok = applyTaskTransaction(taskId, "setTaskDensity", (wct, token, wctClass, tokenClass) -> {
            boolean applied = false;
            try {
                wctClass.getMethod("setDensityDpi", tokenClass, int.class).invoke(wct, token, density);
                applied = true;
            } catch (NoSuchMethodException nsme) {
                Log.warn("Daemon", "setDensityDpi not found on WCT (per-task density needs Android 12+); not applied");
            }
            return applied;
        });
        if (ok) Log.info("Daemon", "setTaskDensity: Applied density=" + density + " to taskId=" + taskId);
        return ok;
    }

    /**
     * Verilen Task ID'nin üst Activity'sinin DPI değişimini kendi karşılayıp karşılamadığını ve
     * SizeCompat modunda olup olmadığını denetler.
     */
    private static JSONObject taskDensityInfo(int taskId) {
        if (taskId < 0) {
            return Json.obj("type", "task_density_info", "ok", false, "error", "invalid_task_id");
        }
        try {
            Object atm = Binders.activityTaskManager();
            Object info = atm == null ? null : findTaskInfo(atm, taskId);
            if (info == null) {
                return Json.obj("type", "task_density_info", "ok", false, "task_id", taskId, "error", "task_not_found");
            }
            JSONObject res = Json.obj("type", "task_density_info", "ok", true, "task_id", taskId);
            try {
                Field topAiField = info.getClass().getField("topActivityInfo");
                Object ai = topAiField.get(info);
                if (ai != null) {
                    Field nameField = ai.getClass().getField("name");
                    Json.put(res, "activity", nameField.get(ai));
                    Field configChangesField = ai.getClass().getField("configChanges");
                    int configChanges = configChangesField.getInt(ai);
                    Json.put(res, "config_changes", configChanges);
                    // ActivityInfo.CONFIG_DENSITY = 0x1000
                    boolean handlesDensity = (configChanges & 0x1000) != 0;
                    Json.put(res, "handles_density", handlesDensity);
                }
            } catch (Throwable ignored) {}
            try {
                Field sizeCompatField = info.getClass().getField("topActivityInSizeCompat");
                Json.put(res, "in_size_compat", sizeCompatField.getBoolean(info));
            } catch (Throwable ignored) {}
            try {
                Field configField = info.getClass().getField("configuration");
                Object config = configField.get(info);
                if (config != null) {
                    Field densityDpiField = config.getClass().getField("densityDpi");
                    Json.put(res, "density_dpi", densityDpiField.getInt(config));
                }
            } catch (Throwable ignored) {}
            return res;
        } catch (Throwable t) {
            return Json.obj("type", "task_density_info", "ok", false, "task_id", taskId, "error", Json.reason(t));
        }
    }

    /**
     * Android'in yerel SizeCompat yenileme mekanizmasını çalıştırır (Android 11 - 16 uyumlu):
     * Activity durumu (savedInstanceState / icicle) korunur, süreç hedef ekranın güncel DPI'ı ile yeniden başlatılır.
     * YouTube gibi configChanges={density} dinleyip View ağacını re-inflate etmeyen uygulamaları düzeltir.
     */
    private static boolean restartTaskTopActivity(int taskId) {
        if (taskId < 0) return false;
        try {
            Object atm = Binders.activityTaskManager();
            if (atm == null) return false;

            Object token = findTaskToken(atm, taskId);
            if (token == null) {
                Log.warn("Daemon", "restartTaskTopActivity: WindowContainerToken bulunamadı, taskId=" + taskId);
                return false;
            }

            // Katman 1: Android 12+ (API 31 - 16) ve Android 11 — ITaskOrganizerController.restartTaskTopActivityProcessIfVisible(token)
            try {
                Object toc = null;
                Object woc = invokeReturn(atm, "getWindowOrganizerController", new Class[0]);
                if (woc != null) {
                    toc = invokeReturn(woc, "getTaskOrganizerController", new Class[0]);
                }
                if (toc == null) {
                    toc = invokeReturn(atm, "getTaskOrganizerController", new Class[0]);
                }
                if (toc != null) {
                    Class<?> tokenClass = Class.forName("android.window.WindowContainerToken");
                    Method restartMethod = toc.getClass().getMethod("restartTaskTopActivityProcessIfVisible", tokenClass);
                    restartMethod.invoke(toc, token);
                    Log.info("Daemon", "restartTaskTopActivity (ITaskOrganizerController) başarıyla tetiklendi, taskId=" + taskId);
                    return true;
                }
            } catch (NoSuchMethodException nsme) {
                Log.info("Daemon", "ITaskOrganizerController.restartTaskTopActivityProcessIfVisible bulunamadı, Katman 2 deneniyor");
            } catch (Throwable t) {
                Log.info("Daemon", "ITaskOrganizerController restart denemesi: " + t.getMessage());
            }

            // Katman 2: Android 11 (API 30) — ActivityTaskManagerService.restartActivityProcessIfVisible(IBinder)
            try {
                IBinder binderToken = null;
                if (token instanceof IBinder) {
                    binderToken = (IBinder) token;
                } else {
                    try {
                        Method asBinder = token.getClass().getMethod("asBinder");
                        binderToken = (IBinder) asBinder.invoke(token);
                    } catch (Throwable ignored) {
                        try {
                            Field f = token.getClass().getDeclaredField("mRealToken");
                            f.setAccessible(true);
                            Object realToken = f.get(token);
                            if (realToken instanceof IBinder) binderToken = (IBinder) realToken;
                            else if (realToken != null) {
                                binderToken = (IBinder) realToken.getClass().getMethod("asBinder").invoke(realToken);
                            }
                        } catch (Throwable ignored2) {}
                    }
                }

                if (binderToken != null) {
                    try {
                        Method m = atm.getClass().getMethod("restartActivityProcessIfVisible", IBinder.class);
                        m.invoke(atm, binderToken);
                        Log.info("Daemon", "restartTaskTopActivity (Android 11 ATMS.restartActivityProcessIfVisible) başarıyla tetiklendi, taskId=" + taskId);
                        return true;
                    } catch (NoSuchMethodException ignored) {}
                }
            } catch (Throwable t11) {
                Log.info("Daemon", "Katman 2 (Android 11) denemesi: " + t11.getMessage());
            }

            return false;
        } catch (Throwable t) {
            Log.warn("Daemon", "restartTaskTopActivity başarısız (taskId=" + taskId + "): " + Json.reason(t));
            return false;
        }
    }

    private static JSONArray rectJson(Rect r) {
        return new JSONArray().put(r.left).put(r.top).put(r.right).put(r.bottom);
    }

    private static JSONObject taskGeometryError(int taskId, String error) {
        return Json.obj("type", "task_geometry_result", "ok", false, "task_id", taskId, "error", error);
    }

    private static JSONObject getTaskGeometry(int taskId) {
        if (taskId < 0) {
            return Json.obj("type", "task_geometry_result", "ok", false, "error", "invalid_task_id");
        }
        try {
            Object atm = Binders.activityTaskManager();
            if (atm == null) {
                return Json.obj("type", "task_geometry_result", "ok", false, "error", "atm_unavailable");
            }

            Object taskInfo = findTaskInfo(atm, taskId);
            if (taskInfo == null) return taskGeometryError(taskId, "task_not_found");

            Rect bounds = null;
            Rect appBounds = null;

            // 1. Try configuration.windowConfiguration (Standard AOSP 10+)
            try {
                Field fConfig = taskInfo.getClass().getField("configuration");
                Object config = fConfig.get(taskInfo);
                if (config != null) {
                    Field fWinConfig = config.getClass().getField("windowConfiguration");
                    Object winConfig = fWinConfig.get(config);
                    if (winConfig != null) {
                        try {
                            bounds = (Rect) winConfig.getClass().getMethod("getBounds").invoke(winConfig);
                        } catch (Throwable ignored) {}
                        try {
                            appBounds = (Rect) winConfig.getClass().getMethod("getAppBounds").invoke(winConfig);
                        } catch (Throwable ignored) {}
                        if (bounds == null) {
                            try {
                                Field fb = winConfig.getClass().getDeclaredField("mBounds");
                                fb.setAccessible(true);
                                bounds = (Rect) fb.get(winConfig);
                            } catch (Throwable ignored) {}
                        }
                        if (appBounds == null) {
                            try {
                                Field fab = winConfig.getClass().getDeclaredField("mAppBounds");
                                fab.setAccessible(true);
                                appBounds = (Rect) fab.get(winConfig);
                            } catch (Throwable ignored) {}
                        }
                    }
                }
            } catch (Throwable ignored) {}

            // 2. Try getWindowConfiguration() method directly on taskInfo
            if (bounds == null) {
                try {
                    Object winConfig = taskInfo.getClass().getMethod("getWindowConfiguration").invoke(taskInfo);
                    if (winConfig != null) {
                        try {
                            bounds = (Rect) winConfig.getClass().getMethod("getBounds").invoke(winConfig);
                        } catch (Throwable ignored) {}
                        if (appBounds == null) {
                            try {
                                appBounds = (Rect) winConfig.getClass().getMethod("getAppBounds").invoke(winConfig);
                            } catch (Throwable ignored) {}
                        }
                    }
                } catch (Throwable ignored) {}
            }

            // 3. Fallback to direct field 'bounds' if present
            if (bounds == null) {
                try {
                    Field fBounds = taskInfo.getClass().getField("bounds");
                    bounds = (Rect) fBounds.get(taskInfo);
                } catch (Throwable ignored) {}
            }

            if (bounds == null) return taskGeometryError(taskId, "bounds_not_found");

            JSONObject res = new JSONObject()
                    .put("type", "task_geometry_result")
                    .put("ok", true)
                    .put("task_id", taskId)
                    .put("bounds", rectJson(bounds));
            if (appBounds != null) res.put("app_bounds", rectJson(appBounds));
            putTaskDetails(res, taskInfo);
            return res;
        } catch (Throwable t) {
            Log.error("Daemon", "getTaskGeometry failed for taskId=" + taskId + ": " + t.getMessage());
            return taskGeometryError(taskId, t.getMessage());
        }
    }

    /** WindowConfiguration.getWindowingMode() of a TaskInfo (1 fullscreen, 5 freeform, …); -1 when unreadable. */
    private static int windowingMode(Object taskInfo) {
        try {
            Object config = taskInfo.getClass().getField("configuration").get(taskInfo);
            Object winConfig = config.getClass().getField("windowConfiguration").get(config);
            return (Integer) winConfig.getClass().getMethod("getWindowingMode").invoke(winConfig);
        } catch (Throwable t) {
            return -1;
        }
    }

    private static String componentText(Object taskInfo, String field) {
        try {
            ComponentName cn = (ComponentName) taskInfo.getClass().getField(field).get(taskInfo);
            return cn != null ? cn.flattenToShortString() : null;
        } catch (Throwable t) {
            return null;
        }
    }

    /** What `dumpsys activity activities <task>` was read for: display, windowing mode, activity count, top/base. */
    private static void putTaskDetails(JSONObject res, Object taskInfo) {
        if (taskInfo == null) return;
        int display = intField(taskInfo, "displayId", -1);
        if (display >= 0) Json.put(res, "display", display);
        int mode = windowingMode(taskInfo);
        if (mode >= 0) Json.put(res, "mode", mode);
        int activities = intField(taskInfo, "numActivities", -1);
        if (activities >= 0) Json.put(res, "num_activities", activities);
        Json.put(res, "top", componentText(taskInfo, "topActivity"));
        Json.put(res, "base", componentText(taskInfo, "baseActivity"));
        try { Json.put(res, "visible", taskInfo.getClass().getField("isVisible").getBoolean(taskInfo)); } catch (Throwable ignored) {}
    }

    /** The root task whose leaves include {@code taskId} (home, split screen: the leaf is not a root task itself). */
    private static Object rootContaining(Object atm, int taskId) {
        for (Object root : rootTasks(atm)) {
            int[] ids = root == null ? null : (int[]) firstField(root, "childTaskIds", "taskIds");
            for (int i = 0; ids != null && i < ids.length; i++) {
                if (ids[i] == taskId) return root;
            }
        }
        return null;
    }

    /** task_info: the details of one task (a nested leaf reports its root's), or {ok:false, error:"task_not_found"}. */
    private static JSONObject taskInfoJson(int taskId) {
        Object atm = Binders.activityTaskManager();
        Object info = atm == null || taskId < 0 ? null : findTaskInfo(atm, taskId);
        if (info == null && atm != null && taskId >= 0) info = rootContaining(atm, taskId);
        if (info == null) return Json.obj("type", "task_info", "ok", false, "task_id", taskId, "error", "task_not_found");
        JSONObject res = Json.obj("type", "task_info", "ok", true, "task_id", taskId);
        putTaskDetails(res, info);
        return res;
    }

    private static String packageOf(String flatComponent) {
        if (flatComponent == null) return null;
        int slash = flatComponent.indexOf('/');
        return slash > 0 ? flatComponent.substring(0, slash) : flatComponent;
    }

    /**
     * find_task <pkg> [display]: the most recent task of a package (root tasks come top-to-bottom, a root's leaves are
     * searched top-most first), on exactly that display when given. The reply carries task_info's details so one call
     * answers "which task, where, in what mode, how deep". {ok:true, found:false} when there is none — only an
     * unreadable task list is an error (the backend then falls back to its shell path).
     */
    private static JSONObject findTaskJson(String pkg, Integer displayId) {
        Object atm = Binders.activityTaskManager();
        List<?> roots = atm == null ? Collections.emptyList() : rootTasks(atm);
        if (roots.isEmpty()) return Json.obj("type", "find_task", "ok", false, "error", "no root tasks readable");
        for (Object root : roots) {
            if (root == null) continue;
            int display = intField(root, "displayId", -1);
            if (displayId != null && display != displayId) continue;
            int[] ids = (int[]) firstField(root, "childTaskIds", "taskIds");
            String[] names = (String[]) firstField(root, "childTaskNames", "taskNames");
            int match = -1;
            for (int i = ids == null ? -1 : ids.length - 1; i >= 0 && match < 0; i--) {
                if (pkg.equals(packageOfTaskName(names != null && i < names.length ? names[i] : null))) match = ids[i];
            }
            if (match < 0 && ids != null && ids.length == 1
                    && (pkg.equals(packageOf(componentText(root, "topActivity")))
                        || pkg.equals(packageOf(componentText(root, "baseActivity"))))) {
                match = ids[0];
            }
            if (match < 0) continue;
            JSONObject res = Json.obj("type", "find_task", "ok", true, "found", true, "task_id", match,
                    "display", display, "visible", boolField(root, "visible"));
            Object info = findTaskInfo(atm, match);
            putTaskDetails(res, info != null ? info : root);
            Json.put(res, "display", display); // the root's display is authoritative for a nested leaf
            return res;
        }
        return Json.obj("type", "find_task", "ok", true, "found", false);
    }

    /**
     * top_activities: the top activity of every root task [{task, display, visible, top}] — e.g. "is an OEM app-lock
     * screen up anywhere?", which used to take a full `dumpsys activity activities`.
     */
    private static JSONObject topActivitiesJson() {
        Object atm = Binders.activityTaskManager();
        List<?> roots = atm == null ? Collections.emptyList() : rootTasks(atm);
        if (roots.isEmpty()) return Json.obj("type", "top_activities", "ok", false, "error", "no root tasks readable");
        JSONArray out = new JSONArray();
        for (Object root : roots) {
            if (root == null) continue;
            out.put(Json.obj("task", intField(root, "taskId", -1), "display", intField(root, "displayId", -1),
                    "visible", boolField(root, "visible"), "top", componentText(root, "topActivity")));
        }
        return Json.obj("type", "top_activities", "ok", true, "tasks", out);
    }

    /**
     * power_get: what `dumpsys power` was read for — {interactive, wakefulness: awake|asleep, display_state:
     * on|off|doze|doze_suspend|vr|on_suspend} of the built-in display. A panel WE blanked raw stays invisible here,
     * exactly as it was to `dumpsys power` (the greeting's screen_blanked covers that).
     */
    private static JSONObject powerStateJson() {
        try {
            Context ctx = getSystemContext();
            PowerManager pm = ctx != null ? (PowerManager) ctx.getSystemService(Context.POWER_SERVICE) : null;
            if (pm == null) return Json.obj("type", "power_state", "ok", false, "error", "power_manager_unavailable");
            boolean interactive = pm.isInteractive();
            JSONObject res = Json.obj("type", "power_state", "ok", true, "interactive", interactive,
                    "wakefulness", interactive ? "awake" : "asleep");
            android.hardware.display.DisplayManager dm =
                    (android.hardware.display.DisplayManager) ctx.getSystemService(Context.DISPLAY_SERVICE);
            android.view.Display d = dm != null ? dm.getDisplay(0) : null;
            if (d != null) {
                String[] names = {null, "off", "on", "doze", "doze_suspend", "vr", "on_suspend"};
                int state = d.getState();
                if (state > 0 && state < names.length) Json.put(res, "display_state", names[state]);
            }
            return res;
        } catch (Throwable t) {
            return Json.error("power_state", t);
        }
    }

    /** dump <service> [args…]: the in-process service dump (see BinderDump), for the few allow-listed services. */
    private static JSONObject dumpJson(String[] parts) {
        String service = parts.length > 1 ? parts[1] : "";
        if (!BinderDump.ALLOWED.contains(service)) {
            return Json.obj("type", "dump_result", "ok", false, "service", service, "error", "service_not_allowed");
        }
        try {
            String text = BinderDump.dump(service, Arrays.copyOfRange(parts, 2, parts.length), 4000);
            return Json.obj("type", "dump_result", "ok", true, "service", service, "text", text);
        } catch (Throwable t) {
            return Json.obj("type", "dump_result", "ok", false, "service", service, "error", Json.reason(t));
        }
    }

    // =========================================================================
    // 6. Command Dispatch Engine
    // =========================================================================

    private static JSONObject handleCommand(String line, String[] parts) {
        String cmd = parts[0].toLowerCase();
        JSONObject res = new JSONObject();
        try {
            switch (cmd) {
                // clock_us: the device's monotonic clock — the clock of the audio PTS. The PC works out its offset from it
                // (a few probes, min round trip) to present the same captured moment as the phone does.
                case "ping": return res.put("type", "pong").put("clock_us", System.nanoTime() / 1000L);
                case "proc_probe": {
                    // proc_probe <base64(comma-separated packages)> — the CPU counters + stat lines the backend's CPU
                    // telemetry needs, read from /proc in-process (ProcProbe) instead of a shell loop.
                    String csv = parts.length > 1
                            ? new String(java.util.Base64.getDecoder().decode(parts[1]), StandardCharsets.UTF_8) : "";
                    List<String> packages = new ArrayList<>();
                    for (String name : csv.split(",")) {
                        if (ProcProbe.isPackageName(name.trim())) packages.add(name.trim());
                    }
                    return res.put("type", "proc_probe_result").put("ok", true).put("out", ProcProbe.probe(packages));
                }
                case "media_get": return getMediaJson(sanitizePkg(parts.length > 1 ? parts[1] : null), true);
                case "media_action": {
                    String act = parts.length > 1 ? parts[1] : "toggle";
                    String pkg = sanitizePkg(parts.length > 2 ? parts[2] : null);
                    boolean ok = executeMediaCommand(act, pkg, 0);
                    scheduler.schedule(() -> broadcast(getMediaJson(pkg, true).toString()), 150, TimeUnit.MILLISECONDS);
                    return withMediaFailure(res.put("type", "media_action_result").put("ok", ok).put("action", act), ok, pkg);
                }
                case "media_seek": {
                    long targetMs = (parts.length > 1) ? (long) Double.parseDouble(parts[1]) : 0;
                    String pkg = sanitizePkg(parts.length > 2 ? parts[2] : null);
                    boolean ok = executeMediaCommand("seek", pkg, targetMs);
                    scheduler.schedule(() -> broadcast(getMediaJson(pkg, false).toString()), 150, TimeUnit.MILLISECONDS);
                    return withMediaFailure(res.put("type", "media_seek_result").put("ok", ok).put("position", targetMs), ok, pkg);
                }
                case "get_focus": return getFocusedWindowJson();
                case "set_density": {
                    int displayId = parts.length > 1 ? Integer.parseInt(parts[1]) : 0;
                    int density = parts.length > 2 ? Integer.parseInt(parts[2]) : 160;
                    boolean ok = setDisplayDensity(displayId, density);
                    return res.put("type", "set_density_result").put("ok", ok).put("display_id", displayId).put("dpi", density);
                }
                case "set_task_density": {
                    int taskId = parts.length > 1 ? Integer.parseInt(parts[1]) : -1;
                    int density = parts.length > 2 ? Integer.parseInt(parts[2]) : 160;
                    boolean ok = setTaskDensity(taskId, density);
                    return res.put("type", "set_task_density_result").put("ok", ok).put("task_id", taskId).put("dpi", density);
                }
                case "set_task_windowing": {
                    // set_task_windowing <task> <mode> [true | false | l,t,r,b]: "true" clears the task's override bounds,
                    // l,t,r,b places it (a freeform task moving INTO a display) — in the SAME transaction as the mode.
                    int taskId = parts.length > 1 ? Integer.parseInt(parts[1]) : -1;
                    int windowingMode = parts.length > 2 ? Integer.parseInt(parts[2]) : 1;
                    String boundsArg = parts.length > 3 ? parts[3] : "false";
                    Rect place = parseRect(boundsArg);
                    boolean clearBounds = place == null && "true".equalsIgnoreCase(boundsArg);
                    boolean ok = setTaskWindowing(taskId, windowingMode, clearBounds, place);
                    return res.put("type", "set_task_windowing_result").put("ok", ok).put("task_id", taskId).put("mode", windowingMode);
                }
                case "get_task_geometry": {
                    int taskId = -1;
                    if (parts.length > 1) {
                        try {
                            taskId = Integer.parseInt(parts[1]);
                        } catch (Throwable ignored) {}
                    }
                    return getTaskGeometry(taskId);
                }
                case "move_task_wct": {
                    int taskId = -1;
                    int displayId = 0;
                    int mode = 0;
                    String boundsArg = "false";
                    try {
                        if (parts.length > 1) taskId = Integer.parseInt(parts[1]);
                        if (parts.length > 2) displayId = Integer.parseInt(parts[2]);
                        if (parts.length > 3) mode = Integer.parseInt(parts[3]);
                        if (parts.length > 4) boundsArg = parts[4];
                    } catch (Throwable ignored) {}
                    Rect place = parseRect(boundsArg);
                    boolean clearBounds = place == null && "true".equalsIgnoreCase(boundsArg);
                    return moveTaskWct(taskId, displayId, mode, clearBounds, place);
                }
                case "move_task_to_display":
                case "move_task": {
                    int taskId = -1;
                    int displayId = 0;
                    try {
                        if (parts.length > 1) taskId = Integer.parseInt(parts[1]);
                        if (parts.length > 2) displayId = Integer.parseInt(parts[2]);
                    } catch (Throwable ignored) {}
                    if (taskId <= 0) {
                        return res.put("type", "move_task_result").put("ok", false).put("error", "bad_args");
                    }
                    boolean ok = moveTaskToDisplay(taskId, displayId);
                    return res.put("type", "move_task_result").put("ok", ok).put("task_id", taskId).put("display_id", displayId);
                }
                case "volumes_get": return getVolumesJson();
                case "volume_set": {
                    if (parts.length < 3) return res.put("type", "volume_set_result").put("ok", false).put("error", "missing_args");
                    int sId = Integer.parseInt(parts[1]), val = Integer.parseInt(parts[2]);
                    AudioManager am = (AudioManager) getSystemContext().getSystemService(Context.AUDIO_SERVICE);
                    if (am != null) am.setStreamVolume(sId, val, 0);
                    execCommand("cmd audio set-volume " + sId + " " + val);
                    broadcast(getVolumesJson().toString());
                    return res.put("type", "volume_set_result").put("ok", true).put("stream_id", sId).put("value", val);
                }
                case "states_get": return getHardwareStatesJson();
                case "state_set": {
                    if (parts.length < 3) return res.put("type", "state_set_result").put("ok", false).put("error", "missing_args");
                    String k = parts[1].toLowerCase();
                    boolean v = "true".equalsIgnoreCase(parts[2]) || "1".equals(parts[2]);
                    // Unknown key falls through to the else — must NOT silently
                    // report ok:true for a typo'd or unsupported state key.
                    if ("wifi".equals(k)) execCommand(v ? "svc wifi enable" : "svc wifi disable");
                    else if ("bluetooth".equals(k)) execCommand(v ? "svc bluetooth enable" : "svc bluetooth disable");
                    else if ("mobile_data".equals(k)) execCommand(v ? "svc data enable" : "svc data disable");
                    else if ("airplane_mode".equals(k)) {
                        execCommand("settings put global airplane_mode_on " + (v ? "1" : "0"));
                        execCommand("am broadcast -a android.intent.action.AIRPLANE_MODE --ez state " + v);
                    } else if ("rotation_lock".equals(k)) execCommand("settings put system accelerometer_rotation " + (v ? "0" : "1"));
                    else if ("mute".equals(k)) execCommand("cmd audio set-ringer-mode " + (v ? "SILENT" : "NORMAL"));
                    else if ("torch".equals(k)) {
                        CameraManager cm = (CameraManager) getSystemContext().getSystemService(Context.CAMERA_SERVICE);
                        if (cm != null) {
                            String[] ids = cm.getCameraIdList();
                            if (ids != null && ids.length > 0) {
                                cm.setTorchMode(ids[0], v);
                                lastTorchState = v;
                            }
                        }
                    } else if ("display_power".equals(k)) setDisplayPower(0, v);
                    else return res.put("type", "state_set_result").put("ok", false).put("error", "unknown_state_key");

                    broadcast(getHardwareStatesJson().toString());
                    return res.put("type", "state_set_result").put("ok", true).put("key", k).put("value", v);
                }
                case "battery_get": return Battery.updateJson();
                case "battery_health": return Battery.health();
                case "notifications_list": return NotificationEvents.snapshotJson();
                case "notif_invoke": return Json.put(NotificationInvoker.run(Arrays.copyOfRange(parts, 1, parts.length)),
                        "type", "notif_invoke_result");
                case "thermal_get": return ThermalEvents.snapshotJson();
                case "event_log":
                    // event_log <since epoch sec.frac> <tag,tag,…>
                    return parts.length < 3 ? Json.obj("type", "event_log", "ok", false, "error", "missing_args")
                                            : EventLogReader.read(parts[1], parts[2]);
                case "load_sample": return LoadProbe.sample(parts.length > 1 ? parts[1] : "");
                case "proc_scan": return LoadProbe.scan(parts.length > 1 ? parts[1] : "");
                case "find_task": {
                    String pkg = sanitizePkg(parts.length > 1 ? parts[1] : null);
                    if (pkg == null) return Json.obj("type", "find_task", "ok", false, "error", "missing_package");
                    Integer display = parts.length > 2 ? Integer.valueOf(parts[2]) : null;
                    return findTaskJson(pkg, display);
                }
                case "task_info": return taskInfoJson(parts.length > 1 ? Integer.parseInt(parts[1]) : -1);
                case "power_get": return powerStateJson();
                case "top_activities": return topActivitiesJson();
                case "dump": return dumpJson(parts);
                case "display_power": {
                    // Missing arg used to throw ArrayIndexOutOfBoundsException instead
                    // of defaulting to "turn screen on" like the original protocol did.
                    boolean on = parts.length > 1 ? !"false".equalsIgnoreCase(parts[1]) : true;
                    boolean ok = setDisplayPower(0, on);
                    return res.put("type", "display_power_result").put("ok", ok).put("on", on);
                }
                case "audio_route": {
                    // audio_route <pkg> <pc|both|phone>; replies audio_result {ok, stream_id?, uid?, error?}
                    String pkg = sanitizePkg(parts.length > 1 ? parts[1] : null);
                    if (pkg == null) return Json.obj("type", "audio_result", "ok", false, "error", "missing_package");
                    AudioRouter.Route route = AudioRouter.Route.parse(parts.length > 2 ? parts[2] : null);
                    if (route == null) return Json.obj("type", "audio_result", "ok", false, "package", pkg, "error", "bad_route");
                    // audio_route <pkg> both <targetMs>: the daemon plays the phone copy itself, each chunk presented targetMs
                    // after its capture (the DeX page presents the PC copy at the same instants — see AudioRouter). Without
                    // a target: the app's own, immediate phone playback.
                    int targetMs = parts.length > 3 ? parseTargetMs(parts[3]) : -1;
                    return AudioRouter.setRoute(pkg, route, targetMs);
                }
                case "audio_target": {
                    // audio_target <pkg> <ms> — retunes a syncing capture's phone copy in place
                    String pkg = sanitizePkg(parts.length > 1 ? parts[1] : null);
                    if (pkg == null) return Json.obj("type", "audio_result", "ok", false, "error", "missing_package");
                    int targetMs = parts.length > 2 ? parseTargetMs(parts[2]) : -1;
                    if (targetMs < 0) return Json.obj("type", "audio_result", "ok", false, "package", pkg, "error", "bad_target");
                    return AudioRouter.setTarget(pkg, targetMs);
                }
                case "audio_probe": {
                    // audio_probe <phoneTargetMs> <count> <spacingMs> <leadMs> — the "İkisi" calibration's test tones on the phone
                    // (AudioRouter.probe); replies audio_result {ok, pts_us[], target_ms, spacing_ms}
                    int targetMs = parts.length > 1 ? parseTargetMs(parts[1]) : -1;
                    if (targetMs < 0) return Json.obj("type", "audio_result", "ok", false, "error", "bad_target");
                    return AudioRouter.probe(targetMs, parseIntOr(parts, 2, 6), parseIntOr(parts, 3, 500), parseIntOr(parts, 4, 700));
                }
                case "audio_stop": {
                    String pkg = sanitizePkg(parts.length > 1 ? parts[1] : null);
                    return pkg == null ? Json.obj("type", "audio_result", "ok", false, "error", "missing_package")
                                       : AudioRouter.stop(pkg);
                }
                case "audio_list": return AudioRouter.list();
                case "tasks_list": return TaskEvents.snapshotJson();
                case "display_get": return PhoneDisplay.snapshot(parts.length > 1 ? Integer.parseInt(parts[1]) : 0);
                case "bt_list": return Bluetooth.list();
                case "bt_connect":
                case "bt_disconnect":
                case "bt_forget":
                    // bt_<verb> <AA:BB:CC:DD:EE:FF>; replies bt_result {ok, error?, status?}
                    return Bluetooth.action(cmd.substring(3), parts.length > 1 ? parts[1].toUpperCase() : null);
                case "wifi_connect_saved": {
                    // wifi_connect_saved <netId> — join a saved network without its passphrase
                    int netId;
                    try {
                        netId = Integer.parseInt(parts.length > 1 ? parts[1] : "");
                    } catch (NumberFormatException e) {
                        return Json.obj("type", "wifi_result", "ok", false, "error", "bad_network_id");
                    }
                    return Wifi.connectSaved(netId);
                }
                case "wifi_disconnect": {
                    // wifi_disconnect [netId] — with the id the network is disabled (stays off until joined again); without
                    // it only the link is dropped and auto-join re-joins. An unparsable id is "no id", never an error.
                    int netId = -1;
                    if (parts.length > 1) {
                        try {
                            netId = Integer.parseInt(parts[1]);
                        } catch (NumberFormatException ignored) {
                            netId = -1;
                        }
                    }
                    return Wifi.disconnect(netId);
                }
                case "task_density_info": {
                    int taskId = parts.length > 1 ? Integer.parseInt(parts[1]) : -1;
                    return taskDensityInfo(taskId);
                }
                case "restart_task_activity": {
                    int taskId = parts.length > 1 ? Integer.parseInt(parts[1]) : -1;
                    boolean ok = restartTaskTopActivity(taskId);
                    return res.put("type", "restart_task_activity_result").put("ok", ok).put("task_id", taskId);
                }
                case "status": return res.put("type", "status_result").put("ok", true)
                        .put("uptime_ms", System.currentTimeMillis() - START_TIME_MS)
                        .put("active_clients", activeClients.size())
                        .put("version", PROTOCOL_VERSION)
                        .put("notification_listener", NotificationEvents.isConnected())
                        .put("thermal_listener", ThermalEvents.isRegistered())
                        .put("last_error", Log.lastError() == null ? JSONObject.NULL : Log.lastError());
                default: return res.put("type", "error").put("message", "unknown_command");
            }
        } catch (Throwable t) {
            return Json.obj("type", "error", "message", t.getMessage());
        }
    }

    // =========================================================================
    // 7. Main Server Loop
    // =========================================================================

    /** What this daemon offers: the base set, plus — only when a token protects the socket — authentication and shell. */
    private static List<String> capabilities() {
        List<String> caps = new ArrayList<>(CAPABILITIES);
        if (AUTH_TOKEN != null) {
            caps.add("auth");
            caps.add("shell");
            caps.add("fs");
        }
        return caps;
    }

    /**
     * The mutual challenge–response (DaemonAuth.serve, tested on a plain JVM) on this socket.
     *
     * @return the proof of this daemon's own key for the greeting, or null when the client did not pass
     */
    private static String authenticate(final LocalSocket client, BufferedReader in, PrintWriter out) {
        String proof = DaemonAuth.serve(AUTH_TOKEN, in, out, new DaemonAuth.Deadline() {
            @Override
            public void set(int millis) throws IOException {
                client.setSoTimeout(millis);
            }
        }, new DaemonAuth.Frames() {
            @Override
            public String challenge(String serverNonce) {
                return Json.obj("type", "auth_required", "nonce", serverNonce).toString();
            }

            @Override
            public String failure() {
                return Json.obj("type", "auth_failed").toString();
            }
        }, AUTH_TIMEOUT_MS, 300);
        if (proof == null) Log.warn("Daemon", "A client did not pass authentication; connection dropped");
        return proof;
    }

    public static void main(String[] args) {
        String socketName = (args.length > 0 && !args[0].trim().isEmpty()) ? args[0].trim() : DEFAULT_SOCKET_NAME;
        buildId = jarMd5();
        Log.info("Daemon", "v" + PROTOCOL_VERSION + " (build " + buildId + ") starting on localabstract:" + socketName
                + (AUTH_TOKEN == null ? " (no token: socket unauthenticated, shell disabled)" : " (token set: clients authenticate, shell enabled)"));

        // The runtime's default handler kills the WHOLE process on any thread's uncaught exception — one bad client
        // thread would take every capture, listener and client with it. Only the main (accept) thread is fatal.
        Thread.setDefaultUncaughtExceptionHandler((thread, e) -> {
            Log.error("Daemon", "Thread '" + thread.getName() + "' died: " + e);
            if ("main".equals(thread.getName())) {
                restoreScreenIfOurs("fatal");
                System.exit(1);
            }
        });
        restoreScreenLeftBlankedByPreviousRun();

        Battery.init();
        initRealtimeMediaListeners();
        AudioStreamServer.startAcceptLoop();
        TaskEvents.start(scheduler);
        DisplayEvents.start();
        ThermalEvents.start(scheduler);
        NotificationEvents.start(scheduler);

        scheduler.scheduleAtFixedRate(new Runnable() {
            String lastMediaKey = "", lastVols = "", lastBat = "", lastStates = "";
            int tick = 0;

            @Override
            public void run() {
                try {
                    if (activeClients.isEmpty()) {
                        if (lastClientDisconnectedTime > 0 && (System.currentTimeMillis() - lastClientDisconnectedTime > IDLE_TIMEOUT_MS)) {
                            Log.info("Daemon", "Idle timeout. Clean exit.");
                            restoreScreenIfOurs("idle exit");
                            System.exit(0);
                        }
                        return;
                    }

                    // Diff key excludes "position" (ticks every second while playing);
                    // includes "state" so PAUSED<->STOPPED<->BUFFERING transitions are
                    // never silently swallowed by the is_playing boolean alone.
                    JSONObject mediaObj = getMediaJson(null, false);
                    String mediaKey = mediaDiffKey(mediaObj);
                    if (!mediaKey.equals(lastMediaKey)) { lastMediaKey = mediaKey; broadcast(mediaObj.toString()); }

                    tick++;
                    // Push mode (TaskStackListener): focus and tasks arrive as events; this poll is only a slow
                    // safety net (every 5th tick ≈ 6 s). Without the listener it stays primary, as before.
                    if (!TaskEvents.isRegistered() || tick % 5 == 0) broadcastFocusIfChanged();
                    TaskEvents.pollIfUnregistered();

                    String vols = getVolumesJson().toString();
                    if (!vols.equals(lastVols)) { lastVols = vols; broadcast(vols); }

                    if (tick % 4 == 0) {
                        String bat = Battery.updateJson().toString();
                        if (!bat.equals(lastBat)) { lastBat = bat; broadcast(bat); }

                        String states = getHardwareStatesJson().toString();
                        if (!states.equals(lastStates)) { lastStates = states; broadcast(states); }
                    }
                } catch (Throwable ignored) {}
            }
        }, 1200, 1200, TimeUnit.MILLISECONDS);

        Runtime.getRuntime().addShutdownHook(new Thread(() -> {
            Log.info("Daemon", "Shutdown hook triggered, closing sockets...");
            // First, while everything still works: a blanked panel must not outlive us, and policies left registered
            // would keep "pc"-routed apps silent on the phone.
            restoreScreenIfOurs("shutdown");
            AudioRouter.stopAll();
            TaskEvents.stop();
            NotificationEvents.stop();
            for (ClientConnection c : activeClients) c.close();
            scheduler.shutdownNow();
            if (mediaListenerThread != null) {
                try { mediaListenerThread.quitSafely(); } catch (Throwable ignored) {}
            }
        }));

        try (LocalServerSocket server = new LocalServerSocket(socketName)) {
            while (true) {
                LocalSocket client = server.accept();
                Credentials creds = client.getPeerCredentials();
                if (creds.getUid() != TRUSTED_ROOT && creds.getUid() != TRUSTED_SHELL) {
                    Log.warn("Daemon", "Rejected untrusted UID: " + creds.getUid());
                    client.close();
                    continue;
                }

                new Thread(() -> {
                    ClientConnection conn = null;
                    try {
                        BufferedReader in = new BufferedReader(new InputStreamReader(client.getInputStream(), StandardCharsets.UTF_8));
                        PrintWriter out = new PrintWriter(new OutputStreamWriter(client.getOutputStream(), StandardCharsets.UTF_8), false);
                        // Before ANYTHING else — before the client counts as a control client, before it is greeted or
                        // read: with a token configured, only a client that answers the challenge gets in.
                        String authProof = null;
                        if (AUTH_TOKEN != null) {
                            authProof = authenticate(client, in, out);
                            if (authProof == null) return;
                        }
                        conn = new ClientConnection(client, out);
                        activeClients.add(conn);
                        lastClientDisconnectedTime = 0;
                        cancelScreenRestore();

                        JSONObject greeting = new JSONObject().put("type", "greeting")
                                .put("version", PROTOCOL_VERSION)
                                .put("build", buildId == null ? JSONObject.NULL : buildId)
                                .put("status", "ready")
                                .put("capabilities", new JSONArray(capabilities()))
                                // Push sources that are live in THIS process (a refused listener = the backend polls).
                                .put("notification_listener", NotificationEvents.isConnected())
                                .put("thermal_listener", ThermalEvents.isRegistered())
                                // Our panel truth: PowerManager cannot see a raw blank, so the backend asks US.
                                .put("screen_blanked", isScreenBlankedByUs());
                        // Our half of the mutual handshake: only a holder of the key can write this.
                        if (authProof != null) Json.put(greeting, "auth_proof", authProof);
                        conn.enqueueResponse(greeting.toString());

                        conn.enqueue(getMediaJson(null, true).toString());
                        conn.enqueue(getFocusedWindowJson().toString());
                        conn.enqueue(TaskEvents.snapshotJson().toString());   // baseline for app presence
                        conn.enqueue(getVolumesJson().toString());
                        conn.enqueue(getHardwareStatesJson().toString());
                        conn.enqueue(Battery.updateJson().toString());
                        final ClientConnection greeted = conn;
                        rpcPool.execute(() -> {
                            greeted.enqueue(ThermalEvents.snapshotJson().toString());
                            greeted.enqueue(NotificationEvents.snapshotJson().toString()); // baseline notification list
                        });

                        String line;
                        while ((line = in.readLine()) != null) {
                            line = line.trim();
                            if (line.isEmpty()) continue;
                            String reqId = null;
                            Matcher m = ID_PREFIX_PATTERN.matcher(line);
                            if (m.find()) { reqId = m.group(1); line = line.substring(m.end()); }

                            if ("quit".equalsIgnoreCase(line) || "exit".equalsIgnoreCase(line)) {
                                Log.info("Daemon", "Received quit/exit. Terminating process.");
                                System.exit(0);
                            }

                            if (line.regionMatches(true, 0, "shell ", 0, 6) && AUTH_TOKEN != null) {
                                final ClientConnection replyTo = conn;
                                final String id = reqId;
                                SHELL.handle(line, response -> {
                                    if (id != null) Json.put(response, "req_id", id);
                                    replyTo.enqueueResponse(response.toString());
                                });
                                continue; // the reply comes from a shell thread; the next command is not held up
                            }

                            if (AUTH_TOKEN != null && FsWire.isFsCommand(line.split("\\s+", 2)[0])) {
                                final ClientConnection replyTo = conn;
                                final String id = reqId;
                                FS.handle(line, response -> {
                                    if (id != null) Json.put(response, "req_id", id);
                                    replyTo.enqueueResponse(response.toString());
                                });
                                continue; // answered from an fs thread; the next command is not held up
                            }

                            final String[] parts = line.split("\\s+");
                            final String command = line;
                            final String id = reqId;
                            final ClientConnection caller = conn;
                            Runnable reply = () -> {
                                JSONObject resp = handleCommand(command, parts);
                                if (id != null) Json.put(resp, "req_id", id);
                                caller.enqueueResponse(resp.toString());
                            };
                            if (POOLED_COMMANDS.contains(parts[0].toLowerCase())) rpcPool.execute(reply);
                            else reply.run();
                        }
                    } catch (Throwable ignored) {
                    } finally {
                        if (conn != null) conn.close();
                        else try { client.close(); } catch (Throwable ignoredToo) {} // never authenticated: no connection object
                        Log.info("Daemon", "Client disconnected.");
                    }
                }, "OpenDex-ClientThread").start();
            }
        } catch (Throwable t) {
            Log.error("Daemon", "Fatal: " + t.getMessage());
        }
    }
}
