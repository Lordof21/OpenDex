package com.opendex.tools;

import android.content.AttributionSource;
import android.content.ContentResolver;
import android.content.Context;
import android.content.ContextWrapper;
import android.content.IContentProvider;
import android.os.Build;

import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Method;

/**
 * The system {@link Context} re-labelled as the shell (uid 2000, "com.android.shell"). Android 12+ services
 * (AudioPolicy/AudioRecord, Bluetooth, clipboard…) check that the AttributionSource package belongs to the calling
 * uid; the plain system context says "android" and is rejected ("Given calling package android does not match
 * caller's uid 2000" — seen on Xiaomi HyperOS). Objects that carry an identity must be CONSTRUCTED with this context:
 * getSystemService() on a ContextWrapper delegates to the base context and would carry the wrong one.
 *
 * The same holds for {@link #getContentResolver()}: a ContentResolver freezes its package name when it is built, and the
 * system context's says "android" — the Settings provider (and any other) is then called as "android" from uid 2000.
 * {@link #getContentResolver()} therefore hands out a resolver built FOR this context (so it says "com.android.shell"),
 * that borrows the system context's resolver only to reach the providers. If that resolver cannot be built on some Android
 * version, the system context's own is returned — exactly what this class did before.
 */
final class ShellContext extends ContextWrapper {

    static final String PACKAGE = "com.android.shell";
    static final int SHELL_UID = 2000;

    private static ShellContext instance;

    /** Null while the system context is unavailable (see {@link SystemContext#lastError()}); retried on next call. */
    static synchronized ShellContext get() {
        if (instance == null) {
            Context base = SystemContext.get();
            if (base == null) return null;
            instance = new ShellContext(base);
        }
        return instance;
    }

    private ShellContext(Context base) {
        super(base);
    }

    @Override
    public String getPackageName() {
        return PACKAGE;
    }

    @Override
    public String getOpPackageName() {
        return PACKAGE;
    }

    @Override
    public Context getApplicationContext() {
        return this;
    }

    private ContentResolver resolver;

    @Override
    public synchronized ContentResolver getContentResolver() {
        if (resolver == null) {
            ContentResolver base = super.getContentResolver();
            try {
                resolver = new ShellResolver(this, base);
            } catch (Throwable t) {
                Log.warn("ShellContext", "no shell-identity ContentResolver on this Android (" + t + ") — using the system one");
                resolver = base;
            }
        }
        return resolver;
    }

    /** True when {@link #getContentResolver()} is the shell-identity one (false: the system context's, as before). */
    synchronized boolean hasShellResolver() {
        return getContentResolver() instanceof ShellResolver;
    }

    @Override
    public AttributionSource getAttributionSource() {
        if (Build.VERSION.SDK_INT < 31) return super.getAttributionSource();
        return new AttributionSource.Builder(SHELL_UID).setPackageName(PACKAGE).build();
    }

    /**
     * A ContentResolver that is labelled as the shell (its constructor reads the package name from the context it is given)
     * and reaches the providers through the system context's resolver. Its abstract provider methods are protected API of
     * ContentResolver, so they are called by reflection on the borrowed resolver.
     */
    private static final class ShellResolver extends ContentResolver {
        private final ContentResolver base;
        private final Method acquire;
        private final Method acquireUnstable;
        private final Method release;
        private final Method releaseUnstable;
        private final Method unstableDied;

        ShellResolver(Context shell, ContentResolver base) throws NoSuchMethodException {
            super(shell);
            this.base = base;
            acquire = open("acquireProvider", Context.class, String.class);
            acquireUnstable = open("acquireUnstableProvider", Context.class, String.class);
            release = open("releaseProvider", IContentProvider.class);
            releaseUnstable = open("releaseUnstableProvider", IContentProvider.class);
            unstableDied = open("unstableProviderDied", IContentProvider.class);
        }

        private static Method open(String name, Class<?>... types) throws NoSuchMethodException {
            Method m = ContentResolver.class.getDeclaredMethod(name, types);
            m.setAccessible(true);
            return m;
        }

        private Object call(Method m, Object... args) {
            try {
                return m.invoke(base, args);
            } catch (InvocationTargetException e) {
                Throwable cause = e.getCause();
                if (cause instanceof RuntimeException) throw (RuntimeException) cause;
                throw new IllegalStateException(cause);
            } catch (IllegalAccessException e) {
                throw new IllegalStateException(e);
            }
        }

        protected IContentProvider acquireProvider(Context c, String name) {
            IContentProvider external = externalProvider(name);
            return external != null ? external : (IContentProvider) call(acquire, c, name);
        }

        protected IContentProvider acquireUnstableProvider(Context c, String name) {
            IContentProvider external = externalProvider(name);
            return external != null ? external : (IContentProvider) call(acquireUnstable, c, name);
        }

        /** Identifies this process to ActivityManager for getContentProviderExternal (the shell's `content`/`settings` do the same). */
        private static final android.os.IBinder EXTERNAL_TOKEN = new android.os.Binder();
        private static final java.util.Map<String, IContentProvider> EXTERNAL = new java.util.concurrent.ConcurrentHashMap<>();

        /**
         * A provider obtained the way a shell command obtains one: ActivityManager.getContentProviderExternal. The ordinary
         * path (ActivityThread.acquireProvider) hands ActivityManager OUR IApplicationThread, which this app_process never
         * attached — a provider this process has not cached yet is then refused ("Unable to find app for caller
         * IApplicationThread$Stub$Proxy@… when getting content provider settings"), on every read, for ever. Null when the
         * call is not available on this Android; the caller then falls back to the ordinary path, as before.
         */
        private static IContentProvider externalProvider(String name) {
            IContentProvider cached = EXTERNAL.get(name);
            if (cached != null) {
                if (cached.asBinder().isBinderAlive()) return cached;
                EXTERNAL.remove(name);   // the provider's process died: ask again
            }
            try {
                Object am = Binders.service("activity", "android.app.IActivityManager$Stub");
                if (am == null) return null;
                Method get = null;
                for (Method m : Class.forName("android.app.IActivityManager").getMethods()) {
                    Class<?>[] p = m.getParameterTypes();
                    if (m.getName().equals("getContentProviderExternal") && p.length == 4 && p[0] == String.class
                            && p[1] == int.class && p[2] == android.os.IBinder.class && p[3] == String.class) {
                        get = m;
                        break;
                    }
                }
                if (get == null) return null;
                Object holder = get.invoke(am, name, 0, EXTERNAL_TOKEN, "opendex");
                if (holder == null) return null;
                IContentProvider provider = (IContentProvider) holder.getClass().getField("provider").get(holder);
                if (provider != null) EXTERNAL.put(name, provider);
                return provider;
            } catch (Throwable t) {
                Log.warn("ShellContext", "getContentProviderExternal(" + name + ") unavailable: " + Json.reason(t));
                return null;
            }
        }

        public boolean releaseProvider(IContentProvider icp) {
            return Boolean.TRUE.equals(call(release, icp));
        }

        public boolean releaseUnstableProvider(IContentProvider icp) {
            return Boolean.TRUE.equals(call(releaseUnstable, icp));
        }

        public void unstableProviderDied(IContentProvider icp) {
            call(unstableDied, icp);
        }
    }
}
