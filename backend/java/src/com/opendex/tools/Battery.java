package com.opendex.tools;

import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.os.BatteryManager;

import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.File;
import java.io.FileReader;
import java.util.HashMap;
import java.util.Map;

/**
 * Battery state for the {@code battery_update} push and the load probe.
 *
 * Primary source: the battery service's own dump read in-process ({@link BinderDump}) — the same text `dumpsys battery`
 * prints (the one reading proven on every Android version/OEM tested), without forking `sh` + `dumpsys` every few
 * seconds. The current comes from {@link BatteryManager} (vendor SELinux denies the sysfs file to shell on HyperOS).
 * `status` keeps the original BatteryManager int contract (2=CHARGING, 3=DISCHARGING, 5=FULL…) — the backend asserts it.
 */
final class Battery {

    private static final long DUMP_TIMEOUT_MS = 1500;
    private static String ueventPath;   // sysfs fallback tier, resolved once by init()

    private Battery() {}

    /** Finds a sysfs battery node for the last-resort tier (SELinux blocks it for shell on some ROMs). */
    static void init() {
        File[] nodes = new File("/sys/class/power_supply/").listFiles();
        if (nodes == null) return;
        for (File node : nodes) {
            File uevent = new File(node, "uevent");
            if (!uevent.canRead()) continue;
            try (BufferedReader br = new BufferedReader(new FileReader(uevent))) {
                String line;
                while ((line = br.readLine()) != null) {
                    if (line.startsWith("POWER_SUPPLY_TYPE=Battery") || line.startsWith("POWER_SUPPLY_CAPACITY=")) {
                        ueventPath = uevent.getAbsolutePath();
                        Log.info("Battery", "sysfs fallback tier: " + ueventPath);
                        return;
                    }
                }
            } catch (Throwable ignored) {}
        }
    }

    /** The `dumpsys battery` text: in-process dump first, the forked command only if that failed. */
    private static String serviceDump() {
        try {
            String out = BinderDump.dump("battery", null, DUMP_TIMEOUT_MS);
            if (out.contains("level:")) return out;
        } catch (Throwable t) {
            Log.warn("Battery", "in-process dump failed, forking dumpsys: " + Json.reason(t));
        }
        return OpenDexDaemon.execCommand("dumpsys battery");
    }

    static JSONObject updateJson() {
        JSONObject res = new JSONObject();
        try {
            String out = serviceDump();
            if (out != null && out.contains("level:")) {
                Map<String, String> f = BatteryFacts.colonFields(out);
                int status = BatteryFacts.parseInt(f.get("status"), 1);
                return res.put("type", "battery_update").put("ok", true)
                        .put("level", BatteryFacts.parseInt(f.get("level"), 100)).put("scale", BatteryFacts.parseInt(f.get("scale"), 100))
                        .put("status", status) // int — original BatteryManager contract, backend tests assert this
                        .put("is_charging", status == 2 || status == 5)
                        .put("charging_type", chargingType(f))
                        .put("health", BatteryFacts.parseInt(f.get("health"), 2) == 2 ? "GOOD" : "OVERHEAT")
                        .put("technology", f.containsKey("technology") ? f.get("technology") : "Li-ion")
                        .put("temperature_c", BatteryFacts.parseInt(f.get("temperature"), 0) / 10.0)
                        .put("voltage_mv", BatteryFacts.parseInt(f.get("voltage"), 0));
            }
            JSONObject sysfs = fromSysfs();
            if (sysfs != null) return sysfs;
            JSONObject sticky = fromStickyBroadcast();
            if (sticky != null) return sticky;
            return res.put("type", "battery_update").put("ok", false).put("error", "all_battery_sources_failed");
        } catch (Throwable t) {
            return Json.error("battery_update", t);
        }
    }

