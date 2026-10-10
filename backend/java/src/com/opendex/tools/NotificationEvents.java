package com.opendex.tools;

import android.app.Notification;
import android.app.PendingIntent;
import android.content.ComponentName;
import android.content.Context;
import android.content.ContextWrapper;
import android.content.Intent;
import android.os.Bundle;
import android.os.HandlerThread;
import android.os.Looper;
import android.service.notification.NotificationListenerService;
import android.service.notification.StatusBarNotification;

import org.json.JSONArray;
import org.json.JSONObject;

import java.lang.reflect.Method;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Notifications pushed by NotificationManager instead of the backend polling `dumpsys notification --noredact` (every
 * 2.5 s plus on every logcat event — the heaviest thing OpenDeX did to the phone).
 *
 * The daemon registers itself as a SYSTEM notification listener ({@code registerAsSystemService}, what SystemUI does):
 * allowed for callers holding STATUS_BAR_SERVICE, which the shell has. No app, no user-granted listener access. The
 * framework class does all the version-specific binder work; this subclass only turns its callbacks into events:
 *   notification_posted  {item}                  a new or updated notification
 *   notification_removed {key, package, reason}
 *   notifications_update {ok, items:[…]}         the full list: on (re)connect, to every new client, on request
 * Callbacks arrive on our own HandlerThread (the framework posts them to the context's "main" looper — the daemon's
 * main thread runs the accept loop, so the context hands out this thread's looper instead).
 */
final class NotificationEvents extends NotificationListenerService {

    private static final int USER_ALL = -1;
    private static final int MAX_TEXT = 5000;
    private static final int MAX_LINES = 20;
    private static final ComponentName COMPONENT =
            new ComponentName(ShellContext.PACKAGE, "com.opendex.tools.NotificationEvents");

    private static NotificationEvents instance;
    private static HandlerThread thread;
    private static volatile boolean connected;
    private static volatile String lastError;

    private final ScheduledExecutorService scheduler;
    private final AtomicBoolean snapshotPending = new AtomicBoolean();

    private NotificationEvents(ScheduledExecutorService scheduler) {
        this.scheduler = scheduler;
    }

    static boolean isConnected() {
        return connected;
    }

    static synchronized void start(ScheduledExecutorService scheduler) {
        if (instance != null) return;
        try {
            Context base = SystemContext.get();
            if (base == null) throw new IllegalStateException("no system context: " + SystemContext.lastError());
            thread = new HandlerThread("OpenDex-Notifications");
            thread.setDaemon(true);
            thread.start();
            final Looper looper = thread.getLooper();
            Context ctx = new ContextWrapper(base) {
                @Override
                public Looper getMainLooper() {
                    return looper;
                }
            };
            NotificationEvents listener = new NotificationEvents(scheduler);
            Method register = NotificationListenerService.class.getMethod(
                    "registerAsSystemService", Context.class, ComponentName.class, int.class);
            try {
                register.invoke(listener, ctx, COMPONENT, USER_ALL); // every profile, as SystemUI listens
            } catch (java.lang.reflect.InvocationTargetException e) {
                Log.warn("NotificationEvents", "USER_ALL refused (" + Json.reason(e.getCause()) + "), listening as user 0");
                register.invoke(listener, ctx, COMPONENT, 0);
            }
            instance = listener;
            lastError = null;
            Log.info("NotificationEvents", "system notification listener registered (push mode)");
        } catch (Throwable t) {
            Throwable cause = t instanceof java.lang.reflect.InvocationTargetException && t.getCause() != null ? t.getCause() : t;
            lastError = Json.reason(cause);
            Log.warn("NotificationEvents", "listener unavailable, the backend keeps polling: " + lastError);
            if (thread != null) thread.quitSafely();
            thread = null;
        }
    }

    static synchronized void stop() {
        if (instance == null) return;
        try {
            NotificationListenerService.class.getMethod("unregisterAsSystemService").invoke(instance);
        } catch (Throwable ignored) {}
        instance = null;
        connected = false;
        if (thread != null) thread.quitSafely();
        thread = null;
    }

    // ---------------------------------------------------------------- listener callbacks (on our HandlerThread)

    @Override
    public void onListenerConnected() {
        connected = true;
        Log.info("NotificationEvents", "listener connected");
        scheduleSnapshot();
    }

    @Override
    public void onListenerDisconnected() {
        connected = false;
        Log.warn("NotificationEvents", "listener disconnected by the system");
        OpenDexDaemon.broadcastEvent(Json.obj("type", "notifications_update", "ok", false, "error", "listener_disconnected"));
    }

    @Override
    public void onNotificationPosted(StatusBarNotification sbn, RankingMap rankingMap) {
        JSONObject item = itemJson(sbn, rankingMap);
        if (item != null) OpenDexDaemon.broadcastEvent(Json.obj("type", "notification_posted", "item", item));
    }

    @Override
    public void onNotificationRemoved(StatusBarNotification sbn, RankingMap rankingMap, int reason) {
        if (sbn == null) return;
        OpenDexDaemon.broadcastEvent(Json.obj(
                "type", "notification_removed", "key", sbn.getKey(), "package", sbn.getPackageName(), "reason", reason));
    }

    /** Coalesces connect bursts into one full snapshot, built off the binder/handler thread. */
    private void scheduleSnapshot() {
        if (!snapshotPending.compareAndSet(false, true)) return;
        try {
            scheduler.schedule(() -> {
                snapshotPending.set(false);
                OpenDexDaemon.broadcastEvent(snapshotJson());
            }, 100, TimeUnit.MILLISECONDS);
        } catch (Throwable t) {
            snapshotPending.set(false);
        }
    }

    // ---------------------------------------------------------------- snapshot

    /** notifications_update: every active notification, or {ok:false, error} when the listener is not live. */
    static JSONObject snapshotJson() {
        NotificationEvents listener = instance;
        if (listener == null || !connected) {
            return Json.obj("type", "notifications_update", "ok", false,
                    "error", lastError != null ? lastError : "listener_not_connected");
        }
        try {
            StatusBarNotification[] active = listener.getActiveNotifications();
            if (active == null) return Json.obj("type", "notifications_update", "ok", false, "error", "list_unavailable");
            RankingMap ranking = listener.getCurrentRanking();
            JSONArray items = new JSONArray();
            for (StatusBarNotification sbn : active) {
                JSONObject item = itemJson(sbn, ranking);
                if (item != null) items.put(item);
            }
            return Json.obj("type", "notifications_update", "ok", true, "items", items);
        } catch (Throwable t) {
            return Json.error("notifications_update", t);
        }
    }

    // ---------------------------------------------------------------- serialization

    /**
     * The fields the backend's notification model reads (the same ones it parsed out of `dumpsys notification
     * --noredact`), plus the launch intent the backend used to dig out of `dumpsys activity intents`. Every read is
     * guarded: an app's own Parcelable in the extras must cost that field, never the whole item.
     */
    static JSONObject itemJson(StatusBarNotification sbn, RankingMap rankingMap) {
        if (sbn == null) return null;
        Notification n = sbn.getNotification();
        if (n == null) return null;
        JSONObject item = Json.obj(
                "key", sbn.getKey(),
                "package", sbn.getPackageName(),
                "id", sbn.getId(),
                "tag", sbn.getTag(),
                "uid", sbn.getUid(),
                "user", userId(sbn),
                "post_time", sbn.getPostTime(),
                "when", n.when,
                "flags", n.flags,
                "category", n.category,
                "group_summary", (n.flags & Notification.FLAG_GROUP_SUMMARY) != 0);
        try { Json.put(item, "shortcut", n.getShortcutId()); } catch (Throwable ignored) {}
        if (rankingMap != null) {
            try {
                Ranking r = new Ranking();
                if (rankingMap.getRanking(sbn.getKey(), r)) Json.put(item, "importance", r.getImportance());
            } catch (Throwable ignored) {}
        }
        Bundle extras = n.extras;
        String template = text(extras, Notification.EXTRA_TEMPLATE);
        Json.put(item, "template", template);
        Json.put(item, "title", text(extras, Notification.EXTRA_TITLE));
        Json.put(item, "text", text(extras, Notification.EXTRA_TEXT));
        Json.put(item, "big_text", text(extras, Notification.EXTRA_BIG_TEXT));
        Json.put(item, "sub_text", text(extras, Notification.EXTRA_SUB_TEXT));
        Json.put(item, "summary_text", text(extras, Notification.EXTRA_SUMMARY_TEXT));
        Json.put(item, "info_text", text(extras, Notification.EXTRA_INFO_TEXT));
        Json.put(item, "ticker", clip(n.tickerText));
        Json.put(item, "lines", lines(extras));
        Json.put(item, "actions", actions(n));
        boolean media = template != null && template.contains("MediaStyle");
        try { media |= extras != null && extras.containsKey(Notification.EXTRA_MEDIA_SESSION); } catch (Throwable ignored) {}
        Json.put(item, "media", media || Notification.CATEGORY_TRANSPORT.equals(n.category));
        Json.put(item, "content_intent", launchIntent(n.contentIntent));
        return item;
    }

    /**
     * The live notification with this key (its real contentIntent included), or null: the listener is not connected, or the
     * notification is already gone. Asks the framework for just that key instead of walking the whole shade.
     */
    static StatusBarNotification findNotification(String key) {
        NotificationEvents listener = instance;
        if (key == null || key.isEmpty() || listener == null || !connected) return null;
        try {
            StatusBarNotification[] hit = listener.getActiveNotifications(new String[] {key});
            if (hit != null) {
                for (StatusBarNotification sbn : hit) {
                    if (sbn != null && key.equals(sbn.getKey())) return sbn;
                }
            }
            StatusBarNotification[] all = listener.getActiveNotifications();
            if (all != null) {
                for (StatusBarNotification sbn : all) {
                    if (sbn != null && (key.equals(sbn.getKey()) || (sbn.getKey() != null && sbn.getKey().contains(key)))) {
                        return sbn;
                    }
                }
            }
        } catch (Throwable ignored) {}
        return null;
    }

    static int userId(StatusBarNotification sbn) {
        try {
            return (Integer) StatusBarNotification.class.getMethod("getUserId").invoke(sbn);
        } catch (Throwable t) {
            return sbn.getUser() != null ? sbn.getUser().hashCode() : 0; // UserHandle.hashCode() is its id
        }
    }

    private static String text(Bundle extras, String key) {
        if (extras == null) return null;
        try {
            Object v = extras.get(key);
            return v == null ? null : clip(v instanceof CharSequence ? (CharSequence) v : String.valueOf(v));
        } catch (Throwable t) {
            return null;
        }
    }

    private static String clip(CharSequence cs) {
        if (cs == null) return null;
        String s = cs.toString();
        return s.length() > MAX_TEXT ? s.substring(0, MAX_TEXT) : s;
    }

    private static JSONArray lines(Bundle extras) {
        JSONArray out = new JSONArray();
        if (extras == null) return out;
        try {
            CharSequence[] lines = extras.getCharSequenceArray(Notification.EXTRA_TEXT_LINES);
            if (lines == null) return out;
            for (int i = 0; i < lines.length && i < MAX_LINES; i++) {
                if (lines[i] != null) out.put(clip(lines[i]));
            }
        } catch (Throwable ignored) {}
        return out;
    }

    private static JSONArray actions(Notification n) {
        JSONArray out = new JSONArray();
        if (n.actions == null) return out;
        for (Notification.Action a : n.actions) {
            out.put(a != null && a.title != null ? clip(a.title) : "");
        }
        return out;
    }

    /**
     * The content intent as `dumpsys activity intents` prints a PendingIntentRecord's requestIntent
     * ({@code Intent.toShortString(false, true, true, false)}): the backend turns it into `am start` arguments with the
     * parser it already has. GET_INTENT_SENDER_INTENT is granted to shell. Null when there is none / unreadable.
     */
    private static String launchIntent(PendingIntent pi) {
        if (pi == null) return null;
        try {
            Intent intent = (Intent) PendingIntent.class.getMethod("getIntent").invoke(pi);
            if (intent == null) return null;
            return (String) Intent.class.getMethod("toShortString", boolean.class, boolean.class, boolean.class, boolean.class)
                    .invoke(intent, false, true, true, false);
        } catch (Throwable t) {
            return null;
        }
    }
}
