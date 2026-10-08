package com.opendex.tools;

import android.graphics.Point;

import java.lang.reflect.Field;
import java.util.Map;

/**
 * Runs PhoneDisplay (the daemon's `display_get`) on a plain JVM against a fake IWindowManager placed in Binders' cache —
 * the reflective calls are the real ones, only the Binder behind them is replaced. Prints one JSON line per scenario;
 * tests/test_phone_display_java.py parses them with the backend's own parser.
 *
 *   java … DisplayHarness <initialDensity> <baseDensity> <w> <h>
 */
public final class DisplayHarness {

    /** The four IWindowManager methods PhoneDisplay calls, with the AIDL signatures (display id, out Point). */
    public static final class FakeWindowManager {
        final int initial, base, w, h;

        FakeWindowManager(int initial, int base, int w, int h) {
            this.initial = initial; this.base = base; this.w = w; this.h = h;
        }

        public int getInitialDisplayDensity(int displayId) { return displayId == 0 ? initial : -1; }
        public int getBaseDisplayDensity(int displayId) { return displayId == 0 ? base : -1; }
        public void getInitialDisplaySize(int displayId, Point size) { size.x = w; size.y = h; }
        public void getBaseDisplaySize(int displayId, Point size) { size.x = w; size.y = h; }
    }

    @SuppressWarnings("unchecked")
    public static void main(String[] args) throws Exception {
        Field cache = Binders.class.getDeclaredField("CACHE");
        cache.setAccessible(true);
        Map<String, Object> map = (Map<String, Object>) cache.get(null);
        String key = "window|android.view.IWindowManager$Stub";

        map.remove(key);
        System.out.println(PhoneDisplay.snapshot(0));          // no window manager reachable (plain JVM)

        map.put(key, new FakeWindowManager(
                Integer.parseInt(args[0]), Integer.parseInt(args[1]), Integer.parseInt(args[2]), Integer.parseInt(args[3])));
        System.out.println(PhoneDisplay.snapshot(0));          // the phone's own panel
        System.out.println(PhoneDisplay.snapshot(7));          // a display that does not exist
        System.out.println(PhoneDisplay.signature(PhoneDisplay.snapshot(0)));
    }
}
