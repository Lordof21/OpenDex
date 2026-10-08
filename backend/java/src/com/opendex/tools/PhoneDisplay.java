package com.opendex.tools;

import android.graphics.Point;

import org.json.JSONObject;

/**
 * A display as its apps see it — density and size straight from the window manager over Binder, instead of the backend
 * parsing `wm density` / `wm size` text (a fork per read, a 1.5 s timeout, and a guessed value when it ran out).
 *
 *   display_get [id]  → {type:"display_update", ok, id, density, physical_density, w, h, physical_w, physical_h}
 *
 * {@code density} is the BASE density: the user's "Display size" / developer "Smallest width" choice when one is set,
 * otherwise the panel's own ({@code physical_density}). It is the value Android lays the phone's apps out with, so a
 * window handed back to the phone has to land on exactly this one. Sizes are the natural-orientation base size (the
 * user's resolution choice included); they do not change with rotation.
 *
 * {@link DisplayEvents} pushes the same object for display 0 whenever its density or size changes (the user changed
 * smallest width while OpenDeX is connected), so the backend never has to ask again just to stay current.
 */
final class PhoneDisplay {

    private PhoneDisplay() {}

    static JSONObject snapshot(int displayId) {
        JSONObject res = Json.obj("type", "display_update", "id", displayId);
        Object wm = Binders.service("window", "android.view.IWindowManager$Stub");
        if (wm == null) return Json.put(Json.put(res, "ok", false), "error", "window_manager_unavailable");
        try {
            Class<?> c = wm.getClass();
            int physical = (Integer) c.getMethod("getInitialDisplayDensity", int.class).invoke(wm, displayId);
            int base = (Integer) c.getMethod("getBaseDisplayDensity", int.class).invoke(wm, displayId);
            if (physical <= 0 || base <= 0) {  // -1: no such display
                return Json.put(Json.put(res, "ok", false), "error", "display_not_found");
            }
            Point physicalSize = new Point();
            Point baseSize = new Point();
            c.getMethod("getInitialDisplaySize", int.class, Point.class).invoke(wm, displayId, physicalSize);
            c.getMethod("getBaseDisplaySize", int.class, Point.class).invoke(wm, displayId, baseSize);
            Json.put(res, "ok", true);
            Json.put(res, "density", base);
            Json.put(res, "physical_density", physical);
            Json.put(res, "w", baseSize.x);
            Json.put(res, "h", baseSize.y);
            Json.put(res, "physical_w", physicalSize.x);
            Json.put(res, "physical_h", physicalSize.y);
            return res;
        } catch (Throwable t) {
            return Json.put(Json.put(res, "ok", false), "error", Json.reason(t));
        }
    }

    /** The fields that make two snapshots different for the phone's apps (density and size). */
    static String signature(JSONObject snapshot) {
        if (snapshot == null || !snapshot.optBoolean("ok")) return "";
        return snapshot.optInt("density") + "@" + snapshot.optInt("w") + "x" + snapshot.optInt("h");
    }
}
