package android.app;

import android.content.ComponentName;

/**
 * COMPILE-ONLY stand-in for the hidden framework class (on the device it is a real ITaskStackListener.Stub, i.e. a
 * Binder the system server can call back). build.py puts this directory on the javac classpath but NEVER dexes it:
 * a copy inside opendex-tools.jar would shadow the framework class and break the callbacks at runtime.
 * Only the callbacks TaskEvents overrides are declared here; their descriptors match the framework's.
 */
public abstract class TaskStackListener {
    public TaskStackListener() {}

    public void onTaskStackChanged() {}

    public void onTaskCreated(int taskId, ComponentName componentName) {}

    public void onTaskRemoved(int taskId) {}

    public void onTaskMovedToFront(ActivityManager.RunningTaskInfo taskInfo) {}

    public void onTaskDisplayChanged(int taskId, int newDisplayId) {}

    public void onTaskFocusChanged(int taskId, boolean focused) {}
}
