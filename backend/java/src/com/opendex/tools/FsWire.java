package com.opendex.tools;

import java.nio.charset.CharacterCodingException;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.nio.ByteBuffer;
import java.util.ArrayList;
import java.util.Base64;
import java.util.List;

/**
 * The wire format of the daemon's {@code fs_*} commands, with no JSON and no Android types: {@link FsService} only turns
 * what is decided here into a {@code JSONObject}. Kept apart so a plain JVM can check every rule — see backend/java/test.
 *
 * <pre>
 * fs_roots
 * fs_list       &lt;b64 path&gt; &lt;b64 after-name | -&gt; &lt;limit&gt;
 * fs_stat       &lt;b64 path&gt;
 * fs_stat_many  &lt;b64 (paths joined by \n)&gt;
 * fs_mkdir      &lt;b64 path&gt; &lt;p | -&gt;                  p = also create missing parents
 * fs_rename     &lt;b64 from&gt; &lt;b64 to&gt; &lt;o | -&gt;        o = replace an existing target
 * fs_delete     &lt;b64 path&gt;                            recursive, never follows a link
 * fs_thumb      &lt;b64 path&gt; &lt;max edge px&gt;
 * fs_scan       &lt;b64 (paths joined by \n)&gt;            ask the media scanner to index them
 * </pre>
 *
 * Every path and name travels base64-encoded: a path is arbitrary text (spaces, quotes, a newline) on a line-based
 * protocol, and base64 is the one encoding that cannot be mistaken for protocol.
 */
final class FsWire {

    static final int DEFAULT_PAGE = 500;
    static final int MAX_PAGE = 2000;
    static final int MAX_PATH_BYTES = 4096;
    static final int MAX_BATCH = 500;
    static final int MIN_THUMB_PX = 32;
    static final int MAX_THUMB_PX = 1024;

    private FsWire() {}

    /** A parsed request, or — when {@link #error} is non-null — the reason it cannot be run. */
    static final class Request {
        final String command;
        final String[] args;
        final String error;

        private Request(String command, String[] args, String error) {
            this.command = command;
            this.args = args;
            this.error = error;
        }
    }

    static boolean isFsCommand(String commandWord) {
        return commandWord != null && commandWord.toLowerCase().startsWith("fs_");
    }

    /** Splits a request line and checks the argument count of the command; nothing is decoded yet. */
    static Request parse(String line) {
        String[] parts = line.trim().split("\\s+");
        String command = parts[0].toLowerCase();
        int want;
        switch (command) {
            case "fs_roots": want = 0; break;
            case "fs_stat": case "fs_stat_many": case "fs_delete": case "fs_scan": want = 1; break;
            case "fs_thumb": case "fs_mkdir": want = 2; break;
            case "fs_rename": case "fs_list": want = 3; break;
            default: return new Request(command, new String[0], "unknown_command");
        }
        if (parts.length - 1 != want) return new Request(command, new String[0], "bad_request");
        String[] args = new String[want];
        System.arraycopy(parts, 1, args, 0, want);
        return new Request(command, args, null);
    }

    static String encode(String text) {
        return Base64.getEncoder().encodeToString(text.getBytes(StandardCharsets.UTF_8));
    }

    /** Strict decode: valid base64, valid UTF-8, no NUL, at most {@link #MAX_PATH_BYTES} bytes per path — else null. */
    static String decode(String b64) {
        if (b64 == null || b64.isEmpty() || b64.length() > MAX_PATH_BYTES * 2) return null;
        byte[] raw;
        try {
            raw = Base64.getDecoder().decode(b64);
        } catch (IllegalArgumentException e) {
            return null;
        }
        if (raw.length > MAX_BATCH * (MAX_PATH_BYTES + 1)) return null;
        try {
            String text = StandardCharsets.UTF_8.newDecoder()
                    .onMalformedInput(CodingErrorAction.REPORT)
                    .onUnmappableCharacter(CodingErrorAction.REPORT)
                    .decode(ByteBuffer.wrap(raw)).toString();
            return text.indexOf('\0') >= 0 ? null : text;
        } catch (CharacterCodingException e) {
            return null;
        }
    }

    /** A list of paths (batch commands): base64 of the paths joined by '\n'. Null when malformed or over the limits. */
    static List<String> decodeBatch(String b64) {
        String text = decode(b64);
        if (text == null) return null;
        List<String> out = new ArrayList<>();
        for (String path : text.split("\n", -1)) {
            if (path.isEmpty() || path.getBytes(StandardCharsets.UTF_8).length > MAX_PATH_BYTES) return null;
            out.add(path);
            if (out.size() > MAX_BATCH) return null;
        }
        return out;
    }

    static int clampPage(String raw) {
        try {
            int n = Integer.parseInt(raw);
            return Math.max(1, Math.min(n, MAX_PAGE));
        } catch (NumberFormatException e) {
            return DEFAULT_PAGE;
        }
    }

    static int clampThumb(String raw) {
        try {
            return Math.max(MIN_THUMB_PX, Math.min(Integer.parseInt(raw), MAX_THUMB_PX));
        } catch (NumberFormatException e) {
            return 256;
        }
    }

    /** What a thumbnail can be made of: by extension (the content is never sniffed here). */
    static final int THUMB_NONE = 0, THUMB_IMAGE = 1, THUMB_VIDEO = 2, THUMB_AUDIO = 3;

    static int thumbKind(String fileName) {
        int dot = fileName.lastIndexOf('.');
        if (dot < 0 || dot == fileName.length() - 1) return THUMB_NONE;
        switch (fileName.substring(dot + 1).toLowerCase()) {
            case "jpg": case "jpeg": case "png": case "webp": case "gif": case "bmp": case "heic": case "heif": case "avif": case "dng":
                return THUMB_IMAGE;
            case "mp4": case "mkv": case "webm": case "3gp": case "mov": case "avi": case "m4v": case "ts":
                return THUMB_VIDEO;
            case "mp3": case "m4a": case "flac": case "ogg": case "opus": case "wav": case "aac":
                return THUMB_AUDIO;
            default:
                return THUMB_NONE;
        }
    }

    /** A flag argument: the letter when present, "-" (or anything else) means off. */
    static boolean flag(String raw, char letter) {
        return raw != null && raw.length() == 1 && raw.charAt(0) == letter;
    }
}
