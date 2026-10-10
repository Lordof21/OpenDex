package com.opendex.tools;

import android.app.ActivityOptions;
import android.app.Notification;
import android.app.PendingIntent;
import android.service.notification.StatusBarNotification;

import org.json.JSONObject;

import java.lang.reflect.Method;
import java.nio.charset.StandardCharsets;
import java.util.Base64;

/**
 * Notification click / action / clear through IStatusBarService + INotificationManager, and `launch` (the notification's own
 * PendingIntent sent onto a chosen display; daemon only — it needs the live listener). Runs as a one-shot CLI
 * (`app_process … NotificationInvoker <args>`, prints one JSON line) or inside the daemon (`notif_invoke <args>` —
 * the same {@link #run} without starting a JVM per click).
 */
public class NotificationInvoker {
    public static void main(String[] args) {
        System.out.println(run(args));
    }

    static JSONObject run(String[] args) {
        if (args.length == 0) {
            return Json.obj("ok", false, "error", "missing_key_arg");
        }

        if ("launch".equals(args[0])) {
            // launch <base64 key> <display id>
            String launchKey = decodeKey(args.length > 1 ? args[1] : "");
            int displayId = 0;
            if (args.length > 2) {
                try { displayId = Integer.parseInt(args[2]); } catch (Throwable ignored) {}
            }
            return launchToDisplay(launchKey, displayId);
        }

        boolean isClear = "clear".equals(args[0]);
        boolean isClearAll = "clear_all".equals(args[0]);

        String raw = isClear ? (args.length > 1 ? args[1] : "") : args[0];
        String key = raw;
        try {
            // Check if base64 encoded
            byte[] decoded = Base64.getDecoder().decode(raw);
            String candidate = new String(decoded, StandardCharsets.UTF_8);
            if (candidate.contains("|") || candidate.contains(".")) {
                key = candidate;
            }
        } catch (Throwable ignored) {
            key = raw;
        }

        try {
            Object sb = Binders.service("statusbar", "com.android.internal.statusbar.IStatusBarService$Stub");
            if (sb == null) {
                return Json.obj("ok", false, "error", "statusbar_service_null");
            }

            if (isClearAll) {
                int userId = 0;
                if (args.length > 1) {
                    try { userId = Integer.parseInt(args[1]); } catch (Throwable ignored) {}
                }
                boolean sbCleared = false;
                for (Method m : sb.getClass().getMethods()) {
                    if ("onClearAllNotifications".equals(m.getName())) {
                        m.invoke(sb, userId);
                        sbCleared = true;
                        break;
                    }
                }
                for (int i = 2; i < args.length; i++) {
                    String p = args[i];
                    if (p != null && !p.isEmpty()) {
                        cancelAllViaNotificationManager(p, userId);
                    }
                }
                return Json.obj("ok", true, "action", "onClearAllNotifications", "userId", userId, "sbCleared", sbCleared);
            }

            if (isClear) {
                if (key.isEmpty()) {
                    return Json.obj("ok", false, "error", "missing_clear_key");
                }
                String pkg = args.length > 2 ? args[2] : "";
                int userId = 0;
                int rawId = 0;
                String tag = null;

                if (key.contains("|")) {
                    String[] parts = key.split("\\|");
                    if (parts.length >= 1) {
                        try { userId = Integer.parseInt(parts[0]); } catch (Throwable ignored) {}
                    }
                    if (parts.length >= 2 && (pkg.isEmpty() || "null".equals(pkg))) {
                        pkg = parts[1];
                    }
                    if (parts.length >= 3) {
                        try { rawId = Integer.parseInt(parts[2]); } catch (Throwable ignored) {}
                    }
                    if (parts.length >= 4) {
                        tag = parts[3];
                        if ("null".equals(tag) || tag.isEmpty()) {
                            tag = null;
                        }
                    }
                }
                if (args.length > 3) {
                    try { userId = Integer.parseInt(args[3]); } catch (Throwable ignored) {}
                }

                // 1. Direct cancel via INotificationManager (app level, cancels group children and summary)
                if (!pkg.isEmpty()) {
                    cancelViaNotificationManager(pkg, tag, rawId, userId);
                    if (tag != null) {
                        cancelViaNotificationManager(pkg, null, rawId, userId);
                        if (rawId != 1) {
                            cancelViaNotificationManager(pkg, null, 1, userId);
                        }
                    }
                }

                // 2. Status bar shade dismiss via IStatusBarService (SystemUI level)
                Object nv = obtainVisibility(Class.forName("com.android.internal.statusbar.NotificationVisibility"), key);

                boolean sbCleared = false;
                for (Method m : sb.getClass().getMethods()) {
                    if ("onNotificationClear".equals(m.getName())) {
                        Class<?>[] pts = m.getParameterTypes();
                        if (pts.length == 6) {
                            m.invoke(sb, pkg, userId, key, 1, 1, nv);
                            sbCleared = true;
                            break;
                        } else if (pts.length == 4) {
                            m.invoke(sb, pkg, null, 0, userId);
                            sbCleared = true;
                            break;
                        }
                    }
                }
                return Json.obj("ok", true, "action", "clear", "key", key, "sbCleared", sbCleared);
            }

            int actionIndex = -1;
            if (args.length > 1) {
                try {
                    actionIndex = Integer.parseInt(args[1]);
                } catch (Throwable ignored) {}
            }

            if (actionIndex >= 0) {
                for (Method m : sb.getClass().getMethods()) {
                    if ("onNotificationActionClick".equals(m.getName())) {
                        try {
                            Class<?>[] pTypes = m.getParameterTypes();
                            Object[] callArgs = new Object[pTypes.length];
                            for (int i = 0; i < pTypes.length; i++) {
                                Class<?> pt = pTypes[i];
                                if (pt == String.class) {
                                    callArgs[i] = key;
                                } else if (pt == int.class || pt == Integer.class) {
                                    callArgs[i] = actionIndex;
                                } else if (pt == boolean.class || pt == Boolean.class) {
                                    callArgs[i] = false;
                                } else if (pt.getName().contains("NotificationVisibility")) {
                                    callArgs[i] = obtainVisibility(pt, key);
                                } else if (pt.getName().contains("Notification$Action")) {
                                    callArgs[i] = placeholderAction();
                                } else {
                                    callArgs[i] = null;
                                }
                            }
                            m.invoke(sb, callArgs);
                            return Json.obj("ok", true, "action", "onNotificationActionClick", "key", key, "index", actionIndex);
                        } catch (Throwable actErr) {
                            Throwable cause = actErr instanceof java.lang.reflect.InvocationTargetException
                                    ? ((java.lang.reflect.InvocationTargetException) actErr).getTargetException() : actErr;
                            Log.warn("NotificationInvoker", "action click failed, falling back to the content click: " + cause);
                        }
                    }
                }
            }

            if (clickViaStatusBar(key)) {
                return Json.obj("ok", true, "action", "onNotificationClick", "key", key);
            }
            return Json.obj("ok", false, "error", "method_not_found");
        } catch (Throwable t) {
            return Json.obj("ok", false, "error", Json.reason(t));
        }
    }

