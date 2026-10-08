package com.opendex.tools;

import android.content.Context;
import android.os.IBinder;
import android.os.PowerManager;

import org.json.JSONObject;

import java.util.concurrent.Executor;

/**
 * Thermal status pushed by PowerManager instead of the backend polling `dumpsys thermalservice`.
 *
 * {@code PowerManager.addThermalStatusListener} (public, API 29) calls back once with the current status on registration
 * and then on every change; each call is broadcast as
 *   thermal_update {ok, status (PowerManager.THERMAL_STATUS_*: 0 none … 6 shutdown), temps {soc, gpu, battery, skin}}.
 * Temperatures are the thermal HAL's CURRENT readings ({@code IThermalService.getCurrentTemperatures}, DEVICE_POWER —
 * granted to shell): ~10 ms in-process, where the dump took a fork of `dumpsys` and a full service dump.
 */
final class ThermalEvents {

    // android.os.Temperature.TYPE_* → the roles the backend shows (0 CPU and 13 SOC both count as "soc", hottest wins).
    private static final String[] ROLE_BY_TYPE = new String[14];
    static {
        ROLE_BY_TYPE[0] = "soc";
        ROLE_BY_TYPE[1] = "gpu";
        ROLE_BY_TYPE[2] = "battery";
        ROLE_BY_TYPE[3] = "skin";
        ROLE_BY_TYPE[13] = "soc";
    }

    private static volatile boolean registered;
    private static volatile int lastStatus = -1;

    private ThermalEvents() {}

    static boolean isRegistered() {
        return registered;
    }

    static synchronized void start(Executor executor) {
        if (registered) return;
        try {
            Context ctx = SystemContext.get();
            PowerManager pm = ctx != null ? (PowerManager) ctx.getSystemService(Context.POWER_SERVICE) : null;
            if (pm == null) throw new IllegalStateException("PowerManager unavailable");
            pm.addThermalStatusListener(executor, status -> {
                lastStatus = status;
                OpenDexDaemon.broadcastEvent(snapshotJson(status));
            });
            registered = true;
            Log.info("ThermalEvents", "thermal status listener registered (push mode)");
        } catch (Throwable t) {
            registered = false;
            Log.warn("ThermalEvents", "thermal status listener unavailable: " + Json.reason(t));
        }
    }

    /** thermal_update with the current status and temperatures (the thermal_get reply, and every push). */
    static JSONObject snapshotJson() {
        int status = lastStatus;
        if (status < 0) {
            try {
                Context ctx = SystemContext.get();
                PowerManager pm = ctx != null ? (PowerManager) ctx.getSystemService(Context.POWER_SERVICE) : null;
                if (pm != null) status = pm.getCurrentThermalStatus();
            } catch (Throwable ignored) {}
        }
        return snapshotJson(status);
    }

    private static JSONObject snapshotJson(int status) {
        JSONObject res = Json.obj("type", "thermal_update", "ok", status >= 0, "push", registered);
        if (status >= 0) Json.put(res, "status", status);
        else Json.put(res, "error", "thermal_status_unavailable");
        Json.put(res, "temps", temperatures());
        return res;
    }

    /** Role → °C of the hottest current HAL sensor per role; empty when the HAL cannot be read. */
    static JSONObject temperatures() {
        JSONObject out = new JSONObject();
        try {
            Object binder = Class.forName("android.os.ServiceManager").getMethod("getService", String.class)
                    .invoke(null, "thermalservice");
            if (!(binder instanceof IBinder)) return out;
            Object service = Class.forName("android.os.IThermalService$Stub").getMethod("asInterface", IBinder.class)
                    .invoke(null, binder);
            Object[] temps = (Object[]) service.getClass().getMethod("getCurrentTemperatures").invoke(service);
            if (temps == null) return out;
            for (Object t : temps) {
                Class<?> c = t.getClass();
                int type = (Integer) c.getMethod("getType").invoke(t);
                float value = (Float) c.getMethod("getValue").invoke(t);
                String role = type >= 0 && type < ROLE_BY_TYPE.length ? ROLE_BY_TYPE[type] : null;
                if (role == null || Float.isNaN(value) || value < -30f || value > 150f) continue;
                double rounded = Math.round(value * 10.0) / 10.0;
                if (!out.has(role) || out.optDouble(role) < rounded) Json.put(out, role, rounded);
            }
        } catch (Throwable t) {
            Log.warn("ThermalEvents", "HAL temperatures unreadable: " + Json.reason(t));
        }
        return out;
    }
}
