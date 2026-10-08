package com.opendex.tools;

import java.nio.charset.StandardCharsets;
import org.json.JSONObject;

/**
 * The daemon's {@code shell} command: the backend's {@code adb shell} replacement.
 *
 * <pre>
 * request   shell &lt;timeout_ms&gt; &lt;t|b&gt; &lt;base64(UTF-8 command)&gt;
 * reply     {"type":"shell_result","ok":true,"exit":0,"timed_out":false,"ms":12,
 *            "enc":"plain"|"b64"|"gz","out":"…","err":"…"}
 *           {"type":"shell_result","ok":false,"error":"busy|bad_request|too_large|exec_failed","detail":"…"}
 * </pre>
 *
 * The rules (parsing, limits, encodings) live in the JSON-free {@link ShellWire}; running the command is
 * {@link ShellRunner}'s job. This class is only the seam between them and the daemon's JSON replies. A refusal
 * ({@code ok:false}) means "nothing ran or the answer cannot be carried": the backend then runs the command through adb
 * instead.
 *
 * <p>Never logs a command (it may hold a secret) — only its length.
 */
final class ShellService {

    interface Reply {
        void send(JSONObject response);
    }

    private final ShellRunner runner;

    ShellService(int maxConcurrent, int queueCapacity) {
        this.runner = new ShellRunner(maxConcurrent, queueCapacity);
    }

    /** Parses and queues the request; {@code reply} is called exactly once — at once on a refusal, else when it ends. */
    void handle(String line, final Reply reply) {
        final ShellWire.Request request = ShellWire.parse(line);
        if (request.error != null) {
            reply.send(toJson(ShellWire.Reply.refusal(request.error, request.detail)));
            return;
        }
        boolean accepted = runner.submit(request.command, request.timeoutMs, ShellWire.MAX_OUTPUT_BYTES,
                new ShellRunner.Callback() {
                    @Override
                    public void done(ShellRunner.Result result) {
                        JSONObject json = toJson(ShellWire.encode(result, request.binary));
                        // The backend's reader takes a line of 4 MiB — bytes on the wire. JSON escaping and multi-byte
                        // characters make the envelope longer than the raw text, so the exact size is measured here.
                        if (json.toString().getBytes(StandardCharsets.UTF_8).length > ShellWire.MAX_RESPONSE_BYTES) {
                            json = toJson(ShellWire.Reply.refusal("too_large",
                                    "reply over " + ShellWire.MAX_RESPONSE_BYTES + " bytes"));
                        }
                        reply.send(json);
                    }
                });
        if (!accepted) reply.send(toJson(ShellWire.Reply.refusal("busy", "too many commands in flight")));
    }

    static JSONObject toJson(ShellWire.Reply r) {
        if (!r.ok) return Json.obj("type", "shell_result", "ok", false, "error", r.error, "detail", r.detail);
        JSONObject res = Json.obj("type", "shell_result", "ok", true, "exit", r.exit, "timed_out", r.timedOut,
                "ms", r.ms, "enc", r.enc);
        Json.put(res, "out", r.out);
        Json.put(res, "err", r.err);
        return res;
    }
}
