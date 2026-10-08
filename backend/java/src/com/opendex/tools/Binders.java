package com.opendex.tools;

import android.os.IBinder;

import java.lang.reflect.Method;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/**
 * System-service Binder lookup shared by every on-device tool (daemon and the one-shot CLI tools):
 * {@code ServiceManager.getService(name)} + {@code Stub.asInterface(binder)}, cached per (name, stub).
 * A failed lookup returns null and is NOT cached, so a service that comes up later is still found.
 */
final class Binders {

    private static final Map<String, Object> CACHE = new ConcurrentHashMap<>();

    private Binders() {}

    static Object service(String name, String stubClass) {
        return CACHE.computeIfAbsent(name + "|" + stubClass, k -> {
            try {
                Method getService = Class.forName("android.os.ServiceManager").getMethod("getService", String.class);
                IBinder binder = (IBinder) getService.invoke(null, name);
                if (binder == null) return null;
                return Class.forName(stubClass).getMethod("asInterface", IBinder.class).invoke(null, binder);
            } catch (Throwable t) {
                return null;
            }
        });
    }

    /** IActivityTaskManager (Android 10+ "activity_task"; older/OEM builds expose it under "activity"). */
    static Object activityTaskManager() {
        Object atm = service("activity_task", "android.app.IActivityTaskManager$Stub");
        return atm != null ? atm : service("activity", "android.app.IActivityTaskManager$Stub");
    }
}
