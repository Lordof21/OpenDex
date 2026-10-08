package com.opendex.tools;

import android.net.LocalSocket;
import android.net.LocalSocketAddress;
import android.util.EventLog;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.InputStream;
import java.io.OutputStream;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;

/**
 * Reads the `events` log buffer from logd directly — the density reconciler's relaunch proof without forking
 * `logcat -b events -d | grep` from the host on every check.
 *
 * logd is asked for entries NEWER than a timestamp ("dumpAndClose lids=2 start=<sec>.<nsec>"), so it seeks instead of
 * replaying the whole ring (~140k lines on a busy phone: 310 ms through {@link EventLog#readEvents}, ~80 ms seeking).
 * Only the requested tags are decoded, into the exact line `logcat -v epoch` prints —
 *   "1790777475.253123 30945 30945 I wm_on_destroy_called: [0,34230256,com.app.Main,performDestroy,24]"
 * — so the backend's parser is the same for both sources. Needs the `log` group (shell has it) like logcat itself.
 */
final class EventLogReader {

    private static final int LOG_ID_EVENTS = 2;
    private static final int MAX_PACKET = 5 * 1024 + 256; // LOGGER_ENTRY_MAX_LEN + header
    private static final int SOCKET_TIMEOUT_MS = 2000;
    private static final int MAX_LINES = 2000;

    private static final int TYPE_INT = 0, TYPE_LONG = 1, TYPE_STRING = 2, TYPE_LIST = 3, TYPE_FLOAT = 4;

    private static final Map<String, Integer> TAG_CODES = new HashMap<>();

    private EventLogReader() {}

    /** event_log reply: {ok, lines:[…], took_ms} or {ok:false, error}. */
    static JSONObject read(String since, String tagList) {
        long started = System.nanoTime();
        JSONObject res = Json.obj("type", "event_log");
        Map<Integer, String> wanted = new HashMap<>();
        for (String name : tagList.split(",")) {
            int code = tagCode(name.trim());
            if (code >= 0) wanted.put(code, name.trim());
        }
        if (wanted.isEmpty()) return Json.put(Json.put(res, "ok", false), "error", "no_known_tags");

        long[] start = parseEpoch(since);
        if (start == null) return Json.put(Json.put(res, "ok", false), "error", "bad_since");

        JSONArray lines = new JSONArray();
        LocalSocket socket = new LocalSocket(LocalSocket.SOCKET_SEQPACKET);
        try {
            socket.connect(new LocalSocketAddress("logdr", LocalSocketAddress.Namespace.RESERVED));
            socket.setSoTimeout(SOCKET_TIMEOUT_MS);
            OutputStream out = socket.getOutputStream();
            out.write(String.format(Locale.ROOT, "dumpAndClose lids=%d start=%d.%09d", LOG_ID_EVENTS, start[0], start[1])
                    .getBytes(StandardCharsets.US_ASCII));
            out.flush();
            InputStream in = socket.getInputStream();
            byte[] packet = new byte[MAX_PACKET];
            int n;
            while ((n = in.read(packet)) > 0 && lines.length() < MAX_LINES) {
                String line = decode(packet, n, wanted);
                if (line != null) lines.put(line);
            }
        } catch (Throwable t) {
            // A timeout after some lines is still an answer (logd closes the socket when the dump is done).
            if (lines.length() == 0) return Json.put(Json.put(res, "ok", false), "error", Json.reason(t));
        } finally {
            try { socket.close(); } catch (Throwable ignored) {}
        }
        Json.put(res, "ok", true);
        Json.put(res, "lines", lines);
        Json.put(res, "took_ms", (System.nanoTime() - started) / 1_000_000);
        return res;
    }

    private static synchronized int tagCode(String name) {
        Integer cached = TAG_CODES.get(name);
        if (cached == null) {
            cached = name.isEmpty() ? -1 : EventLog.getTagCode(name);
            TAG_CODES.put(name, cached);
        }
        return cached;
    }

    /** "<sec>.<fraction>" → {sec, nsec}; null when it does not parse. */
    private static long[] parseEpoch(String since) {
        try {
            String[] parts = since.trim().split("\\.", 2);
            long sec = Long.parseLong(parts[0]);
            long nsec = 0;
            if (parts.length > 1 && !parts[1].isEmpty()) {
                String frac = (parts[1] + "000000000").substring(0, 9);
                nsec = Long.parseLong(frac);
            }
            return sec > 0 ? new long[]{sec, nsec} : null;
        } catch (Throwable t) {
            return null;
        }
    }

    /**
     * One logger_entry (little endian): u16 len, u16 hdr_size, i32 pid, u32 tid, u32 sec, u32 nsec, u32 lid, u32 uid,
     * then `len` payload bytes = i32 tag + one typed value. Null when the tag is not wanted or the entry is malformed.
     */
    private static String decode(byte[] packet, int length, Map<Integer, String> wanted) {
        if (length < 24) return null;
        ByteBuffer b = ByteBuffer.wrap(packet, 0, length).order(ByteOrder.LITTLE_ENDIAN);
        int payloadLen = b.getShort(0) & 0xffff;
        int hdrSize = b.getShort(2) & 0xffff;
        if (hdrSize < 20 || hdrSize + payloadLen > length || payloadLen < 4) return null;
        int pid = b.getInt(4);
        int tid = b.getInt(8);
        long sec = b.getInt(12) & 0xffffffffL;
        long nsec = b.getInt(16) & 0xffffffffL;
        b.position(hdrSize);
        String name = wanted.get(b.getInt());
        if (name == null) return null;
        StringBuilder value = new StringBuilder();
        try {
            appendValue(b, hdrSize + payloadLen, value);
        } catch (Throwable t) {
            return null;
        }
        return String.format(Locale.ROOT, "%d.%06d %5d %5d I %s: %s", sec, nsec / 1000, pid, tid, name, value);
    }

    /** logcat's rendering of a binary event value: ints/longs decimal, strings raw, lists "[a,b,…]". */
    private static void appendValue(ByteBuffer b, int end, StringBuilder out) {
        if (b.position() >= end) return;
        int type = b.get() & 0xff;
        switch (type) {
            case TYPE_INT: out.append(b.getInt()); break;
            case TYPE_LONG: out.append(b.getLong()); break;
            case TYPE_FLOAT: out.append(b.getFloat()); break;
            case TYPE_STRING: {
                int len = b.getInt();
                if (len < 0 || b.position() + len > end) throw new IllegalStateException("bad string");
                out.append(new String(b.array(), b.arrayOffset() + b.position(), len, StandardCharsets.UTF_8));
                b.position(b.position() + len);
                break;
            }
            case TYPE_LIST: {
                int count = b.get() & 0xff;
                out.append('[');
                for (int i = 0; i < count; i++) {
                    if (i > 0) out.append(',');
                    appendValue(b, end, out);
                }
                out.append(']');
                break;
            }
            default: throw new IllegalStateException("unknown event type " + type);
        }
    }
}
