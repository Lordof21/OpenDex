package com.opendex.tools;

import org.json.JSONObject;

/**
 * Exception-free org.json helpers. The CLI tools used to concatenate JSON by hand with a partial escaper (a quote or a
 * control character in a label / notification key produced invalid JSON); org.json escapes correctly.
 */
final class Json {

    private Json() {}

    /** put() that never throws (org.json only rejects NaN/infinite numbers). A null value removes the key. */
    static JSONObject put(JSONObject obj, String key, Object value) {
        try {
            obj.put(key, value);
        } catch (Throwable ignored) {}
        return obj;
    }

    /** Builds an object from alternating key/value pairs: {@code Json.obj("ok", true, "action", "clear")}. */
    static JSONObject obj(Object... keyValues) {
        JSONObject obj = new JSONObject();
        for (int i = 0; i + 1 < keyValues.length; i += 2) {
            put(obj, String.valueOf(keyValues[i]), keyValues[i + 1]);
        }
        return obj;
    }

    /** {type, ok:false, error} — the failure shape of every "*_update" snapshot. */
    static JSONObject error(String type, Throwable t) {
        return obj("type", type, "ok", false, "error", reason(t));
    }

    /**
     * Never-null failure text. getMessage() is null for many exceptions, and a null value REMOVES the key (see put) —
     * the failure would then read as a valid empty answer (e.g. "no media sessions") instead of an error.
     */
    static String reason(Throwable t) {
        String msg = t == null ? null : t.getMessage();
        return msg != null && !msg.isEmpty() ? msg : (t == null ? "unknown_error" : t.getClass().getSimpleName());
    }
}
