package com.opendex.tools;

import org.json.JSONObject;

import java.lang.reflect.Method;
import java.nio.charset.StandardCharsets;
import java.util.Base64;

/**
 * Notification click / action / clear through IStatusBarService + INotificationManager. Runs as a one-shot CLI
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

            Method onNotificationClick = null;
            for (Method m : sb.getClass().getMethods()) {
                if ("onNotificationClick".equals(m.getName())) {
                    onNotificationClick = m;
                    break;
                }
            }

            if (onNotificationClick != null) {
                Object nv = obtainVisibility(onNotificationClick.getParameterTypes()[1], key);
                onNotificationClick.invoke(sb, key, nv);
                return Json.obj("ok", true, "action", "onNotificationClick", "key", key);
            }
            return Json.obj("ok", false, "error", "method_not_found");
        } catch (Throwable t) {
            return Json.obj("ok", false, "error", Json.reason(t));
        }
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
