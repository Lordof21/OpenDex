package com.opendex.tools;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.Base64;
import java.util.zip.GZIPOutputStream;

/**
 * The wire format of the daemon's {@code shell} command, with no JSON and no Android types: {@link ShellService} only
 * turns what is decided here into a {@code JSONObject}. Kept apart so a plain JVM can check every rule (the parsing,
 * the clamps, the byte-exactness of the binary mode, the size limits) — see backend/java/test.
 *
 * <pre>
 * request   shell &lt;timeout_ms&gt; &lt;t|b&gt; &lt;base64(UTF-8 command)&gt;
 * </pre>
 *
 * The command travels base64-encoded: it is an arbitrary shell line (quotes, {@code ;}, {@code |}, a Wi-Fi passphrase)
 * on a line-based protocol, and base64 is the one encoding that cannot be mistaken for protocol.
 */
final class ShellWire {

    static final int MIN_TIMEOUT_MS = 100;
    static final int MAX_TIMEOUT_MS = 120_000;
    static final int MAX_COMMAND_BYTES = 64 * 1024;
    static final int MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
    /** Below this a gzip header costs more than it saves. */
    static final int GZIP_MIN_BYTES = 2048;
    /** The backend's reader accepts a line of 4 MiB (BYTES); leave room for the envelope. */
    static final int MAX_RESPONSE_BYTES = 3 * 1024 * 1024;

    private ShellWire() {}

    /** A parsed request, or — when {@link #error} is non-null — the reason it cannot be run. */
    static final class Request {
        final long timeoutMs;
        final boolean binary;
        final String command;
        final String error;
        final String detail;

        private Request(long timeoutMs, boolean binary, String command, String error, String detail) {
            this.timeoutMs = timeoutMs;
            this.binary = binary;
            this.command = command;
            this.error = error;
            this.detail = detail;
        }

        static Request ok(long timeoutMs, boolean binary, String command) {
            return new Request(timeoutMs, binary, command, null, null);
        }

        static Request refused(String error, String detail) {
            return new Request(0, false, null, error, detail);
        }
    }

    /**
     * What the client is told. {@code ok == false}: nothing ran, or the answer cannot be carried — {@link #error} /
     * {@link #detail} say why, and the backend runs the command through adb instead. {@code ok == true}: a verdict
     * about the COMMAND ({@link #exit}, {@link #timedOut}), never retried.
     */
    static final class Reply {
        final boolean ok;
        final String error;
        final String detail;
        final int exit;
        final boolean timedOut;
        final long ms;
        /** {@code plain} (UTF-8 text), {@code b64} (bytes) or {@code gz} (gzip bytes, base64). */
        final String enc;
        final String out;
        final String err;

        private Reply(boolean ok, String error, String detail, int exit, boolean timedOut, long ms, String enc,
                      String out, String err) {
            this.ok = ok;
            this.error = error;
            this.detail = detail;
            this.exit = exit;
            this.timedOut = timedOut;
            this.ms = ms;
            this.enc = enc;
            this.out = out;
            this.err = err;
        }

        static Reply refusal(String error, String detail) {
            return new Reply(false, error, detail, 0, false, 0, null, null, null);
        }

        static Reply done(int exit, boolean timedOut, long ms, String enc, String out, String err) {
            return new Reply(true, null, null, exit, timedOut, ms, enc, out, err);
        }
    }

    static Request parse(String line) {
        String[] parts = line.split("\\s+", 4);
        if (parts.length < 4 || !("t".equals(parts[2]) || "b".equals(parts[2]))) {
            return Request.refused("bad_request", "expected: shell <timeout_ms> <t|b> <base64>");
        }
        try {
            long timeoutMs = Math.max(MIN_TIMEOUT_MS, Math.min(MAX_TIMEOUT_MS, Long.parseLong(parts[1])));
            byte[] raw = Base64.getDecoder().decode(parts[3].trim());
            if (raw.length == 0 || raw.length > MAX_COMMAND_BYTES) {
                return Request.refused("bad_request", "command size " + raw.length);
            }
            return Request.ok(timeoutMs, "b".equals(parts[2]), new String(raw, StandardCharsets.UTF_8));
        } catch (IllegalArgumentException malformed) {
            return Request.refused("bad_request", "timeout or base64 is malformed");
        }
    }

    static Reply encode(ShellRunner.Result r, boolean binary) {
        if (r.startError != null) return Reply.refusal("exec_failed", r.startError);
        if (r.tooLarge) return Reply.refusal("too_large", "output over " + MAX_OUTPUT_BYTES + " bytes");
        String enc;
        String out;
        String gz = r.stdout.length >= GZIP_MIN_BYTES ? gzipBase64(r.stdout) : null;
        if (gz != null && gz.length() < r.stdout.length) {
            enc = "gz";
            out = gz;
        } else if (binary) {
            enc = "b64";
            out = Base64.getEncoder().encodeToString(r.stdout);
        } else {
            enc = "plain";
            out = new String(r.stdout, StandardCharsets.UTF_8);
        }
        String err = new String(r.stderr, StandardCharsets.UTF_8);
        // A cheap first cut: a text of more characters than the limit has more bytes than the limit once encoded and
        // JSON-escaped. ShellService measures the exact envelope, in bytes (escaping and multi-byte characters make
        // it longer than the raw strings).
        if (out.length() + err.length() > MAX_RESPONSE_BYTES) {
            return Reply.refusal("too_large", "reply over " + MAX_RESPONSE_BYTES + " bytes");
        }
        return Reply.done(r.exitCode, r.timedOut, r.elapsedMs, enc, out, err);
    }

    private static String gzipBase64(byte[] data) {
        try {
            ByteArrayOutputStream bytes = new ByteArrayOutputStream(data.length / 4 + 64);
            try (GZIPOutputStream gz = new GZIPOutputStream(bytes)) {
                gz.write(data);
            }
            return Base64.getEncoder().encodeToString(bytes.toByteArray());
        } catch (IOException e) {
            return null; // fall back to the plain / b64 encoding
        }
    }
}