    static boolean clickViaStatusBar(String key) {
        try {
            Object sb = Binders.service("statusbar", "com.android.internal.statusbar.IStatusBarService$Stub");
            if (sb == null) return false;
            for (Method m : sb.getClass().getMethods()) {
                if ("onNotificationClick".equals(m.getName())) {
                    Object nv = obtainVisibility(m.getParameterTypes()[1], key);
                    m.invoke(sb, key, nv);
                    return true;
                }
            }
        } catch (Throwable t) {
            Log.warn("NotificationInvoker", "clickViaStatusBar failed: " + Json.reason(t));
        }
        return false;
    }

    /**
     * NotificationVisibility.obtain(key) — single-argument on newer builds, (key, rank, count, visible) on older ones;
     * null when neither exists. Shared by the clear, action-click and click paths (previously copied three times).
     */
    private static Object obtainVisibility(Class<?> nvClass, String key) {
        try {
            return nvClass.getMethod("obtain", String.class).invoke(null, key);
        } catch (Throwable ignored) {}
        try {
            return nvClass.getMethod("obtain", String.class, int.class, int.class, boolean.class).invoke(null, key, 0, 1, true);
        } catch (Throwable ignored) {}
        return null;
    }

    /** onNotificationActionClick's Notification.Action argument (only logged by the system): an empty action. */
    private static Object placeholderAction() {
        try {
            Class<?> actClass = Class.forName("android.app.Notification$Action");
            java.lang.reflect.Constructor<?> ctor = actClass.getDeclaredConstructor(int.class, CharSequence.class, android.app.PendingIntent.class);
            ctor.setAccessible(true);
            return ctor.newInstance(0, "", null);
        } catch (Throwable ignored) {}
        try {
            Class<?> builderClass = Class.forName("android.app.Notification$Action$Builder");
            java.lang.reflect.Constructor<?> bCtor = builderClass.getDeclaredConstructor(android.graphics.drawable.Icon.class, CharSequence.class, android.app.PendingIntent.class);
            bCtor.setAccessible(true);
            Object builder = bCtor.newInstance(null, "", null);
            return builderClass.getMethod("build").invoke(builder);
        } catch (Throwable ignored) {}
        return null;
    }

    private static String decodeKey(String raw) {
        if (raw == null || raw.isEmpty()) return "";
        try {
            String candidate = new String(Base64.getDecoder().decode(raw), StandardCharsets.UTF_8);
            if (candidate.contains("|") || candidate.contains(".")) return candidate;
        } catch (Throwable ignored) {}
        return raw;
    }

