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
            return (IContentProvider) call(acquire, c, name);
        }

        protected IContentProvider acquireUnstableProvider(Context c, String name) {
            return (IContentProvider) call(acquireUnstable, c, name);
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
