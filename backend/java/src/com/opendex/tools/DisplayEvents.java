package com.opendex.tools;

import android.content.Context;
import android.graphics.Point;
import android.hardware.display.DisplayManager;
import android.os.Handler;
import android.os.HandlerThread;
import android.view.Display;

import org.json.JSONObject;

/**
 * Pushes display_added / display_removed — a structured second source for a window's virtual
 * display id next to scrcpy's "New display … (id=N)" log line. Public DisplayManager API; the listener needs a Looper,
 * so it gets its own HandlerThread (the daemon's main thread runs the accept loop, not a Looper).
 */
final class DisplayEvents implements DisplayManager.DisplayListener {

    private static DisplayManager displayManager;
    private static HandlerThread thread;

    private DisplayEvents() {}

    static synchronized void start() {
        if (displayManager != null) return;
        try {
            Context ctx = SystemContext.get();
            if (ctx == null) throw new IllegalStateException("no system context: " + SystemContext.lastError());
            DisplayManager dm = (DisplayManager) ctx.getSystemService(Context.DISPLAY_SERVICE);
            if (dm == null) throw new IllegalStateException("DisplayManager unavailable");
            thread = new HandlerThread("OpenDex-Displays");
            thread.setDaemon(true);
            thread.start();
            dm.registerDisplayListener(new DisplayEvents(), new Handler(thread.getLooper()));
            displayManager = dm;
            Log.info("DisplayEvents", "DisplayListener registered");
        } catch (Throwable t) {
            Log.warn("DisplayEvents", "DisplayListener unavailable: " + t);
            if (thread != null) thread.quitSafely();
            thread = null;
        }
    }

    @Override
    public void onDisplayAdded(int displayId) {
        JSONObject ev = Json.obj("type", "display_added", "id", displayId);
        try {
            Display d = displayManager.getDisplay(displayId);
            if (d != null) {
                Point size = new Point();
                d.getRealSize(size);
                Json.put(ev, "name", d.getName());
                Json.put(ev, "w", size.x);
                Json.put(ev, "h", size.y);
            }
        } catch (Throwable ignored) {}
        OpenDexDaemon.broadcastEvent(ev);
    }

    @Override
    public void onDisplayRemoved(int displayId) {
        OpenDexDaemon.broadcastEvent(Json.obj("type", "display_removed", "id", displayId));
    }

    /** Last display-0 state pushed; a change event that does not change density or size is not forwarded. */
    private static String lastPhoneSignature = "";

    /**
     * Display 0 changed. Android calls this for many reasons (state, brightness mode, refresh rate, rotation); only a
     * change of what the phone's apps are laid out with — density or base size, i.e. the user changed "Display size" or
     * "Smallest width" — is pushed, as a {@code display_update} (the same object {@code display_get} answers with).
     */
    @Override
    public void onDisplayChanged(int displayId) {
        if (displayId != 0) return;
        JSONObject snapshot = PhoneDisplay.snapshot(0);
        String signature = PhoneDisplay.signature(snapshot);
        synchronized (DisplayEvents.class) {
            if (signature.isEmpty() || signature.equals(lastPhoneSignature)) return;
            lastPhoneSignature = signature;
        }
        OpenDexDaemon.broadcastEvent(snapshot);
    }
}