    /**
     * Fires the notification's OWN contentIntent onto a given display, as the notification's app. Unlike rebuilding an `am start`
     * from the intent's text (which drops its extras — the DM thread, the tweet id — and is refused by components that are not
     * exported), the PendingIntent carries the exact intent and the app's identity, so the app lands on the screen it meant.
     * The reply says what kind of PendingIntent it was: a broadcast/service one starts its activity itself, on the phone.
     */
    static JSONObject launchToDisplay(String key, int displayId) {
        if (key == null || key.isEmpty()) return Json.obj("ok", false, "error", "missing_key");
        if (!NotificationEvents.isConnected()) return Json.obj("ok", false, "error", "listener_not_connected", "key", key);
        StatusBarNotification sbn = NotificationEvents.findNotification(key);
        if (sbn == null) return Json.obj("ok", false, "error", "notification_not_found", "key", key);
        Notification n = sbn.getNotification();
        PendingIntent pi = n == null ? null : n.contentIntent;
        if (pi == null) return Json.obj("ok", false, "error", "no_content_intent", "package", sbn.getPackageName());

        String kind = "unknown";
        for (String probe : new String[] {"activity", "broadcast", "service"}) {
            try {
                String name = "is" + Character.toUpperCase(probe.charAt(0)) + probe.substring(1);
                if (Boolean.TRUE.equals(PendingIntent.class.getMethod(name).invoke(pi))) { kind = probe; break; }
            } catch (Throwable ignored) {}
        }

        ActivityOptions opts = ActivityOptions.makeBasic();
        opts.setLaunchDisplayId(displayId);
        // The sender (this shell process) may start the activity from the background only if it says so with the strongest mode:
        // ALLOW_ALWAYS (Android 16). MODE_BACKGROUND_ACTIVITY_START_ALLOWED is not enough on 15+ — the platform logs "Background
        // activity launch blocked" and the PendingIntent starts nothing (found on the POCO X7 Pro: 2 blocks with mode 1, none with 3).
        int senderMode = 1;
        try {
            senderMode = ActivityOptions.class.getField("MODE_BACKGROUND_ACTIVITY_START_ALLOW_ALWAYS").getInt(null);
        } catch (Throwable ignored) {}
        try {
            ActivityOptions.class.getMethod("setPendingIntentBackgroundActivityStartMode", int.class).invoke(opts, senderMode);
        } catch (Throwable modern) {
            try {
                ActivityOptions.class.getMethod("setPendingIntentBackgroundActivityLaunchAllowed", boolean.class).invoke(opts, true);
            } catch (Throwable ignored) {}
        }
        boolean sent = false;
        String launchMethod = "pending_intent_display";
        Throwable lastError = null;
        try {
            // The notification's own PendingIntent: the app's identity (non-exported targets work) and the intent's own extras.
            pi.send(null, 0, null, null, null, null, opts.toBundle());
            sent = true;
        } catch (Throwable t) {
            lastError = t;
            Log.warn("NotificationInvoker", "pi.send with display opts failed: " + Json.reason(t) + ", trying default send");
            try {
                pi.send(null, 0, null, null, null, null, null);
                sent = true;
                launchMethod = "pending_intent_default";
            } catch (Throwable t2) {
                lastError = t2;
                Log.warn("NotificationInvoker", "pi.send default also failed: " + Json.reason(t2) + ", falling back to statusbar click");
                if (clickViaStatusBar(key)) {
                    sent = true;
                    launchMethod = "statusbar_click";
                }
            }
        }

        if (!sent) {
            Throwable cause = lastError instanceof java.lang.reflect.InvocationTargetException && lastError.getCause() != null ? lastError.getCause() : lastError;
            return Json.obj("ok", false, "error", Json.reason(cause), "package", sbn.getPackageName(), "kind", kind);
        }

        // What a tap does: a notification that cancels itself on tap goes; an ongoing / foreground-service one stays.
        boolean cleared = false;
        int flags = n.flags;
        if ((flags & Notification.FLAG_AUTO_CANCEL) != 0
                && (flags & (Notification.FLAG_ONGOING_EVENT | Notification.FLAG_FOREGROUND_SERVICE)) == 0) {
            cancelViaNotificationManager(sbn.getPackageName(), sbn.getTag(), sbn.getId(), NotificationEvents.userId(sbn));
            cleared = true;
        }
        return Json.obj("ok", true, "action", "launch", "package", sbn.getPackageName(), "display", displayId,
                "kind", kind, "sender_mode", senderMode, "cleared", cleared);
    }

    private static Object notificationManager() {
        return Binders.service("notification", "android.app.INotificationManager$Stub");
    }

    private static void cancelViaNotificationManager(String pkg, String tag, int id, int userId) {
        Object nm = notificationManager();
        if (nm == null) return;
        try {
            for (Method m : nm.getClass().getMethods()) {
                if ("cancelNotificationWithTag".equals(m.getName())) {
                    m.invoke(nm, pkg, pkg, tag, id, userId);
                    return;
                }
            }
        } catch (Throwable ignored) {}
    }

    private static void cancelAllViaNotificationManager(String pkg, int userId) {
        Object nm = notificationManager();
        if (nm == null) return;
        try {
            for (Method m : nm.getClass().getMethods()) {
                if ("cancelAllNotifications".equals(m.getName())) {
                    m.invoke(nm, pkg, userId);
                    return;
                }
            }
        } catch (Throwable ignored) {}
    }
}
