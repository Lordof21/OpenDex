package com.opendex.tools;

import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.List;

/**
 * The phone's CPU counters and the stat line of every process of the given apps, read straight from {@code /proc} —
 * the same text the backend's shell probe (proc_cpu.probe_script) used to build with {@code ps} and one {@code cat}
 * per process, so its parser (proc_cpu.parse_probe) reads this unchanged:
 *
 * <pre>
 * cpu  …            (the aggregate line, then cpu0 … cpuN)
 * P &lt;pid&gt; &lt;name&gt;   (one per process whose name is a given package or "package:suffix")
 * &lt;the process' /proc/&lt;pid&gt;/stat line&gt;
 * </pre>
 *
 * <p>Reading in-process is not only cheaper (no shell, no {@code ps}, no spawn per process): all counters are read
 * within a few milliseconds of each other instead of spread over the 50–300 ms a shell loop takes, which is what the
 * CPU percentages are computed from. Shell uid holds {@code readproc}, the access {@code ps} and {@code top} use.
 *
 * <p>Pure Java; the same code reads this machine's {@code /proc} in the JVM tests.
 */
final class ProcProbe {

    private ProcProbe() {}

    /** @param packages package names (anything that is not a valid Android package name is ignored) */
    static String probe(List<String> packages) {
        return probe(new File("/proc"), packages);
    }

    static String probe(File proc, List<String> packages) {
        StringBuilder out = new StringBuilder(2048);
        String stat = read(new File(proc, "stat"));
        if (stat == null) return "";
        for (String line : stat.split("\n")) {
            if (line.startsWith("cpu")) out.append(line).append('\n');
        }
        File[] entries = proc.listFiles();
        if (entries == null || packages.isEmpty()) return out.toString();
        for (File entry : entries) {
            String pid = entry.getName();
            if (!isDigits(pid)) continue;
            String name = processName(new File(entry, "cmdline"));
            if (name == null || !belongsToAny(name, packages)) continue;
            String statLine = read(new File(entry, "stat"));
            if (statLine == null) continue; // the process ended between the two reads
            out.append("P ").append(pid).append(' ').append(name).append('\n');
            out.append(statLine.trim()).append('\n');
        }
        return out.toString();
    }

    /** {@code name == package} or {@code name} starts with {@code package + ":"} — Android names an app's extra processes so. */
    static boolean belongsToAny(String name, List<String> packages) {
        for (String pkg : packages) {
            if (!isPackageName(pkg)) continue;
            if (name.equals(pkg) || name.startsWith(pkg + ":")) return true;
        }
        return false;
    }

    /** Letters, digits, '_' and '.' — the alphabet of a package name; the backend validates the same way. */
    static boolean isPackageName(String s) {
        if (s == null || s.isEmpty() || s.length() > 255) return false;
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            boolean ok = (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '_' || c == '.';
            if (!ok) return false;
        }
        return true;
    }

    /** The first argument of {@code cmdline} (up to the first NUL) — for an app process, its name. Null when empty. */
    private static String processName(File cmdline) {
        byte[] raw = readBytes(cmdline, 512);
        if (raw == null || raw.length == 0) return null;
        int end = 0;
        while (end < raw.length && raw[end] != 0) end++;
        return end == 0 ? null : new String(raw, 0, end, StandardCharsets.UTF_8);
    }

    private static boolean isDigits(String s) {
        if (s.isEmpty()) return false;
        for (int i = 0; i < s.length(); i++) {
            if (s.charAt(i) < '0' || s.charAt(i) > '9') return false;
        }
        return true;
    }

    private static String read(File f) {
        byte[] bytes = readBytes(f, 64 * 1024);
        return bytes == null ? null : new String(bytes, StandardCharsets.UTF_8);
    }

    private static byte[] readBytes(File f, int max) {
        try (InputStream in = new FileInputStream(f)) {
            byte[] buf = new byte[max];
            int total = 0, n;
            while (total < max && (n = in.read(buf, total, max - total)) > 0) total += n;
            byte[] out = new byte[total];
            System.arraycopy(buf, 0, out, 0, total);
            return out;
        } catch (IOException e) {
            return null; // gone, or not readable for us
        }
    }
}
