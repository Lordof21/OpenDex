package com.opendex.tools;

import android.content.Context;
import android.net.wifi.WifiManager;
import android.os.HandlerThread;
import android.os.Looper;

import org.json.JSONObject;

import java.lang.reflect.InvocationTargetException;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * Joins a SAVED Wi-Fi network by its id, without asking for the password again.
 * `cmd wifi connect-network` always needs the passphrase; the framework's own "tap a saved network" path is the
 * {@code @SystemApi WifiManager.connect(int netId, ActionListener)}, guarded by NETWORK_SETTINGS — which the shell holds.
 *
 * Like Bluetooth, the caller identity matters: WifiServiceImpl checks that the package in the call belongs to the
 * calling uid, and WifiManager sends {@code mContext.getOpPackageName()} / its AttributionSource. So the manager is
 * CONSTRUCTED around {@link ShellContext} (getSystemService() would carry the system context's "android").
 * The listener is delivered on the Looper given to the constructor — a dedicated HandlerThread here.
 */
final class Wifi {

    private static final long ANSWER_TIMEOUT_MS = 4_000;

    private static WifiManager manager;
    private static HandlerThread thread;

    private Wifi() {}

    static JSONObject connectSaved(int networkId) {
        JSONObject res = Json.obj("type", "wifi_result", "ok", false, "verb", "connect_saved", "network_id", networkId);
        if (networkId < 0) return Json.put(res, "error", "bad_network_id");
        try {
            final CountDownLatch answered = new CountDownLatch(1);
            final AtomicInteger failure = new AtomicInteger(Integer.MIN_VALUE);
            Class<?> actionListenerClass = Class.forName("android.net.wifi.WifiManager$ActionListener");
            Object listener = java.lang.reflect.Proxy.newProxyInstance(
                    actionListenerClass.getClassLoader(),
                    new Class<?>[]{actionListenerClass},
                    new java.lang.reflect.InvocationHandler() {
                        @Override
                        public Object invoke(Object proxy, java.lang.reflect.Method method, Object[] args) throws Throwable {
                            String name = method.getName();
                            if ("onSuccess".equals(name)) {
                                answered.countDown();
                            } else if ("onFailure".equals(name)) {
                                if (args != null && args.length > 0 && args[0] instanceof Integer) {
                                    failure.set((Integer) args[0]);
                                }
                                answered.countDown();
                            }
                            return null;
                        }
                    });
            java.lang.reflect.Method connectMethod = WifiManager.class.getMethod("connect", int.class, actionListenerClass);
            connectMethod.invoke(manager(), networkId, listener);
            if (!answered.await(ANSWER_TIMEOUT_MS, TimeUnit.MILLISECONDS)) return Json.put(res, "error", "timeout");
            int reason = failure.get();
            if (reason == Integer.MIN_VALUE) return Json.put(res, "ok", true);
            Json.put(res, "reason", reason);
            // ActionListener.FAILURE_NOT_AUTHORIZED (4): an OEM policy refused the shell — report it like a SecurityException.
            return Json.put(res, "error", reason == 4 ? "permission_denied" : "failed");
        } catch (Throwable t) {
            return failure(res, "connect_saved " + networkId, t);
        }
    }

    /**
     * Leaves the current network FOR GOOD (until the user joins it again). A plain {@code WifiManager.disconnect()} only
     * drops the link: the framework's WifiConnectivityManager answers the "disconnected" state with an immediate
     * connectivity scan and re-joins the best saved network — the same one, a few seconds later. So the button looked
     * broken even though the call succeeded.
     *
     * With the network id ({@code networkId >= 0}) the network is DISABLED instead ({@code WifiManager.disableNetwork},
     * deprecated for ordinary apps, honoured for NETWORK_SETTINGS holders like the shell): the framework disconnects it
     * by itself (ClientModeImpl.onNetworkPermanentlyDisabled) and auto-join no longer considers it. Joining it again —
     * {@link #connectSaved} or the Settings app — re-enables it (WifiConfigManager.updateBeforeConnect).
     *
     * Reply: {@code sticky: true} when the network was disabled; {@code sticky: false} when only the link was dropped
     * (no id, or the framework refused the disable) — the caller says so instead of promising more.
     */
    static JSONObject disconnect(int networkId) {
        JSONObject res = Json.obj("type", "wifi_result", "ok", false, "verb", "disconnect");
        try {
            WifiManager wm = manager();
            if (networkId >= 0) {
                Object disabled = WifiManager.class.getMethod("disableNetwork", int.class).invoke(wm, networkId);
                if (Boolean.TRUE.equals(disabled)) {
                    Json.put(res, "network_id", networkId);
                    Json.put(res, "sticky", true);
                    return Json.put(res, "ok", true);
                }
                Log.warn("Wifi", "disableNetwork " + networkId + " refused — dropping the link only");
            }
            Json.put(res, "sticky", false);
            Object ok = WifiManager.class.getMethod("disconnect").invoke(wm);
            return Boolean.TRUE.equals(ok) ? Json.put(res, "ok", true) : Json.put(res, "error", "refused");
        } catch (Throwable t) {
            return failure(res, "disconnect", t);
        }
    }

    private static JSONObject failure(JSONObject res, String what, Throwable t) {
        Throwable root = t instanceof InvocationTargetException && t.getCause() != null ? t.getCause() : t;
        String code = root instanceof SecurityException ? "permission_denied"
                : "no_system_context".equals(root.getMessage()) || "no_wifi_service".equals(root.getMessage())
                ? root.getMessage() : "failed";
        Log.warn("Wifi", what + ": " + root);
        Json.put(res, "error", code);
        return Json.put(res, "detail", String.valueOf(root.getMessage()));
    }

    private static synchronized WifiManager manager() throws Exception {
        if (manager != null) return manager;
        ShellContext shell = ShellContext.get();
        if (shell == null) throw new IllegalStateException("no_system_context");
        Object service = Binders.service(Context.WIFI_SERVICE, "android.net.wifi.IWifiManager$Stub");
        if (service == null) throw new IllegalStateException("no_wifi_service");
        HandlerThread t = new HandlerThread("OpenDex-Wifi");
        t.setDaemon(true);
        t.start();
        try {
            Class<?> iface = Class.forName("android.net.wifi.IWifiManager");
            manager = WifiManager.class.getConstructor(Context.class, iface, Looper.class)
                    .newInstance(shell, service, t.getLooper());
        } catch (Throwable e) {
            t.quitSafely();
            throw e instanceof Exception ? (Exception) e : new IllegalStateException(e);
        }
        thread = t;
        return manager;
    }
}