    /**
     * What the load probe needs: {level, status ("Charging"…), charging, current_ua (signed as the device reports it),
     * voltage_mv, temp_c}. Missing values are absent, never guessed.
     */
    static JSONObject reading() {
        JSONObject r = new JSONObject();
        JSONObject u = updateJson();
        if (u.optBoolean("ok", false)) {
            int status = u.optInt("status", 1);
            Json.put(r, "level", u.optInt("level"));
            Json.put(r, "status", statusName(status));
            Json.put(r, "charging", status == 2 || status == 5);
            Json.put(r, "plugged", u.optString("charging_type", "NONE"));
            if (u.optInt("voltage_mv", 0) > 0) Json.put(r, "voltage_mv", u.optInt("voltage_mv"));
            if (u.optDouble("temperature_c", 0) != 0) Json.put(r, "temp_c", u.optDouble("temperature_c"));
        }
        try {
            Context ctx = SystemContext.get();
            BatteryManager bm = ctx != null ? (BatteryManager) ctx.getSystemService(Context.BATTERY_SERVICE) : null;
            if (bm != null) {
                int current = bm.getIntProperty(BatteryManager.BATTERY_PROPERTY_CURRENT_NOW);
                // Integer.MIN_VALUE = unsupported; 0 on a phone that does not measure it is just as unknown.
                if (current != Integer.MIN_VALUE && current != 0) Json.put(r, "current_ua", current);
                if (!r.has("level")) {
                    int level = bm.getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY);
                    if (level != Integer.MIN_VALUE) Json.put(r, "level", level);
                }
            }
        } catch (Throwable t) {
            Json.put(r, "current_error", Json.reason(t));
        }
        return r;
    }

    private static String statusName(int status) {
        switch (status) {
            case 2: return "Charging";
            case 3: return "Discharging";
            case 4: return "Not charging";
            case 5: return "Full";
            default: return "Unknown";
        }
    }

    private static String chargingType(Map<String, String> f) {
        if ("true".equals(f.get("AC powered"))) return "AC";
        if ("true".equals(f.get("USB powered"))) return "USB";
        if ("true".equals(f.get("Wireless powered"))) return "WIRELESS";
        return "NONE";
    }

    private static JSONObject fromSysfs() throws Exception {
        if (ueventPath == null) return null;
        Map<String, String> u = new HashMap<>();
        try (BufferedReader br = new BufferedReader(new FileReader(ueventPath))) {
            String line;
            while ((line = br.readLine()) != null) {
                int idx = line.indexOf('=');
                if (idx > 0) u.put(line.substring(0, idx).trim(), line.substring(idx + 1).trim());
            }
        } catch (Throwable ignored) {
            return null;
        }
        if (!u.containsKey("POWER_SUPPLY_CAPACITY")) return null;
        String statusStr = u.containsKey("POWER_SUPPLY_STATUS") ? u.get("POWER_SUPPLY_STATUS") : "Discharging";
        boolean charging = "Charging".equalsIgnoreCase(statusStr) || "Full".equalsIgnoreCase(statusStr);
        return new JSONObject().put("type", "battery_update").put("ok", true)
                .put("level", BatteryFacts.parseInt(u.get("POWER_SUPPLY_CAPACITY"), 100)).put("scale", 100)
                .put("status", "Full".equalsIgnoreCase(statusStr) ? 5 : (charging ? 2 : 3)).put("is_charging", charging)
                .put("charging_type", "NONE")
                .put("health", u.containsKey("POWER_SUPPLY_HEALTH") ? u.get("POWER_SUPPLY_HEALTH") : "GOOD")
                .put("technology", u.containsKey("POWER_SUPPLY_TECHNOLOGY") ? u.get("POWER_SUPPLY_TECHNOLOGY") : "Li-ion")
                .put("temperature_c", BatteryFacts.parseInt(u.get("POWER_SUPPLY_TEMP"), 0) / 10.0)
                .put("voltage_mv", BatteryFacts.parseInt(u.get("POWER_SUPPLY_VOLTAGE_NOW"), 0) / 1000);
    }

    private static JSONObject fromStickyBroadcast() throws Exception {
        Context ctx = SystemContext.get();
        Intent b = ctx != null ? ctx.registerReceiver(null, new IntentFilter(Intent.ACTION_BATTERY_CHANGED)) : null;
        if (b == null) return null;
        int status = b.getIntExtra("status", 1);
        return new JSONObject().put("type", "battery_update").put("ok", true)
                .put("level", b.getIntExtra("level", 100)).put("scale", b.getIntExtra("scale", 100))
                .put("status", status).put("is_charging", status == 2 || status == 5)
                .put("charging_type", "NONE")
                .put("health", b.getIntExtra("health", 2) == 2 ? "GOOD" : "OVERHEAT")
                .put("technology", b.getStringExtra("technology"))
                .put("temperature_c", b.getIntExtra("temperature", 0) / 10.0)
                .put("voltage_mv", b.getIntExtra("voltage", 0));
    }

    // ------------------------------------------------------------------ battery_health (the Battery page)

    /** µA/µAh/… values the vendor reports as "unknown" (0, negative, Integer.MIN_VALUE) are left out of the answer. */
    private static void putPositive(JSONObject r, String key, long value) {
        if (value > 0 && value != Integer.MIN_VALUE) Json.put(r, key, value);
    }

    private static volatile boolean designTried;
    private static volatile double designMah = -1;

    /** The phone's rated capacity (mAh) from the framework's own power profile (the figure `dumpsys batterystats` prints as "Capacity:"). */
    private static double designCapacityMah(Context ctx) {
        if (designTried) return designMah;
        designTried = true;
        try {
            Class<?> profile = Class.forName("com.android.internal.os.PowerProfile");
            Object p = profile.getConstructor(Context.class).newInstance(ctx);
            double mah = ((Number) profile.getMethod("getBatteryCapacity").invoke(p)).doubleValue();
            if (mah > 100 && mah < 100_000) designMah = mah;
        } catch (Throwable t) {
            Log.warn("Battery", "power profile unavailable: " + Json.reason(t));
        }
        return designMah;
    }

    private static String systemProperty(String key) {
        try {
            Class<?> sp = Class.forName("android.os.SystemProperties");
            return (String) sp.getMethod("get", String.class, String.class).invoke(null, key, "");
        } catch (Throwable t) {
            return "";
        }
    }

    /**
     * Everything the Battery page needs that the 5-second {@code battery_update} push does not carry — raw FACTS with their
     * units, each present only when this phone reports it (the backend decides what they mean; nothing is defaulted here):
     * <pre>
     *   now:      level, status, plugged, voltage_mv, temp_c, current_ua (BatteryManager, signed as the vendor reports),
     *             charge_counter_uah, max_current_ua / max_voltage_uv (what the port may supply), usb_type (SDP/CDP/DCP…)
     *   health:   soh_pct (Android 14+ health HAL), cycle_count, first_use_ms, manufactured_ms, charge_full_uah /
     *             charge_full_design_uah, energy_full / energy_full_design (unit varies: only their ratio means anything),
     *             design_mah (power profile)
     *   protect:  charging_policy (Android 14+), vendor: {key: bool} (Xiaomi health-optimise flags)
     * </pre>
     */
    static JSONObject health() {
        JSONObject r = new JSONObject();
        try {
            Json.put(r, "type", "battery_health");
            Json.put(r, "ok", true);
            Context ctx = SystemContext.get();

            // 1. The battery service's own dump (live values, the port's limits, the vendor's first-use line).
            String dump = serviceDump();
            if (dump != null && dump.contains("level:")) {
                Map<String, String> f = BatteryFacts.colonFields(dump);
                Json.put(r, "level", BatteryFacts.parseInt(f.get("level"), -1));
                Json.put(r, "status", BatteryFacts.parseInt(f.get("status"), 1));
                Json.put(r, "plugged", chargingType(f));
                putPositive(r, "voltage_mv", BatteryFacts.parseInt(f.get("voltage"), 0));
                int tenths = BatteryFacts.parseInt(f.get("temperature"), 0);
                if (tenths > 0) Json.put(r, "temp_c", tenths / 10.0);
                putPositive(r, "max_current_ua", BatteryFacts.parseLong(f.get("Max charging current"), 0));
                putPositive(r, "max_voltage_uv", BatteryFacts.parseLong(f.get("Max charging voltage"), 0));
                putPositive(r, "charge_counter_uah", BatteryFacts.parseLong(f.get("Charge counter"), 0));
                putPositive(r, "charging_policy", BatteryFacts.parseLong(f.get("Charging policy"), 0));
                long firstUse = BatteryFacts.firstUsageMs(dump);
                if (firstUse > 0) Json.put(r, "first_use_ms", firstUse);
            }

            // 2. BatteryManager: the live current, and what Android 14+ reports itself (health %, dates, policy).
            if (ctx != null) {
                try {
                    BatteryManager bm = (BatteryManager) ctx.getSystemService(Context.BATTERY_SERVICE);
                    if (bm != null) {
                        int current = bm.getIntProperty(BatteryManager.BATTERY_PROPERTY_CURRENT_NOW);
                        if (current != Integer.MIN_VALUE && current != 0) Json.put(r, "current_ua", current);
                        if (!r.has("charge_counter_uah")) {
                            putPositive(r, "charge_counter_uah", bm.getIntProperty(BatteryManager.BATTERY_PROPERTY_CHARGE_COUNTER));
                        }
                        // Properties added in Android 14: an older framework answers MIN_VALUE (or throws) — both mean "unknown".
                        int soh = safeInt(bm, 10);        // BATTERY_PROPERTY_STATE_OF_HEALTH (percent)
                        if (soh > 0 && soh <= 100) Json.put(r, "soh_pct", soh);
                        long manufactured = safeLong(bm, 7);   // BATTERY_PROPERTY_MANUFACTURING_DATE (s since epoch)
                        long firstUsed = safeLong(bm, 8);      // BATTERY_PROPERTY_FIRST_USAGE_DATE
                        if (manufactured > 0) Json.put(r, "manufactured_ms", manufactured * 1000L);
                        if (firstUsed > 0) Json.put(r, "first_use_ms", firstUsed * 1000L);          // the platform's own date wins
                        int policy = safeInt(bm, 9);      // BATTERY_PROPERTY_CHARGING_POLICY
                        if (policy > 0) Json.put(r, "charging_policy", policy);
                    }
                } catch (Throwable t) {
                    Json.put(r, "battery_manager_error", Json.reason(t));
                }
                try {
                    Intent sticky = ctx.registerReceiver(null, new IntentFilter(Intent.ACTION_BATTERY_CHANGED));
                    int cycles = sticky == null ? -1 : sticky.getIntExtra("android.os.extra.CYCLE_COUNT", -1);   // Android 14+
                    if (cycles > 0) Json.put(r, "cycle_count", cycles);
                } catch (Throwable ignored) {}
                double design = designCapacityMah(ctx);
                if (design > 0) Json.put(r, "design_mah", Math.round(design));
            }

            // 3. The kernel's power supplies: the fuel gauge's full / design capacity and cycle count, the port's USB type.
            scanPowerSupplies(r);

            // 4. Vendor protection flags (Xiaomi's "battery health optimise" / night charge): reported as the SETTING, not as proof the limit is biting now.
            JSONObject vendor = new JSONObject();
            for (String key : new String[] {"persist.vendor.battery.health.optimise", "persist.vendor.battery.health",
                    "persist.vendor.night.charge"}) {
                String v = systemProperty(key);
                if (!v.isEmpty()) Json.put(vendor, key.substring("persist.vendor.".length()), "true".equalsIgnoreCase(v));
            }
            if (vendor.length() > 0) Json.put(r, "vendor", vendor);
        } catch (Throwable t) {
            return Json.error("battery_health", t);
        }
        return r;
    }

    private static int safeInt(BatteryManager bm, int property) {
        try { return bm.getIntProperty(property); } catch (Throwable t) { return Integer.MIN_VALUE; }
    }

    private static long safeLong(BatteryManager bm, int property) {
        try { return bm.getLongProperty(property); } catch (Throwable t) { return Long.MIN_VALUE; }
    }

    /** Reads every readable /sys/class/power_supply/&#42;/uevent: the battery/gauge nodes and the port's USB type. */
    private static void scanPowerSupplies(JSONObject r) {
        File[] nodes = new File("/sys/class/power_supply/").listFiles();
        if (nodes == null) return;
        for (File node : nodes) {
            Map<String, String> u = readUevent(new File(node, "uevent"));
            if (u.isEmpty()) continue;
            String type = u.get("TYPE");
            boolean batteryLike = "Battery".equalsIgnoreCase(type) || node.getName().contains("gauge");
            if (batteryLike) {
                // First node that reports a value wins: the "battery" node outranks a vendor gauge by listing order only.
                putIfAbsent(r, "charge_full_uah", BatteryFacts.parseLong(u.get("CHARGE_FULL"), 0));
                putIfAbsent(r, "charge_full_design_uah", BatteryFacts.parseLong(u.get("CHARGE_FULL_DESIGN"), 0));
                putIfAbsent(r, "energy_full", BatteryFacts.parseLong(u.get("ENERGY_FULL"), 0));
                putIfAbsent(r, "energy_full_design", BatteryFacts.parseLong(u.get("ENERGY_FULL_DESIGN"), 0));
                putIfAbsent(r, "cycle_count", BatteryFacts.parseLong(u.get("CYCLE_COUNT"), 0));
            }
            String usb = BatteryFacts.activeUsbType(u.get("USB_TYPE"));
            if (usb != null && !r.has("usb_type") && !"Unknown".equalsIgnoreCase(usb)) Json.put(r, "usb_type", usb);
        }
    }

    private static void putIfAbsent(JSONObject r, String key, long value) {
        if (!r.has(key)) putPositive(r, key, value);
    }

    private static Map<String, String> readUevent(File uevent) {
        if (!uevent.canRead()) return new HashMap<>();
        StringBuilder sb = new StringBuilder();
        try (BufferedReader br = new BufferedReader(new FileReader(uevent))) {
            String line;
            while ((line = br.readLine()) != null && sb.length() < 16_384) sb.append(line).append('\n');
        } catch (Throwable ignored) {
            return new HashMap<>();
        }
        return BatteryFacts.uevent(sb.toString());
    }
}
