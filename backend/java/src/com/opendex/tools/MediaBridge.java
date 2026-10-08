package com.opendex.tools;

/**
 * One-shot media CLI — the fallback tier used by media_control.py while the daemon socket is down
 * (daemon socket -> THIS -> global key event). It carries no media logic of its own: session selection, controller
 * calls and the status snapshot are the daemon's ({@link OpenDexDaemon#invokeMediaSession},
 * {@link OpenDexDaemon#getMediaJson}), so the CLI and the daemon can never drift apart again.
 *
 * Usage (app_process):
 *   get [pkg]            -> media_update JSON (same shape the daemon pushes)
 *   seek <ms> [pkg]      -> {"ok", "action":"seek", "position", "package"}
 *   <action> [pkg]       -> {"ok", "action", "package"}   action: play | pause | toggle | play_pause | next | prev | stop
 * On failure "ok" is false and "error" says why ("session_gone": the named app has no media session). The caller
 * decides about its own key-event tier (so no key is pressed here); it never uses it for a named package.
 */
public class MediaBridge {

    public static void main(String[] args) {
        String cmd = args.length > 0 ? args[0].toLowerCase() : "get";
        try {
            if ("get".equals(cmd)) {
                System.out.println(OpenDexDaemon.getMediaJson(packageArg(args, 1), true));
            } else if ("seek".equals(cmd)) {
                long positionMs = args.length > 1 ? Math.round(Double.parseDouble(args[1])) : 0;
                String pkg = packageArg(args, 2);
                boolean ok = OpenDexDaemon.invokeMediaSession("seek", pkg, positionMs);
                System.out.println(result(ok, "seek", pkg).put("position", positionMs));
            } else {
                String pkg = packageArg(args, 1);
                boolean ok = OpenDexDaemon.invokeMediaSession(cmd, pkg, 0);
                System.out.println(result(ok, cmd, pkg));
            }
        } catch (Throwable t) {
            System.out.println(Json.obj("ok", false, "action", cmd, "error", String.valueOf(t.getMessage())));
        }
    }

    private static org.json.JSONObject result(boolean ok, String action, String pkg) {
        return ok
                ? Json.obj("ok", true, "action", action, "package", pkg)
                : Json.obj("ok", false, "action", action, "package", pkg,
                        // A named app without a session is reported as such: the caller must not "fix" it with a
                        // global media key, which would act on whichever OTHER app holds media focus.
                        "error", pkg != null && !OpenDexDaemon.hasMediaSession(pkg) ? "session_gone" : "no_active_media_session");
    }

    /** args[i] as a package name (same sanitising as the daemon's own command parser). */
    private static String packageArg(String[] args, int i) {
        return OpenDexDaemon.sanitizePkg(args.length > i ? args[i] : null);
    }
}
