package com.opendex.tools;

import android.content.Context;
import android.graphics.Bitmap;
import android.media.MediaScannerConnection;
import android.media.ThumbnailUtils;
import android.util.Size;

import java.io.ByteArrayOutputStream;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Base64;
import java.util.List;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;

import org.json.JSONArray;
import org.json.JSONObject;

/**
 * The daemon's {@code fs_*} commands (see {@link FsWire} for the wire format): the file manager's control plane. Bytes of
 * a transfer do NOT travel here — the backend streams them over adb's sync protocol; this class lists, stats, creates,
 * renames, deletes, makes thumbnails and asks the media scanner to index what the backend pushed.
 *
 * Runs on its own small pool, never on the daemon's shared RPC pool or its client thread: a listing of a 20 000-file
 * folder or the removal of a big tree must not hold up media/notification replies. A saturated pool answers
 * {@code busy} at once and the backend falls back to its slower path.
 *
 * Every reply is {@code {"type":"fs_<cmd>_result","ok":bool,…}}; a failure carries {@code error} (the backend's FsError
 * code) and {@code detail}. Paths and the {@code after} cursor are base64 in both directions.
 */
final class FsService {

    interface Reply {
        void send(JSONObject response);
    }

    private static final int THUMB_MAX_BYTES = 400 * 1024;

    private final FsPolicy policy;
    private final Path storageDir;
    private final Path tmpDir;
    private final ThreadPoolExecutor pool;

    FsService(FsPolicy policy, Path storageDir, Path tmpDir, int threads, int queueCapacity) {
        this.policy = policy;
        this.storageDir = storageDir;
        this.tmpDir = tmpDir;
        this.pool = new ThreadPoolExecutor(threads, threads, 30, TimeUnit.SECONDS, new ArrayBlockingQueue<Runnable>(queueCapacity),
                r -> {
                    Thread t = new Thread(r, "OpenDex-Fs");
                    t.setDaemon(true);
                    return t;
                });
        this.pool.allowCoreThreadTimeOut(true);
    }

    /** Parses and queues the request; {@code reply} is called exactly once. */
    void handle(String line, final Reply reply) {
        final FsWire.Request request = FsWire.parse(line);
        final String type = request.command + "_result";
        if (request.error != null) {
            reply.send(failure(type, request.error, null));
            return;
        }
        try {
            pool.execute(new Runnable() {
                @Override
                public void run() {
                    JSONObject response;
                    try {
                        response = execute(request, type);
                    } catch (FsOps.Failure f) {
                        response = failure(type, f.code, f.detail);
                    } catch (Throwable t) {
                        response = failure(type, "io", Json.reason(t));
                    }
                    reply.send(response);
                }
            });
        } catch (RejectedExecutionException saturated) {
            reply.send(failure(type, "busy", "too many file operations in flight"));
        }
    }

    static JSONObject failure(String type, String code, String detail) {
        return Json.obj("type", type, "ok", false, "error", code, "detail", detail == null ? "" : detail);
    }

    // ---------------------------------------------------------------------------------------------- commands

    private JSONObject execute(FsWire.Request r, String type) throws FsOps.Failure {
        switch (r.command) {
            case "fs_roots": return roots(type);
            case "fs_list": return list(r.args, type);
            case "fs_stat": return stat(r.args[0], type);
            case "fs_stat_many": return statMany(r.args[0], type);
            case "fs_mkdir": {
                String path = need(r.args[0]);
                boolean parents = FsWire.flag(r.args[1], 'p');
                FsOps.mkdir(parents ? policy.forCreateWithParents(path) : policy.forCreate(path), parents);
                return Json.obj("type", type, "ok", true);
            }
            case "fs_rename": {
                String from = need(r.args[0]);
                String to = need(r.args[1]);
                Path source = policy.entry(from);
                if (policy.isProtected(source)) throw new FsOps.Failure("permission", "protected folder");
                FsOps.rename(source, policy.forCreate(to), FsWire.flag(r.args[2], 'o'));
                return Json.obj("type", type, "ok", true);
            }
            case "fs_delete": {
                Path target = policy.entry(need(r.args[0]));
                if (policy.isProtected(target)) throw new FsOps.Failure("permission", "protected folder");
                return Json.obj("type", type, "ok", true, "deleted", FsOps.delete(target));
            }
            case "fs_thumb": return thumb(r.args, type);
            case "fs_scan": return scan(r.args[0], type);
            default: throw new FsOps.Failure("bad_request", "unknown fs command");
        }
    }

