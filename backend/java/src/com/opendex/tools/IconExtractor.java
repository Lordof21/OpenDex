package com.opendex.tools;

import android.content.Context;
import android.content.Intent;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageManager;
import android.content.pm.ResolveInfo;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.drawable.Drawable;
import android.os.Looper;

import java.io.ByteArrayOutputStream;
import java.lang.reflect.Method;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

/**
 * One-shot app-icon CLI (icon_service.py). stdout carries raw PNG bytes for "get", so NOTHING else may print there.
 *   get <pkg> [size]   -> PNG bytes (exit 1 on failure)
 *   list-apps          -> one {"package", "label"} JSON object per launcher app, one per line
 */
public class IconExtractor {

    /** XXHDPI: request the high-resolution asset directly instead of the device-density default. */
    private static final int ICON_DENSITY = 480;

    private static Context requireContext() {
        if (Looper.getMainLooper() == null) {
            try { Looper.prepareMainLooper(); } catch (Throwable ignored) {}
        }
        try {
            Class<?> activityThreadClass = Class.forName("android.app.ActivityThread");
            Method systemMain = activityThreadClass.getMethod("systemMain");
            Object activityThread = systemMain.invoke(null);
            Method getSystemContext = activityThreadClass.getMethod("getSystemContext");
            Context ctx = (Context) getSystemContext.invoke(activityThread);
            if (ctx != null) return ctx;
        } catch (Throwable ignored) {}

        Context context = SystemContext.get();
        if (context == null) throw new IllegalStateException("Could not obtain system Context: " + SystemContext.lastError());
        return context;
    }

    /** The drawable for {@code iconRes} straight from the app's resources at ICON_DENSITY (bypasses OEM theme fallback bugs). */
    private static Drawable rawIcon(PackageManager pm, ApplicationInfo app, int iconRes) {
        if (iconRes == 0) return null;
        try {
            android.content.res.Resources res = pm.getResourcesForApplication(app);
            try {
                return res.getDrawableForDensity(iconRes, ICON_DENSITY, null);
            } catch (Throwable ignored) {
                // If density-specific resource is unavailable (e.g. XML anydpi adaptive icons), fall back to standard loader
                return res.getDrawable(iconRes, null);
            }
        } catch (Throwable ignored) {
            return null;
        }
    }

    private static Drawable loadAuthenticIcon(PackageManager pm, ResolveInfo ri, String packageName) {
        // 1. Launcher activity: raw resource, then the framework loader
        if (ri != null && ri.activityInfo != null) {
            Drawable d = rawIcon(pm, ri.activityInfo.applicationInfo, ri.activityInfo.getIconResource());
            if (d != null) return d;
            try {
                d = ri.loadIcon(pm);
                if (d != null) return d;
            } catch (Throwable ignored) {}
        }

        // 2. Application: raw resource, then the framework loader
        try {
            ApplicationInfo appInfo = pm.getApplicationInfo(packageName, 0);
            Drawable d = rawIcon(pm, appInfo, appInfo.icon);
            if (d != null) return d;
            try {
                d = appInfo.loadIcon(pm);
                if (d != null) return d;
            } catch (Throwable ignored) {}
        } catch (Throwable ignored) {}

        // 3. Fallback to default activity icon
        try {
            return pm.getDefaultActivityIcon();
        } catch (Throwable ignored) {}
        return null;
    }

    private static byte[] drawableToPngBytes(Drawable drawable, int size) {
        if (drawable == null) return null;
        try {
            Bitmap bitmap = Bitmap.createBitmap(size, size, Bitmap.Config.ARGB_8888);
            Canvas canvas = new Canvas(bitmap);
            drawable.setBounds(0, 0, size, size);
            drawable.draw(canvas);

            ByteArrayOutputStream stream = new ByteArrayOutputStream();
            bitmap.compress(Bitmap.CompressFormat.PNG, 100, stream);
            return stream.toByteArray();
        } catch (Throwable ignored) {
            return null;
        }
    }

    public static void extractSingleIcon(String packageName, int size) {
        try {
            PackageManager pm = requireContext().getPackageManager();

            ResolveInfo ri = null;
            try {
                Intent intent = new Intent(Intent.ACTION_MAIN, null);
                intent.addCategory(Intent.CATEGORY_LAUNCHER);
                intent.setPackage(packageName);
                List<ResolveInfo> list = pm.queryIntentActivities(intent, 0);
                if (list != null && !list.isEmpty()) {
                    ri = list.get(0);
                }
            } catch (Throwable ignored) {}

            Drawable icon = loadAuthenticIcon(pm, ri, packageName);
            byte[] png = drawableToPngBytes(icon, size);
            if (png != null && png.length > 0) {
                System.out.write(png);
                System.out.flush();
            } else {
                System.exit(1);
            }
        } catch (Throwable ignored) {
            System.exit(1);
        }
    }

    public static void listAllApps() {
        try {
            PackageManager pm = requireContext().getPackageManager();

            Intent mainIntent = new Intent(Intent.ACTION_MAIN, null);
            mainIntent.addCategory(Intent.CATEGORY_LAUNCHER);
            List<ResolveInfo> apps = pm.queryIntentActivities(mainIntent, 0);

            Set<String> seenPackages = new HashSet<String>();

            for (ResolveInfo ri : apps) {
                try {
                    String pkg = ri.activityInfo.packageName;
                    if (!seenPackages.add(pkg)) {
                        continue;
                    }
                    String label = ri.loadLabel(pm).toString();
                    System.out.println(Json.obj("package", pkg, "label", label));
                } catch (Throwable ignored) {}
            }
        } catch (Throwable t) {
            System.exit(1);
        }
    }

    public static void main(String[] args) {
        if (args.length == 0) {
            System.exit(1);
            return;
        }

        String cmd = args[0];

        if ("list-apps".equals(cmd)) {
            listAllApps();
        } else if ("get".equals(cmd) && args.length >= 2) {
            String pkg = args[1];
            int iconSize = (args.length >= 3 && args[2].matches("\\d+")) ? Integer.parseInt(args[2]) : 128;
            extractSingleIcon(pkg, iconSize);
        } else {
            System.exit(1);
        }
    }
}
