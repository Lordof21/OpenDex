package com.opendex.tools;

import android.bluetooth.BluetoothAdapter;
import android.bluetooth.BluetoothClass;
import android.bluetooth.BluetoothDevice;
import android.bluetooth.BluetoothManager;
import android.content.AttributionSource;
import android.content.Context;
import android.os.Build;
import android.os.ParcelUuid;

import org.json.JSONArray;
import org.json.JSONObject;

import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Method;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;

/**
 * Bonded devices, connection state, battery; connect / disconnect / forget.
 *
 * The shell holds BLUETOOTH_CONNECT / BLUETOOTH_PRIVILEGED / MODIFY_PHONE_STATE; the one real requirement is the
 * caller identity: Android 12+ checks that the AttributionSource package belongs to the calling uid, so the adapter
 * is BUILT with {@link ShellContext} (getSystemService() on a wrapper would use the system context's "android").
 * Devices obtained from that adapter inherit its AttributionSource.
 *
 * Every reply is a JSON object with ok + a machine-readable error code — never a raw exception — so the UI can hide a
 * control that this device refuses (permission_denied) instead of failing on every tap.
 */
final class Bluetooth {

    private static BluetoothAdapter adapter;

    private Bluetooth() {}

    static JSONObject list() {
        JSONObject res = Json.obj("type", "bt_list", "ok", true);
        try {
            BluetoothAdapter a = adapter();
            boolean enabled = a.isEnabled();
            Json.put(res, "enabled", enabled);
            Json.put(res, "name", safe(a::getName));
            List<JSONObject> devices = new ArrayList<>();
            if (enabled) {
                for (BluetoothDevice d : a.getBondedDevices()) devices.add(deviceJson(d));
            }
            // Connected first, then by name — the order the phone's own settings use.
            Collections.sort(devices, (x, y) -> {
                boolean cx = x.optBoolean("connected"), cy = y.optBoolean("connected");
                if (cx != cy) return cx ? -1 : 1;
                return x.optString("name").compareToIgnoreCase(y.optString("name"));
            });
            return Json.put(res, "devices", new JSONArray(devices));
        } catch (Throwable t) {
            return failure(res, t);
        }
    }

    static JSONObject action(String verb, String address) {
        JSONObject res = Json.obj("type", "bt_result", "ok", false, "verb", verb, "address", address);
        if (address == null || !BluetoothAdapter.checkBluetoothAddress(address)) return Json.put(res, "error", "bad_address");
        try {
            BluetoothDevice d = adapter().getRemoteDevice(address);
            switch (verb) {
                case "connect":
                case "disconnect": {
                    // BluetoothDevice.connect()/disconnect() are @SystemApi since API 33 (BluetoothStatusCodes).
                    if (Build.VERSION.SDK_INT < 33) return Json.put(res, "error", "unsupported_api");
                    Object code = d.getClass().getMethod(verb).invoke(d);
                    int status = code instanceof Integer ? (Integer) code : -1;
                    Json.put(res, "status", status);
                    return Json.put(res, "ok", status == 0);
                }
                case "forget": {
                    Object ok = d.getClass().getMethod("removeBond").invoke(d);
                    return Json.put(res, "ok", Boolean.TRUE.equals(ok));
                }
                default:
                    return Json.put(res, "error", "bad_verb");
            }
        } catch (Throwable t) {
            return failure(res, t);
        }
    }

    // ---------------------------------------------------------------- internals

    /** BluetoothManager(Context) is @hide but public; fallback: the hidden static createAdapter(AttributionSource). */
    private static synchronized BluetoothAdapter adapter() throws Exception {
        if (adapter != null) return adapter;
        ShellContext shell = ShellContext.get();
        if (shell == null) throw new IllegalStateException("no_system_context");
        ensureServiceManager();
        BluetoothAdapter a = null;
        try {
            BluetoothManager bm = BluetoothManager.class.getConstructor(Context.class).newInstance(shell);
            a = bm.getAdapter();
        } catch (NoSuchMethodException e) {
            if (Build.VERSION.SDK_INT >= 31) {
                Method create = BluetoothAdapter.class.getMethod("createAdapter", AttributionSource.class);
                a = (BluetoothAdapter) create.invoke(null, shell.getAttributionSource());
            }
        }
        if (a == null) throw new IllegalStateException("no_adapter");
        adapter = a;
        return a;
    }

