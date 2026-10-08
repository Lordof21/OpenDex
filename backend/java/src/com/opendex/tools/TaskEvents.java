package com.opendex.tools;

import android.app.ActivityManager;
import android.app.TaskStackListener;
import android.content.ComponentName;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Task events pushed by ActivityTaskManager instead of polling.
 *
 * Extends the framework's hidden {@code android.app.TaskStackListener} — a REAL ITaskStackListener.Stub, i.e. a
 * Binder the system server can call back. (A java.lang.reflect.Proxy "implementing" the AIDL interface is not a
 * Binder: asBinder() is null, registration "succeeds" and nothing ever arrives.) Compiled against a stub
 * (java/stubs), linked to the device's class at runtime.
 *
 * Binder callbacks run on binder threads and only schedule work on the daemon scheduler — they never block.
 * Emits:
 *   task_removed  {taskId, package?}                          immediately
 *   focus_update  (same shape as the poller's)                on move-to-front / focus change
 *   tasks_update  {tasks:[{id, display, package, visible}], push}   150 ms debounced snapshot, only when changed
 * Without the listener (registration refused), the daemon poller calls {@link #pollIfUnregistered()} instead.
 */
final class TaskEvents extends TaskStackListener {

    private static final long SNAPSHOT_DEBOUNCE_MS = 150;
    private static final int MAX_REMEMBERED_TASKS = 256;

    private static TaskEvents instance;
    private static volatile boolean registered;
    private static final Object SNAPSHOT_LOCK = new Object();
    private static String lastSnapshot = "";                                   // guarded by SNAPSHOT_LOCK
    private static final Map<Integer, String> packageByTask = new ConcurrentHashMap<>();

    private final ScheduledExecutorService scheduler;
    private final AtomicBoolean snapshotPending = new AtomicBoolean();

    private TaskEvents(ScheduledExecutorService scheduler) {
        this.scheduler = scheduler;
    }

    /** True while the push path is live; the daemon then keeps its focus poll only as a slow safety net. */
    static boolean isRegistered() {
        return registered;
    }

    static synchronized void start(ScheduledExecutorService scheduler) {
        if (instance != null) return;
        instance = new TaskEvents(scheduler);
        try {
            Object atm = Binders.activityTaskManager();
            if (atm == null) throw new IllegalStateException("activity_task service unavailable");
            Class<?> iface = Class.forName("android.app.ITaskStackListener");
            atm.getClass().getMethod("registerTaskStackListener", iface).invoke(atm, instance);
            registered = true;
            Log.info("TaskEvents", "TaskStackListener registered (push mode)");
            instance.scheduleSnapshot();
        } catch (Throwable t) {
            registered = false;
            Log.warn("TaskEvents", "TaskStackListener unavailable, task polling stays primary: " + t);
        }
    }

    static synchronized void stop() {
        if (instance == null || !registered) return;
        try {
            Object atm = Binders.activityTaskManager();
            Class<?> iface = Class.forName("android.app.ITaskStackListener");
            atm.getClass().getMethod("unregisterTaskStackListener", iface).invoke(atm, instance);
        } catch (Throwable ignored) {}
        registered = false;
    }

    /** The current snapshot as a tasks_update (the tasks_list reply, and a new client's baseline). */
    static JSONObject snapshotJson() {
        JSONArray tasks = readTasks();
        return Json.obj("type", "tasks_update", "ok", tasks != null, "push", registered,
                "tasks", tasks != null ? tasks : new JSONArray());
    }

    /** Poller fallback (listener refused): the same deduplicated snapshot, at the poller's cadence. */
    static void pollIfUnregistered() {
        if (!registered) publishSnapshotIfChanged();
    }

    // ---------------------------------------------------------------- binder callbacks (keep them tiny)

    @Override
    public void onTaskStackChanged() {
        scheduleSnapshot();
    }

    @Override
    public void onTaskCreated(int taskId, ComponentName componentName) {
        scheduleSnapshot();
    }

    @Override
    public void onTaskRemoved(int taskId) {
        run(() -> {
            String pkg = packageByTask.remove(taskId);
            JSONObject ev = Json.obj("type", "task_removed", "taskId", taskId);
            if (pkg != null) Json.put(ev, "package", pkg);
            OpenDexDaemon.broadcastEvent(ev);
        });
        scheduleSnapshot();
    }

    @Override
    public void onTaskMovedToFront(ActivityManager.RunningTaskInfo taskInfo) {
        run(OpenDexDaemon::broadcastFocusIfChanged);
        scheduleSnapshot();
    }

    @Override
    public void onTaskDisplayChanged(int taskId, int newDisplayId) {
        scheduleSnapshot();
    }

    @Override
    public void onTaskFocusChanged(int taskId, boolean focused) {
        if (focused) run(OpenDexDaemon::broadcastFocusIfChanged);
    }

    // ---------------------------------------------------------------- work on the daemon scheduler

    private void run(Runnable work) {
        try {
            scheduler.execute(() -> {
                try {
                    work.run();
                } catch (Throwable t) {
                    Log.warn("TaskEvents", "event failed: " + t);
                }
            });
        } catch (RejectedExecutionException ignored) {
            // shutting down
        }
    }

    /** Coalesces a burst of callbacks (one app launch fires several) into one snapshot. */
    private void scheduleSnapshot() {
        if (!snapshotPending.compareAndSet(false, true)) return;
        try {
            scheduler.schedule(() -> {
                snapshotPending.set(false);
                publishSnapshotIfChanged();
            }, SNAPSHOT_DEBOUNCE_MS, TimeUnit.MILLISECONDS);
        } catch (RejectedExecutionException e) {
            snapshotPending.set(false);
        }
    }

    private static void publishSnapshotIfChanged() {
        JSONArray tasks = readTasks();
        if (tasks == null) return;
        String key = tasks.toString();
        synchronized (SNAPSHOT_LOCK) {
            if (key.equals(lastSnapshot)) return;
            lastSnapshot = key;
        }
        OpenDexDaemon.broadcastEvent(Json.obj("type", "tasks_update", "ok", true, "push", registered, "tasks", tasks));
    }

    /** Root tasks via the daemon's reader; refreshes the taskId → package map task_removed relies on. */
    private static JSONArray readTasks() {
        try {
            JSONArray tasks = OpenDexDaemon.rootTasksJson();
            // Entries are only ADDED here (a removal callback needs the package of a task the latest snapshot may
            // already miss) and dropped on onTaskRemoved; a task that vanished without a callback is pruned once
            // the map grows large.
            if (packageByTask.size() > MAX_REMEMBERED_TASKS) packageByTask.clear();
            for (int i = 0; i < tasks.length(); i++) {
                JSONObject t = tasks.getJSONObject(i);
                if (t.has("package")) packageByTask.put(t.getInt("id"), t.getString("package"));
            }
            return tasks;
        } catch (Throwable t) {
            Log.warn("TaskEvents", "task snapshot failed: " + t);
            return null;
        }
    }
}
