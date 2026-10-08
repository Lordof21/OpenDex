package com.opendex.tools;

import java.util.HashMap;
import java.util.Map;

/**
 * The pure text readers behind {@code battery_health} — no Android types, so they run (and are tested) on a plain JVM.
 * Everything here turns the text a phone prints (`dumpsys battery`, a power_supply `uevent`) into plain values; what the
 * numbers MEAN (health, ETA, a charger's class) is the backend's job (device/battery_health.py).
 *
 * Nothing is guessed: a value that is not in the text comes back as the documented "unknown" (-1 / null), never as a
 * plausible-looking default.
 */
final class BatteryFacts {

    private BatteryFacts() {}

    /** "  level: 80" lines → {level: "80", …}. The FIRST occurrence of a key wins (the first block of the dump is the live one). */
    static Map<String, String> colonFields(String dump) {
        Map<String, String> f = new HashMap<>();
        if (dump == null) return f;
        for (String line : dump.split("\n")) {
            int colon = line.indexOf(':');
            if (colon <= 0) continue;
            String key = line.substring(0, colon).trim();
            if (!f.containsKey(key)) f.put(key, line.substring(colon + 1).trim());
        }
        return f;
    }

    /** "POWER_SUPPLY_NAME=mt6375-gauge" lines → {NAME: "mt6375-gauge"} (the POWER_SUPPLY_ prefix is dropped). */
    static Map<String, String> uevent(String text) {
        Map<String, String> u = new HashMap<>();
        if (text == null) return u;
        for (String line : text.split("\n")) {
            int eq = line.indexOf('=');
            if (eq <= 0) continue;
            String key = line.substring(0, eq).trim();
            if (key.startsWith("POWER_SUPPLY_")) key = key.substring("POWER_SUPPLY_".length());
            u.put(key, line.substring(eq + 1).trim());
        }
        return u;
    }

    /**
     * The kernel lists every USB type the port can be and brackets the one in use: "Unknown [SDP] CDP DCP" → "SDP"
     * (a PC's port); "Unknown SDP CDP [DCP]" → "DCP" (a wall charger). null when none is bracketed.
     */
    static String activeUsbType(String usbTypes) {
        if (usbTypes == null) return null;
        int open = usbTypes.indexOf('[');
        int close = open < 0 ? -1 : usbTypes.indexOf(']', open);
        if (close <= open + 1) return null;
        return usbTypes.substring(open + 1, close).trim();
    }

    /**
     * When the battery was first used — what the vendor's battery service prints. Xiaomi's:
     * {@code mNtpTime=1758535122427} (epoch ms, when known) and {@code mParseNtpTime=20250922} (the same day, yyyymmdd).
     * The exact one wins; the day alone is taken as that day's midnight UTC. -1: not in the text.
     */
    static long firstUsageMs(String dump) {
        if (dump == null) return -1;
        long ntp = valueAfter(dump, "mNtpTime=");
        if (ntp > 1_000_000_000_000L) return ntp;
        long day = valueAfter(dump, "mParseNtpTime=");
        if (day < 19_700_101L || day > 99_991_231L) return -1;
        return utcMidnightMs((int) (day / 10_000), (int) (day / 100 % 100), (int) (day % 100));
    }

    private static long valueAfter(String text, String marker) {
        int at = text.indexOf(marker);
        if (at < 0) return -1;
        int start = at + marker.length();
        int end = start;
        while (end < text.length() && Character.isDigit(text.charAt(end))) end++;
        return end > start ? parseLong(text.substring(start, end), -1) : -1;
    }

    /** Days-from-civil (Howard Hinnant's algorithm): no java.time, so it also runs on the oldest phone the daemon supports. */
    private static long utcMidnightMs(int year, int month, int day) {
        if (month < 1 || month > 12 || day < 1 || day > 31) return -1;
        int y = month <= 2 ? year - 1 : year;
        int era = (y >= 0 ? y : y - 399) / 400;
        int yoe = y - era * 400;
        int doy = (153 * (month + (month > 2 ? -3 : 9)) + 2) / 5 + day - 1;
        int doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
        long days = (long) era * 146_097 + doe - 719_468;
        return days * 86_400_000L;
    }

    static long parseLong(String v, long fallback) {
        if (v == null || v.trim().isEmpty()) return fallback;
        try { return Long.parseLong(v.trim()); } catch (NumberFormatException e) { return fallback; }
    }

    static int parseInt(String v, int fallback) {
        long n = parseLong(v, Long.MIN_VALUE);
        return n < Integer.MIN_VALUE || n > Integer.MAX_VALUE ? fallback : (int) n;
    }
}