    /**
     * Android 13+ builds every adapter through the service manager that BluetoothFrameworkInitializer receives during
     * a normal app's startup. A bare app_process (this daemon) never ran that, so createAdapter() returned null and
     * bt_list answered "no_adapter" (verified on HyperOS / Android 16). Registering it here is what the framework
     * itself does; the adapter also needs the main Looper, which SystemContext prepares.
     */
    private static void ensureServiceManager() {
        try {
            Class<?> init = Class.forName("android.bluetooth.BluetoothFrameworkInitializer");
            if (init.getMethod("getBluetoothServiceManager").invoke(null) != null) return;
            Class<?> manager = Class.forName("android.os.BluetoothServiceManager");
            init.getMethod("setBluetoothServiceManager", manager).invoke(null, manager.getConstructor().newInstance());
        } catch (Throwable ignored) {
            // Android 12 and older: no initializer — the adapter reaches the service directly.
        }
    }

    private static JSONObject deviceJson(BluetoothDevice d) {
        String name = safe(d::getAlias);
        if (name == null || name.isEmpty()) name = safe(d::getName);
        int battery = callInt(d, "getBatteryLevel");
        return Json.obj(
                "address", d.getAddress(),
                "name", name,
                "kind", kind(safeClass(d)),
                "connected", callBool(d, "isConnected"),
                "battery", battery >= 0 && battery <= 100 ? battery : -1,    // -1: unknown / not reported
                "profiles", new JSONArray(profiles(d)));
    }

    /**
     * The services the device ADVERTISES (SDP / GATT UUIDs cached at pairing) — "media" (A2DP sink / LE Audio),
     * "call" (hands-free / headset), "input" (HID). Which of them is connected right now would need a profile proxy
     * per profile (not done yet); isConnected() already says whether any is.
     */
    private static List<String> profiles(BluetoothDevice d) {
        Set<String> out = new LinkedHashSet<>();
        ParcelUuid[] uuids;
        try {
            uuids = d.getUuids();
        } catch (Throwable t) {
            uuids = null;
        }
        if (uuids == null) return new ArrayList<>(out);
        for (ParcelUuid u : uuids) {
            if (u == null || u.getUuid() == null) continue;
            long shortId = u.getUuid().getMostSignificantBits() >>> 32;
            if (shortId == 0x110B || shortId == 0x110D || shortId == 0x184E || shortId == 0x1850) out.add("media");
            else if (shortId == 0x111E || shortId == 0x1108) out.add("call");
            else if (shortId == 0x1124 || shortId == 0x1812) out.add("input");
        }
        return new ArrayList<>(out);
    }

    private static String kind(BluetoothClass c) {
        if (c == null) return "other";
        switch (c.getMajorDeviceClass()) {
            case BluetoothClass.Device.Major.AUDIO_VIDEO: {
                int dev = c.getDeviceClass();
                if (dev == BluetoothClass.Device.AUDIO_VIDEO_CAR_AUDIO) return "car";
                if (dev == BluetoothClass.Device.AUDIO_VIDEO_LOUDSPEAKER
                        || dev == BluetoothClass.Device.AUDIO_VIDEO_PORTABLE_AUDIO
                        || dev == BluetoothClass.Device.AUDIO_VIDEO_HIFI_AUDIO) return "speaker";
                return "headphones";
            }
            case BluetoothClass.Device.Major.WEARABLE: return "watch";
            case BluetoothClass.Device.Major.PHONE: return "phone";
            case BluetoothClass.Device.Major.COMPUTER: return "computer";
            case BluetoothClass.Device.Major.PERIPHERAL: return "input";
            default: return "other";
        }
    }

    private static BluetoothClass safeClass(BluetoothDevice d) {
        try {
            return d.getBluetoothClass();
        } catch (Throwable t) {
            return null;
        }
    }

    private static boolean callBool(Object o, String name) {
        try {
            return Boolean.TRUE.equals(o.getClass().getMethod(name).invoke(o));
        } catch (Throwable t) {
            return false;
        }
    }

    private static int callInt(Object o, String name) {
        try {
            Object v = o.getClass().getMethod(name).invoke(o);
            return v instanceof Integer ? (Integer) v : -1;
        } catch (Throwable t) {
            return -1;
        }
    }

    private static JSONObject failure(JSONObject res, Throwable t) {
        Throwable root = t instanceof InvocationTargetException && t.getCause() != null ? t.getCause() : t;
        String code;
        if (root instanceof SecurityException) code = "permission_denied";
        else if ("no_system_context".equals(root.getMessage()) || "no_adapter".equals(root.getMessage())) code = root.getMessage();
        else code = "failed";
        Log.warn("Bluetooth", res.optString("type") + " " + res.optString("verb") + ": " + root);
        Json.put(res, "ok", false);
        Json.put(res, "error", code);
        return Json.put(res, "detail", String.valueOf(root.getMessage()));
    }

    private interface Getter {
        String get() throws Exception;
    }

    private static String safe(Getter g) {
        try {
            return g.get();
        } catch (Throwable t) {
            return null;
        }
    }
}
