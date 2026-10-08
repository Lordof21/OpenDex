package com.opendex.tools;

import android.content.Context;
import android.os.Looper;

import java.lang.reflect.Constructor;
import java.lang.reflect.Field;
import java.lang.reflect.Method;

/**
 * The system {@link Context} for code running under app_process (shell UID, no Application). Shared by the daemon and
 * the CLI tools, which used to carry two different recipes. Order:
 *   1. a private ActivityThread marked as the system thread (the daemon's long-proven path; no process-wide attach),
 *   2. {@code ActivityThread.systemMain()} (IconExtractor's former path),
 *   3. {@code ActivityThread.currentApplication()}.
 * NEVER prints: IconExtractor streams PNG bytes on stdout, so any diagnostic goes to {@link #lastError()} instead.
 */
final class SystemContext {

    private static Context context;
    private static volatile String lastError;

    private SystemContext() {}

    static synchronized Context get() {
        if (context != null) return context;
        if (Looper.getMainLooper() == null) {
            try { Looper.prepareMainLooper(); } catch (Throwable ignored) {}
        }
        Class<?> atClass;
        try {
            atClass = Class.forName("android.app.ActivityThread");
        } catch (Throwable t) {
            lastError = "ActivityThread unavailable: " + t.getMessage();
            return null;
        }
        try {
            context = privateSystemThreadContext(atClass);
        } catch (Throwable t) {
            lastError = "private ActivityThread: " + t.getMessage();
        }
        if (context == null) {
            try {
                Object thread = atClass.getMethod("systemMain").invoke(null);
                context = (Context) atClass.getMethod("getSystemContext").invoke(thread);
            } catch (Throwable t) {
                lastError = "systemMain: " + t.getMessage();
            }
        }
        if (context == null) {
            try {
                Object app = atClass.getMethod("currentApplication").invoke(null);
                if (app instanceof Context) context = (Context) app;
            } catch (Throwable t) {
                lastError = "currentApplication: " + t.getMessage();
            }
        }
        return context;
    }

    static String lastError() {
        return lastError;
    }

    private static Context privateSystemThreadContext(Class<?> atClass) throws Throwable {
        Constructor<?> ctor = atClass.getDeclaredConstructor();
        ctor.setAccessible(true);
        Object thread = ctor.newInstance();
        try {
            Field current = atClass.getDeclaredField("sCurrentActivityThread");
            current.setAccessible(true);
            current.set(null, thread);
        } catch (Throwable ignored) {}
        Field systemThread = atClass.getDeclaredField("mSystemThread");
        systemThread.setAccessible(true);
        systemThread.set(thread, true);
        Method getSystemContext = atClass.getMethod("getSystemContext");
        return (Context) getSystemContext.invoke(thread);
    }
}
