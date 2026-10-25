package com.opendex.tools;

import org.json.JSONObject;

import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Method;

/**
 * The phone's "multi audio focus" (several apps may play at once instead of Android pausing the previous one).
 *
 * Measured on a HyperOS 3.0 / Android 16 phone (2026-10-25): {@code settings global multi_audio_focus_enabled} can read 1
 * while the audio service says {@code Multi Audio Focus enabled :false}, and flipping that setting changes nothing — the
 * service does not read it. What does work, for the shell user, is the service's own
 * {@code IAudioService.setMultiAudioFocusEnabled(boolean)} (the shell holds MODIFY_AUDIO_ROUTING; AudioRouter relies on
 * the same permission). There is no getter, so the live state is read from the service's dump ({@link MultiFocusFacts}).
 *
 * The flag is runtime state of the audio service: it is not written to disk by this class.
 */
final class MultiAudioFocus {

    static final String TYPE = "audio_multi_focus_result";

    private MultiAudioFocus() {}

    /** {type, ok, enabled?, error?}: the live state, or why it could not be read. */
    static JSONObject get() {
        try {
            String dump = BinderDump.dump("audio", new String[0], 4000);
            Boolean enabled = MultiFocusFacts.parseEnabled(dump);
            if (enabled == null) return Json.obj("type", TYPE, "ok", false, "error", "flag_not_found");
            return Json.obj("type", TYPE, "ok", true, "enabled", enabled.booleanValue());
        } catch (Throwable t) {
            return Json.obj("type", TYPE, "ok", false, "error", Json.reason(t));
        }
    }

    /**
     * Sets the flag and reads it back: {type, ok, requested, enabled?, applied, error?}. {@code applied} is whether the
     * read-back equals the request — a call that returned without error but changed nothing is NOT a success.
     */
    static JSONObject set(boolean enabled) {
        try {
            Object service = Binders.service("audio", "android.media.IAudioService$Stub");
            if (service == null) return Json.obj("type", TYPE, "ok", false, "requested", enabled, "error", "audio_service_missing");
            Method setter = null;
            for (Method m : service.getClass().getMethods()) {
                if (m.getName().equals("setMultiAudioFocusEnabled") && m.getParameterTypes().length == 1) {
                    setter = m;
                    break;
                }
            }
            if (setter == null) return Json.obj("type", TYPE, "ok", false, "requested", enabled, "error", "method_missing");
            try {
                setter.invoke(service, enabled);
            } catch (InvocationTargetException e) {
                Throwable cause = e.getCause() != null ? e.getCause() : e;
                String why = cause instanceof SecurityException ? "permission_denied" : Json.reason(cause);
                return Json.obj("type", TYPE, "ok", false, "requested", enabled, "error", why);
            }
            JSONObject now = get();
            boolean readOk = now.optBoolean("ok", false);
            boolean live = now.optBoolean("enabled", false);
            JSONObject res = Json.obj("type", TYPE, "ok", readOk, "requested", enabled, "applied", readOk && live == enabled);
            if (readOk) Json.put(res, "enabled", live);
            else Json.put(res, "error", now.optString("error", "read_back_failed"));
            return res;
        } catch (Throwable t) {
            return Json.obj("type", TYPE, "ok", false, "requested", enabled, "error", Json.reason(t));
        }
    }
}
