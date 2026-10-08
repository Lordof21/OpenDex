package com.opendex.tools;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.FileInputStream;
import java.nio.charset.StandardCharsets;

/**
 * The Telefon Yükü probe inside the daemon: plain file reads and two binder calls, instead of the backend forking an
 * `adb shell` script every 5 s (and `ps | grep` for discovery). Classification of processes stays in the backend —
 * this only reports what it read.
 *
 *   load_sample <pid,pid,…|->  → {cpu:[user,nice,system,idle,iowait,irq,softirq,steal], pids:{pid:[ticks,start]},
 *                                 freq_khz:[…], gpu, temps:{role:°C}, battery:{…}, ncpu, took_ms}
 *   proc_scan <marker,marker,…> → {procs:[{pid, args}]} for every process whose command line contains a marker
 */
final class LoadProbe {

    private static final String[] GPU_FILES = {
            "/sys/kernel/ged/hal/gpu_utilization",           // MediaTek
            "/sys/class/kgsl/kgsl-3d0/gpu_busy_percentage",  // Qualcomm Adreno
    };
    private static final int MAX_PIDS = 64;
    private static final int MAX_ARGS = 256;

    private LoadProbe() {}

    static JSONObject sample(String pidList) {
        long started = System.nanoTime();
        JSONObject res = Json.obj("type", "load_sample", "ok", true);
        String stat = firstLine("/proc/stat");
        if (stat != null && stat.startsWith("cpu ")) {
            JSONArray cpu = new JSONArray();
            String[] parts = stat.trim().split("\\s+");
            for (int i = 1; i < parts.length && i <= 8; i++) cpu.put(parseLong(parts[i]));
            Json.put(res, "cpu", cpu);
        }
        JSONObject pids = new JSONObject();
        int count = 0;
        for (String token : pidList == null ? new String[0] : pidList.split(",")) {
            if (count++ >= MAX_PIDS) break;
            String pid = token.trim();
            if (!pid.matches("\\d{1,7}")) continue;
            long[] fields = procStat(pid);
            if (fields != null) Json.put(pids, pid, new JSONArray().put(fields[0]).put(fields[1]));
        }
        Json.put(res, "pids", pids);
        Json.put(res, "freq_khz", frequencies());
        Double gpu = gpuUtil();
        if (gpu != null) Json.put(res, "gpu", gpu);
        Json.put(res, "temps", ThermalEvents.temperatures());
        Json.put(res, "battery", Battery.reading());
        Json.put(res, "ncpu", Runtime.getRuntime().availableProcessors());
        Json.put(res, "took_ms", (System.nanoTime() - started) / 1_000_000);
        return res;
    }

    static JSONObject scan(String markerList) {
        JSONObject res = Json.obj("type", "proc_scan", "ok", true);
        String[] markers = markerList == null ? new String[0] : markerList.split(",");
        JSONArray procs = new JSONArray();
        File[] entries = new File("/proc").listFiles();
        if (entries == null) return Json.put(Json.put(res, "ok", false), "error", "proc_unreadable");
        for (File dir : entries) {
            String name = dir.getName();
            if (name.isEmpty() || !Character.isDigit(name.charAt(0))) continue;
            String args = cmdline(dir);
            if (args == null || args.isEmpty()) continue;
            for (String marker : markers) {
                if (!marker.isEmpty() && args.contains(marker)) {
                    procs.put(Json.obj("pid", Integer.parseInt(name), "args", args));
                    break;
                }
            }
        }
        return Json.put(res, "procs", procs);
    }

    /** (utime + stime, starttime) of /proc/<pid>/stat; comm may contain spaces/parens → split after the last ')'. */
    private static long[] procStat(String pid) {
        String line = firstLine("/proc/" + pid + "/stat");
        if (line == null) return null;
        String[] rest = line.substring(line.lastIndexOf(')') + 1).trim().split("\\s+");
        // rest[0] = field 3 (state) → utime (14) = rest[11], stime (15) = rest[12], starttime (22) = rest[19]
        if (rest.length <= 19) return null;
        return new long[]{parseLong(rest[11]) + parseLong(rest[12]), parseLong(rest[19])};
    }

    private static JSONArray frequencies() {
        JSONArray out = new JSONArray();
        File[] policies = new File("/sys/devices/system/cpu/cpufreq").listFiles();
        if (policies == null) return out;
        java.util.Arrays.sort(policies);
        for (File policy : policies) {
            if (!policy.getName().startsWith("policy")) continue;
            String khz = firstLine(policy.getPath() + "/scaling_cur_freq");
            if (khz != null && khz.trim().matches("\\d+")) out.put(parseLong(khz.trim()));
        }
        return out;
    }

    private static Double gpuUtil() {
        for (String path : GPU_FILES) {
            String line = firstLine(path);
            if (line == null) continue;
            java.util.regex.Matcher m = java.util.regex.Pattern.compile("(\\d+(?:\\.\\d+)?)").matcher(line);
            if (m.find()) return Math.min(100.0, Double.parseDouble(m.group(1)));
        }
        return null;
    }

    /** The NUL-separated command line joined with spaces (what `ps -o ARGS` shows); null when unreadable. */
    private static String cmdline(File procDir) {
        byte[] buf = new byte[MAX_ARGS];
        try (FileInputStream in = new FileInputStream(new File(procDir, "cmdline"))) {
            int n = in.read(buf);
            if (n <= 0) return null;
            for (int i = 0; i < n; i++) if (buf[i] == 0) buf[i] = ' ';
            return new String(buf, 0, n, StandardCharsets.UTF_8).trim();
        } catch (Throwable t) {
            return null;
        }
    }

    /** First line of a small kernel file; null when unreadable (SELinux, a pid that just exited). */
    private static String firstLine(String path) {
        byte[] buf = new byte[1024];
        try (FileInputStream in = new FileInputStream(path)) {
            int n = in.read(buf);
            if (n <= 0) return null;
            String s = new String(buf, 0, n, StandardCharsets.UTF_8);
            int nl = s.indexOf('\n');
            return nl >= 0 ? s.substring(0, nl) : s;
        } catch (Throwable t) {
            return null;
        }
    }

    private static long parseLong(String s) {
        try { return Long.parseLong(s.trim()); } catch (Throwable t) { return 0L; }
    }
}