    private static String need(String b64) throws FsOps.Failure {
        String text = FsWire.decode(b64);
        if (text == null) throw new FsOps.Failure("bad_request", "argument is not base64 UTF-8 text");
        return text;
    }

    static JSONArray itemJson(FsOps.Item item) {
        JSONArray a = new JSONArray();
        a.put(item.name).put(item.dir ? 1 : 0).put(item.size).put(item.mtimeSec).put(item.flags);
        a.put(item.target == null ? JSONObject.NULL : item.target);
        return a;
    }

    private JSONObject roots(String type) {
        JSONArray roots = new JSONArray();
        for (FsOps.Volume v : FsOps.volumes(storageDir, tmpDir)) {
            roots.put(Json.obj("path", v.path, "kind", v.kind, "total", v.total, "free", v.free));
        }
        return Json.obj("type", type, "ok", true, "roots", roots);
    }

    private JSONObject list(String[] args, String type) throws FsOps.Failure {
        Path dir = policy.existing(need(args[0]));
        String after = "-".equals(args[1]) ? null : need(args[1]);
        FsOps.Page page = FsOps.list(dir, after, FsWire.clampPage(args[2]));
        JSONArray items = new JSONArray();
        for (FsOps.Item item : page.items) items.put(itemJson(item));
        return Json.obj("type", type, "ok", true, "path", page.path, "items", items,
                "next", page.next == null ? JSONObject.NULL : FsWire.encode(page.next));
    }

    private JSONObject stat(String b64, String type) throws FsOps.Failure {
        Path path = policy.entry(need(b64));
        return Json.obj("type", type, "ok", true, "path", path.toString(), "item", itemJson(FsOps.stat(path)));
    }

    private JSONObject statMany(String b64, String type) throws FsOps.Failure {
        List<String> paths = FsWire.decodeBatch(b64);
        if (paths == null) throw new FsOps.Failure("bad_request", "bad batch");
        JSONArray items = new JSONArray();
        for (String raw : paths) {
            try {
                items.put(itemJson(FsOps.stat(policy.entry(raw))));
            } catch (FsOps.Failure f) {
                items.put(JSONObject.NULL);                                  // that one is gone / not allowed; the rest still answer
            }
        }
        return Json.obj("type", type, "ok", true, "items", items);
    }

    private JSONObject scan(String b64, String type) throws FsOps.Failure {
        List<String> raw = FsWire.decodeBatch(b64);
        if (raw == null) throw new FsOps.Failure("bad_request", "bad batch");
        List<String> checked = new ArrayList<>();
        for (String path : raw) checked.add(policy.existing(path).toString());
        Context ctx = SystemContext.get();
        if (ctx == null) throw new FsOps.Failure("unsupported", "no system context: " + SystemContext.lastError());
        MediaScannerConnection.scanFile(ctx, checked.toArray(new String[0]), null, null);
        return Json.obj("type", type, "ok", true, "queued", checked.size());
    }

    private JSONObject thumb(String[] args, String type) throws FsOps.Failure {
        Path path = policy.existing(need(args[0]));
        int px = FsWire.clampThumb(args[1]);
        int kind = FsWire.thumbKind(path.getFileName().toString());
        if (kind == FsWire.THUMB_NONE) throw new FsOps.Failure("unsupported", "no thumbnail for this type");
        Bitmap bitmap = null;
        try {
            Size size = new Size(px, px);
            java.io.File file = path.toFile();
            if (kind == FsWire.THUMB_IMAGE) bitmap = ThumbnailUtils.createImageThumbnail(file, size, null);
            else if (kind == FsWire.THUMB_VIDEO) bitmap = ThumbnailUtils.createVideoThumbnail(file, size, null);
            else bitmap = ThumbnailUtils.createAudioThumbnail(file, size, null);
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            bitmap.compress(Bitmap.CompressFormat.JPEG, 80, out);
            if (out.size() > THUMB_MAX_BYTES) throw new FsOps.Failure("too_large", "thumbnail over " + THUMB_MAX_BYTES + " bytes");
            return Json.obj("type", type, "ok", true, "mime", "image/jpeg", "data", Base64.getEncoder().encodeToString(out.toByteArray()));
        } catch (java.io.IOException e) {
            throw new FsOps.Failure("unsupported", Json.reason(e));            // undecodable (or an audio file without art)
        } finally {
            if (bitmap != null) bitmap.recycle();
        }
    }
}
