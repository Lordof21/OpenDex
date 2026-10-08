package com.opendex.tools;

import java.io.BufferedReader;
import java.io.File;
import java.io.IOException;
import java.io.PipedReader;
import java.io.PipedWriter;
import java.io.PrintWriter;
import java.io.StringReader;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Base64;
import java.util.Collections;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.zip.GZIPInputStream;

/**
 * Plain-JVM checks of the daemon's pure classes (ShellRunner, ShellWire, DaemonAuth, ProcProbe, FsWire, FsPolicy, FsOps, PlayoutClock, BatteryFacts, PtsClock, ProbeTone) — they carry no Android types, so
 * the behaviour that matters (timeouts, orphaned children, output caps, concurrency limits, the HMAC answer, the
 * /proc reader) is tested where it can be, not only on a phone. Run by backend/tests/test_java_pure_classes.py.
 *
 * <pre>
 *   selftest                       all checks; prints ALL OK
 *   answer TOKEN SERVER_NONCE      prints the client's HMAC answer (compared with the Python side)
 *   proof TOKEN CLIENT_NONCE SERVER_NONCE
 *                                  prints the daemon's proof for the greeting (compared with the Python side)
 *   verify TOKEN SERVER_NONCE LINE prints "OK <clientNonce>" when LINE is a valid answer line, else "NO"
 *   probe PKG[,PKG…]               prints ProcProbe.probe of this machine's /proc (parsed by the Python side)
 *   parse LINE                     ShellWire.parse of a request line: "OK timeoutMs t|b base64(command)" or "ERR error"
 *   fsparse LINE                   FsWire.parse of an fs_* request: "OK command args…" or "ERR error"
 *   fsdecode B64                   FsWire.decode: "OK base64(text)" or "NO" (the strict path decoder)
 *   encode t|b EXIT                ShellWire.encode of a result whose stdout and stderr are the hex on stdin's first and
 *                                  second line: "OK", enc, base64(out text), base64(err) on four lines (the Python side
 *                                  decodes them with its own decoder: the wire contract, both ways)
 * </pre>
 */
public final class PureClassesSelfTest {

    private static int checks = 0;

    public static void main(String[] args) throws Exception {
        String mode = args.length > 0 ? args[0] : "selftest";
        switch (mode) {
            case "answer":
                System.out.print(DaemonAuth.clientAnswer(args[1], args[2]));
                return;
            case "proof":
                System.out.print(DaemonAuth.serverProof(args[1], args[2], args[3]));
                return;
            case "verify": {
                String clientNonce = DaemonAuth.verifyClientAnswer(args[1], args[2], args[3]);
                System.out.print(clientNonce == null ? "NO" : "OK " + clientNonce);
                return;
            }
            case "probe":
                System.out.print(ProcProbe.probe(Arrays.asList(args[1].split(","))));
                return;
            case "parse": {
                ShellWire.Request r = ShellWire.parse(args[1]);
                System.out.print(r.error != null ? "ERR " + r.error
                        : "OK " + r.timeoutMs + " " + (r.binary ? "b" : "t") + " " + b64(r.command));
                return;
            }
            case "encode": {
                java.io.BufferedReader stdin = new java.io.BufferedReader(new java.io.InputStreamReader(System.in, StandardCharsets.US_ASCII));
                String hexOut = stdin.readLine();
                String hexErr = stdin.readLine();
                ShellRunner.Result result = new ShellRunner.Result(Integer.parseInt(args[2]), unhex(hexOut), unhex(hexErr),
                        false, false, null, 1);
                ShellWire.Reply reply = ShellWire.encode(result, "b".equals(args[1]));
                System.out.print(reply.ok ? "OK\n" + reply.enc + "\n" + b64(reply.out) + "\n" + b64(reply.err)
                        : "ERR\n" + reply.error);
                return;
            }
            case "fsparse": {
                FsWire.Request r = FsWire.parse(args[1]);
                System.out.print(r.error != null ? "ERR " + r.error : "OK " + r.command + " " + String.join(" ", r.args));
                return;
            }
            case "fsdecode": {
                String text = FsWire.decode(args[1]);
                System.out.print(text == null ? "NO" : "OK " + b64(text));
                return;
            }
            default:
                shellRunner();
                shellWire();
                daemonAuth();
                daemonHandshake();
                procProbe();
                fsWire();
                fsPolicy();
                fsOps();
                playoutClock();
                batteryFacts();
                ptsClock();
                probeTone();
                System.out.println("ALL OK (" + checks + " checks)");
        }
    }

    // ------------------------------------------------------------------ PlayoutClock ("İkisi": phone and DeX present the same instant)

    private static void playoutClock() {
        final long ms = 1_000_000L;
        final int rate = 48_000;

        // Where a frame written now would be presented, with a track timestamp: the frames queued ahead take 1/rate each.
        // Frame 48000 was presented at t=1000 ms; 9600 frames (200 ms) are written beyond it → the NEXT frame leaves at 1200 ms.
        long predicted = PlayoutClock.predictPresentNanos(1050 * ms, 57_600, rate, true, 48_000, 1000 * ms, 0);
        eq(1200 * ms, predicted, "timestamp + queued frames");
        // Nothing queued: it is presented at the timestamp's own time.
        eq(1000 * ms + 0, PlayoutClock.predictPresentNanos(900 * ms, 48_000, rate, true, 48_000, 1000 * ms, 0),
                "an empty queue presents at the timestamp");
        // A stale timestamp after an underrun can say "the past": a frame is never presented sooner than the floor.
        eq(1000 * ms + PlayoutClock.MIN_PIPELINE_NANOS,
                PlayoutClock.predictPresentNanos(1000 * ms, 10_000, rate, true, 20_000, 500 * ms, 0), "never earlier than the floor");
        // No timestamp yet: the playback head and a typical pipeline stand in.
        eq(2000 * ms + 100 * ms + PlayoutClock.DEFAULT_PIPELINE_NANOS,
                PlayoutClock.predictPresentNanos(2000 * ms, 4800, rate, false, 0, 0, 0), "no timestamp: head + default pipeline");
        eq(2000 * ms + PlayoutClock.DEFAULT_PIPELINE_NANOS,
                PlayoutClock.predictPresentNanos(2000 * ms, 4800, rate, false, 0, 0, 4800), "no timestamp, nothing queued");

        // In step (within the tolerance): no correction at all — noise must not make the stream click.
        eq(0L, PlayoutClock.correctionFrames(1000 * ms, 1000 * ms, rate), "exactly on time");
        eq(0L, PlayoutClock.correctionFrames(1000 * ms, 1000 * ms + PlayoutClock.TOLERANCE_NANOS, rate), "late within the tolerance");
        eq(0L, PlayoutClock.correctionFrames(1000 * ms, 1000 * ms - PlayoutClock.TOLERANCE_NANOS, rate), "early within the tolerance");
        // Early (would be presented before its time): insert exactly the missing silence.
        eq(4800L, PlayoutClock.correctionFrames(1100 * ms, 1000 * ms, rate), "100 ms early → 4800 frames of silence");
        // Late: skip exactly that much of the chunk.
        eq(-2400L, PlayoutClock.correctionFrames(1000 * ms, 1050 * ms, rate), "50 ms late → skip 2400 frames");
        // One correction never blanks more than the cap, however wrong the estimate.
        eq(96_000L, PlayoutClock.correctionFrames(60_000 * ms, 1000 * ms, rate), "capped at 2 s of silence");
        eq(-96_000L, PlayoutClock.correctionFrames(1000 * ms, 60_000 * ms, rate), "capped at 2 s of skipping");

        // The phone's presentation target: capture 1000 ms + 120 ms target, track would present the next frame at 1180 ms.
        long desired = 1000 * ms + 120 * ms;
        eq(-2880L, PlayoutClock.correctionFrames(desired, 1180 * ms, rate), "60 ms late against pts+target → skip 2880 frames");
        // …and once corrected the same chunk is in step (the loop converges, it does not oscillate).
        eq(0L, PlayoutClock.correctionFrames(desired, 1180 * ms - 2880L * 1_000_000_000L / rate, rate), "after the correction: in step");
    }


    // ------------------------------------------------------------------ BatteryFacts (the Battery page's phone-side readers)

    // The phone's own text, verbatim: POCO X7 Pro (MediaTek MT6375), HyperOS, plugged into a PC's USB port.
    private static final String DUMPSYS_BATTERY = String.join("\n",
            "Current Battery Service state:",
            "  AC powered: false",
            "  USB powered: true",
            "  Wireless powered: false",
            "  Dock powered: false",
            "  Max charging current: 500000",
            " Time when the latest updated value of the Max charging current was sent via battery changed broadcast: +7h16m1s613ms",
            "  Max charging voltage: 5000000",
            "  Charge counter: 4431000",
            "  status: 2",
            "  health: 2",
            "  present: true",
            "  level: 80",
            "  scale: 100",
            "  voltage: 4221",
            " Time when the latest updated value of the voltage was sent via battery changed broadcast: +7h24m1s626ms",
            " The last voltage value sent via the battery changed broadcast: 4222",
            "  temperature: 338",
            "  technology: Li-poly",
            "  Charging state: 0",
            "  Charging policy: 0",
            "  Capacity level: 4",
            "MiuiBatteryService first usage time:",
            "  mSetBatteryUsageTimeCount=1",
            "  mNtpTime=1758535122427",
            "  mParseNtpTime=20250922", "");
    private static final String UEVENT_GAUGE = String.join("\n",
            "POWER_SUPPLY_NAME=mt6375-gauge", "POWER_SUPPLY_TYPE=Unknown", "POWER_SUPPLY_PRESENT=1", "POWER_SUPPLY_ONLINE=1",
            "POWER_SUPPLY_CURRENT_NOW=1200", "POWER_SUPPLY_CURRENT_MAX=0", "POWER_SUPPLY_VOLTAGE_NOW=4000000",
            "POWER_SUPPLY_ENERGY_EMPTY=0", "POWER_SUPPLY_ENERGY_FULL_DESIGN=56573", "POWER_SUPPLY_ENERGY_FULL=56573",
            "POWER_SUPPLY_ENERGY_NOW=10000", "POWER_SUPPLY_CAPACITY_LEVEL=10000", "POWER_SUPPLY_TEMP=0", "");
    private static final String UEVENT_PORT = String.join("\n",
            "POWER_SUPPLY_NAME=primary_chg", "POWER_SUPPLY_TYPE=USB", "POWER_SUPPLY_MANUFACTURER=Mediatek", "POWER_SUPPLY_ONLINE=2",
            "POWER_SUPPLY_STATUS=Charging", "POWER_SUPPLY_CONSTANT_CHARGE_CURRENT=500", "POWER_SUPPLY_CONSTANT_CHARGE_VOLTAGE=4460",
            "POWER_SUPPLY_INPUT_CURRENT_LIMIT=500", "POWER_SUPPLY_INPUT_VOLTAGE_LIMIT=4500", "POWER_SUPPLY_CHARGE_TERM_CURRENT=300",
            "POWER_SUPPLY_USB_TYPE=Unknown [SDP] CDP DCP", "POWER_SUPPLY_CURRENT_MAX=500000", "POWER_SUPPLY_VOLTAGE_MAX=5000000",
            "POWER_SUPPLY_CALIBRATE=4221", "POWER_SUPPLY_ENERGY_EMPTY=0", "");

    private static void batteryFacts() {
        java.util.Map<String, String> f = BatteryFacts.colonFields(DUMPSYS_BATTERY);
        eq("80", f.get("level"), "level");
        eq("4221", f.get("voltage"), "voltage (the live line, not the 'last value sent via broadcast' one)");
        eq("338", f.get("temperature"), "temperature in tenths of a degree");
        eq("500000", f.get("Max charging current"), "the port's current limit (µA)");
        eq("5000000", f.get("Max charging voltage"), "the port's voltage limit (µV)");
        eq("4431000", f.get("Charge counter"), "charge counter (µAh)");
        eq("0", f.get("Charging policy"), "charging policy 0 = not reported");
        eq("true", f.get("USB powered"), "USB powered");
        eq("false", f.get("AC powered"), "AC powered");
        eq("Li-poly", f.get("technology"), "technology");
        eq(4431000L, BatteryFacts.parseLong(f.get("Charge counter"), 0), "charge counter parses");
        // A key seen twice keeps its FIRST (live) value.
        eq("1", BatteryFacts.colonFields("level: 1\nlevel: 2\n").get("level"), "first occurrence wins");
        isTrue(BatteryFacts.colonFields(null).isEmpty(), "no dump, no fields");

        // First use: the exact epoch wins; the day alone is that day's UTC midnight; nothing → -1.
        eq(1758535122427L, BatteryFacts.firstUsageMs(DUMPSYS_BATTERY), "mNtpTime (epoch ms)");
        eq(1758499200000L, BatteryFacts.firstUsageMs("mNtpTime=0\nmParseNtpTime=20250922\n"), "only the day: 2025-09-22 00:00 UTC");
        eq(1758499200000L, BatteryFacts.firstUsageMs("mParseNtpTime=20250922"), "the day alone");
        eq(951782400000L, BatteryFacts.firstUsageMs("mParseNtpTime=20000229"), "a leap day");
        eq(-1L, BatteryFacts.firstUsageMs("mParseNtpTime=20251399"), "an impossible date");
        eq(-1L, BatteryFacts.firstUsageMs("mParseNtpTime=0"), "an unset date");
        eq(-1L, BatteryFacts.firstUsageMs("level: 80"), "no vendor line");
        eq(-1L, BatteryFacts.firstUsageMs(null), "no dump");

        // power_supply uevents: the gauge's energy pair and the port's USB type.
        java.util.Map<String, String> gauge = BatteryFacts.uevent(UEVENT_GAUGE);
        eq("mt6375-gauge", gauge.get("NAME"), "gauge name (POWER_SUPPLY_ prefix dropped)");
        eq(56573L, BatteryFacts.parseLong(gauge.get("ENERGY_FULL"), 0), "energy full");
        eq(56573L, BatteryFacts.parseLong(gauge.get("ENERGY_FULL_DESIGN"), 0), "energy full design");
        java.util.Map<String, String> port = BatteryFacts.uevent(UEVENT_PORT);
        eq("USB", port.get("TYPE"), "port type");
        eq("SDP", BatteryFacts.activeUsbType(port.get("USB_TYPE")), "a PC's standard downstream port");
        eq("DCP", BatteryFacts.activeUsbType("Unknown SDP CDP [DCP]"), "a wall charger");
        eq("PD", BatteryFacts.activeUsbType("C [PD] PD_DRP"), "USB-PD");
        eq(null, BatteryFacts.activeUsbType("Unknown SDP CDP DCP"), "none bracketed");
        eq(null, BatteryFacts.activeUsbType("[]"), "an empty bracket");
        eq(null, BatteryFacts.activeUsbType(null), "no value");
        isTrue(BatteryFacts.uevent(null).isEmpty(), "no uevent, no fields");

        eq(7, BatteryFacts.parseInt("abc", 7), "garbage → fallback");
        eq(12L, BatteryFacts.parseLong("  12 ", 0), "whitespace");
        eq(-1, BatteryFacts.parseInt("99999999999", -1), "out of int range → fallback");
    }


    // ------------------------------------------------------------------ PtsClock (a smooth capture timeline from jittery reads)

    private static void ptsClock() {
        final int rate = 48_000;
        final int chunk = 960;                       // 20 ms
        final long t0 = 5_000_000_000L;              // µs: the true capture time of frame 0

        // Exactly on schedule, no jitter: PTS is the chunk's own start, and consecutive chunks are exactly 20 ms apart.
        PtsClock clean = new PtsClock(rate);
        long first = clean.stamp(t0 + 20_000, chunk);
        eq(t0, first, "an on-time first read stamps the chunk's start");
        eq(t0 + 20_000, clean.stamp(t0 + 40_000, chunk), "the next chunk is 20 ms later");
        eq(t0 + 40_000, clean.stamp(t0 + 60_000, chunk), "and the next");

        // Jittered reads: each returns 0–14 ms AFTER its data was captured (sometimes two in a burst). The old stamp
        // (now − duration) would wander by that much; the timeline must not.
        PtsClock jittery = new PtsClock(rate);
        long seed = 12345;
        long maxErr = 0, maxStep = 0, previous = Long.MIN_VALUE;
        for (int k = 0; k < 1500; k++) {                                   // 30 s
            seed = (seed * 6364136223846793005L + 1442695040888963407L);
            long delay = ((seed >>> 33) % 15) * 1000L;                      // 0..14 ms
            long pts = jittery.stamp(t0 + 20_000L * (k + 1) + delay, chunk);
            if (k >= 100) {                                                 // after the envelope has found a quiet read
                maxErr = Math.max(maxErr, Math.abs(pts - (t0 + 20_000L * k)));
                maxStep = Math.max(maxStep, Math.abs(pts - previous - 20_000L));
            }
            previous = pts;
        }
        isTrue(maxErr <= 2_000, "the timeline stays within 2 ms of the true capture time despite 0–14 ms read jitter (was " + maxErr + " µs)");
        isTrue(maxStep <= 2_000, "no chunk is ever more than 2 ms off the 20 ms grid (was " + maxStep + " µs) — nothing for an output to correct");

        // A sample clock 100 ppm slower than the system clock: the envelope creeps up with it instead of falling behind.
        PtsClock drifting = new PtsClock(rate);
        long worst = 0;
        for (int k = 0; k < 6000; k++) {                                    // 2 minutes
            long trueStart = t0 + 20_000L * k + k * 2L;                     // +2 µs per chunk = 100 ppm
            long pts = drifting.stamp(trueStart + 20_000L + (k % 7) * 500L, chunk);
            if (k >= 100) worst = Math.max(worst, Math.abs(pts - trueStart));
        }
        isTrue(worst <= 3_000, "100 ppm of drift is followed (worst " + worst + " µs)");

        // Lost frames (an overrun): the data is suddenly 80 ms later than the sample count says. Until JUMP_READS reads
        // have confirmed it the stamp stays on the old timeline; then it re-anchors and is exact again.
        PtsClock lossy = new PtsClock(rate);
        long base = t0;
        for (int k = 0; k < 200; k++) lossy.stamp(base + 20_000L * (k + 1), chunk);
        long lost = 80_000;
        long lastWrong = 0;
        for (int k = 200; k < 200 + PtsClock.JUMP_READS - 1; k++) {
            lastWrong = lossy.stamp(base + lost + 20_000L * (k + 1), chunk);
        }
        eq(base + 20_000L * (200 + PtsClock.JUMP_READS - 2), lastWrong, "before the jump is confirmed the timeline is not disturbed");
        long reanchored = lossy.stamp(base + lost + 20_000L * (200 + PtsClock.JUMP_READS), chunk);
        eq(base + lost + 20_000L * (200 + PtsClock.JUMP_READS - 1), reanchored, "after JUMP_READS reads it is exact on the new timeline");

        // reset(): the next read anchors afresh.
        PtsClock restarted = new PtsClock(rate);
        restarted.stamp(t0 + 20_000, chunk);
        restarted.reset();
        eq(t0 + 500_000, restarted.stamp(t0 + 520_000, chunk), "after reset the first read anchors on itself");
    }

    // ------------------------------------------------------------------ ProbeTone (the calibration's test sound)

    /** Peak of |Σ x[n+k]·t[k]| over all lags: where a template sits in a recording, and how strongly. */
    private static double[] matchedPeak(float[] recording, float[] template) {
        double best = 0;
        int at = -1;
        for (int n = 0; n + template.length <= recording.length; n++) {
            double sum = 0;
            for (int k = 0; k < template.length; k++) sum += recording[n + k] * template[k];
            if (Math.abs(sum) > best) {
                best = Math.abs(sum);
                at = n;
            }
        }
        return new double[] {at, best};
    }

    private static int zeroCrossings(float[] x, int from, int to) {
        int crossings = 0;
        for (int i = from + 1; i < to; i++) if ((x[i - 1] < 0) != (x[i] < 0)) crossings++;
        return crossings;
    }

    private static void probeTone() {
        final int rate = ProbeTone.SAMPLE_RATE;
        float[] up = ProbeTone.chirp(rate, ProbeTone.DURATION_MS, ProbeTone.PHONE_F0_HZ, ProbeTone.PHONE_F1_HZ);
        float[] down = ProbeTone.chirp(rate, ProbeTone.DURATION_MS, ProbeTone.PAGE_F0_HZ, ProbeTone.PAGE_F1_HZ);
        eq(960L, (long) up.length, "20 ms at 48 kHz is 960 samples — exactly one capture chunk");
        float peak = 0;
        for (float v : up) peak = Math.max(peak, Math.abs(v));
        isTrue(peak <= 1.0f && peak > 0.9f, "the chirp uses the full range before the gain: " + peak);
        isTrue(Math.abs(up[0]) < 1e-6f && Math.abs(up[up.length - 1]) < 1e-3f, "the Hann window starts and ends in silence (no click)");
        // The page (frontend/src/media/syncCalibration.js `chirp`) generates the SAME sweep; both tests pin these reference
        // values, so a drift in either formula fails a test instead of silently costing the matched filter its peak.
        near(0.09873941540718079, up[100], 1e-5, "reference sample 100");
        near(0.686124324798584, up[333], 1e-5, "reference sample 333");
        near(0.38028573989868164, up[700], 1e-5, "reference sample 700");
        near(0.034085310995578766, up[900], 1e-5, "reference sample 900");
        double energy = 0;
        for (float v : up) energy += v * v;
        near(179.81249990094773, energy, 1e-2, "reference energy");
        int early = zeroCrossings(up, 0, up.length / 4);
        int late = zeroCrossings(up, 3 * up.length / 4, up.length);
        isTrue(late * 2 > early * 3, "the phone's chirp sweeps UP (crossings " + early + " → " + late + ")");
        int dEarly = zeroCrossings(down, 0, down.length / 4);
        int dLate = zeroCrossings(down, 3 * down.length / 4, down.length);
        isTrue(dEarly * 100 > dLate * 115, "the page's chirp sweeps DOWN (crossings " + dEarly + " → " + dLate + ")");

        // The chunk the phone's renderer takes: exactly one 20 ms stereo chunk, the tone fills it, L == R, no clipping.
        byte[] chunk = ProbeTone.phoneChunk(ProbeTone.AMPLITUDE);
        eq(3840L, (long) chunk.length, "one 20 ms stereo s16le chunk");
        int maxAbs = 0;
        boolean channelsEqual = true;
        for (int f = 0; f < ProbeTone.CHUNK_FRAMES; f++) {
            int l = (short) ((chunk[f * 4] & 0xFF) | (chunk[f * 4 + 1] << 8));
            int r = (short) ((chunk[f * 4 + 2] & 0xFF) | (chunk[f * 4 + 3] << 8));
            if (l != r) channelsEqual = false;
            maxAbs = Math.max(maxAbs, Math.abs(l));
        }
        isTrue(channelsEqual, "both channels carry the tone");
        isTrue(maxAbs > 0.55 * 32767 && maxAbs <= 0.6 * 32767 + 1, "the tone is at the probe amplitude, not clipped: " + maxAbs);
        eq(0L, (long) (chunk[0] | chunk[1]), "the chunk starts in silence (the window), so the tone's onset is the chunk's presentation time");

        // A matched filter finds the phone's chirp where it was put — and the page's chirp (another band) barely answers it,
        // which is what lets the two copies be told apart in one recording.
        float[] recording = new float[4000];
        for (int i = 0; i < up.length; i++) recording[1234 + i] = up[i];
        double[] hit = matchedPeak(recording, up);
        eq(1234L, (long) hit[0], "the matched filter locates the chirp exactly");
        double cross = matchedPeak(recording, down)[1];
        isTrue(hit[1] > 15 * cross, "the phone's chirp is far louder to its own filter than to the page's (" + hit[1] + " vs " + cross + ")");
    }

    // ------------------------------------------------------------------ ShellRunner

    private static void shellRunner() throws Exception {
        ShellRunner r = new ShellRunner(4, 8);

        ShellRunner.Result res = r.run("echo hello", 5000, 1 << 20);
        eq(0, res.exitCode, "exit 0");
        eq("hello\n", text(res.stdout), "stdout");
        isTrue(!res.timedOut && !res.tooLarge && res.startError == null, "plain run flags");

        res = r.run("echo out; echo err >&2; exit 3", 5000, 1 << 20);
        eq(3, res.exitCode, "exit code is reported");
        eq("out\n", text(res.stdout), "stdout kept apart from stderr");
        eq("err\n", text(res.stderr), "stderr kept apart from stdout");

        res = r.run("echo abc | tr a-z A-Z; echo done", 5000, 1 << 20);
        eq("ABC\ndone\n", text(res.stdout), "pipes and several statements, like adb shell");

        res = r.run("printf '%s|' \"a b\" 'c;d' \"\\$HOME\"", 5000, 1 << 20);
        eq("a b|c;d|$HOME|", text(res.stdout), "quoting is the shell's, nothing is rewritten");

        long t0 = System.nanoTime();
        res = r.run("cat", 5000, 1 << 20);
        isTrue(ms(t0) < 1500 && res.exitCode == 0 && res.stdout.length == 0, "stdin is closed: cat ends at once");

        res = r.run("definitely_not_a_command_xyz", 5000, 1 << 20);
        eq(127, res.exitCode, "missing command → 127");

        res = r.run("printf '\\305\\237\\377'", 5000, 1 << 20);
        isTrue(Arrays.equals(new byte[] {(byte) 0xC5, (byte) 0x9F, (byte) 0xFF}, res.stdout),
                "bytes are passed through untouched (decoding is the caller's business)");

        t0 = System.nanoTime();
        res = r.run("yes | head -c 5000000", 10000, 100_000);
        isTrue(res.tooLarge, "output over the cap is flagged tooLarge");
        isTrue(res.stdout.length <= 100_000, "and never buffered beyond the cap");
        isTrue(ms(t0) < 3000, "and the process is stopped, not read to the end");

        t0 = System.nanoTime();
        res = r.run("sleep 5", 300, 1 << 20);
        isTrue(res.timedOut, "a command past its deadline is reported timedOut");
        isTrue(ms(t0) < 2000, "and stopped at the deadline, not when it ends (" + ms(t0) + " ms)");

        // Killing sh leaves its child holding the pipes: the caller must still get its result in time.
        t0 = System.nanoTime();
        res = r.run("sleep 5 & sleep 5", 300, 1 << 20);
        isTrue(res.timedOut, "orphaned child: timedOut");
        isTrue(ms(t0) < 1500, "orphaned child holding the pipes does not hold the caller (" + ms(t0) + " ms)");

        final AtomicInteger done = new AtomicInteger();
        final CountDownLatch all = new CountDownLatch(4);
        t0 = System.nanoTime();
        for (int i = 0; i < 4; i++) {
            isTrue(r.submit("sleep 0.3; echo ok", 5000, 1 << 20, new ShellRunner.Callback() {
                @Override
                public void done(ShellRunner.Result result) {
                    if ("ok\n".equals(text(result.stdout))) done.incrementAndGet();
                    all.countDown();
                }
            }), "submit accepted");
        }
        isTrue(all.await(5, TimeUnit.SECONDS), "four commands finish");
        eq(4, done.get(), "every callback fired once with its output");
        isTrue(ms(t0) < 1200, "and they ran concurrently (" + ms(t0) + " ms)");

        // What the daemon was started with must not reach the commands it runs (the test is started with both set).
        res = r.run("printenv OPENDEX_DAEMON_TOKEN; printenv CLASSPATH; echo end", 5000, 1 << 20);
        eq("end\n", text(res.stdout), "the token and the daemon's own CLASSPATH are not in a command's environment");
        res = r.run("printenv HOME PATH >/dev/null && echo kept", 5000, 1 << 20);
        eq("kept\n", text(res.stdout), "the rest of the environment is inherited, like under adb shell");

        // saturation: 1 running + 1 queued, the third is refused at once
        ShellRunner tiny = new ShellRunner(1, 1);
        final CountDownLatch finished = new CountDownLatch(2);
        ShellRunner.Callback count = new ShellRunner.Callback() {
            @Override
            public void done(ShellRunner.Result result) {
                finished.countDown();
            }
        };
        isTrue(tiny.submit("sleep 0.4", 5000, 1024, count), "first runs");
        isTrue(tiny.submit("sleep 0.1", 5000, 1024, count), "second waits");
        t0 = System.nanoTime();
        isTrue(!tiny.submit("echo no", 5000, 1024, count), "third is refused (busy)");
        isTrue(ms(t0) < 100, "refusal is immediate");
        isTrue(finished.await(5, TimeUnit.SECONDS), "the accepted two still complete, once each");
    }

    // ------------------------------------------------------------------ ShellWire

    private static byte[] unhex(String hex) {
        byte[] out = new byte[hex.length() / 2];
        for (int i = 0; i < out.length; i++) out[i] = (byte) Integer.parseInt(hex.substring(2 * i, 2 * i + 2), 16);
        return out;
    }

    private static String b64(String s) {
        return Base64.getEncoder().encodeToString(s.getBytes(StandardCharsets.UTF_8));
    }

    private static ShellRunner.Result result(byte[] out, byte[] err, int exit) {
        return new ShellRunner.Result(exit, out, err, false, false, null, 7);
    }

    private static byte[] gunzip(String base64) throws IOException {
        java.io.ByteArrayOutputStream bytes = new java.io.ByteArrayOutputStream();
        try (GZIPInputStream in = new GZIPInputStream(new java.io.ByteArrayInputStream(Base64.getDecoder().decode(base64)))) {
            byte[] chunk = new byte[4096];
            int n;
            while ((n = in.read(chunk)) != -1) bytes.write(chunk, 0, n);
        }
        return bytes.toByteArray();
    }

    private static void shellWire() throws Exception {
        ShellWire.Request ok = ShellWire.parse("shell 5000 t " + b64("echo 'a b'; ls | wc -l"));
        isTrue(ok.error == null && "echo 'a b'; ls | wc -l".equals(ok.command), "a request round-trips its command verbatim");
        eq(5000L, ok.timeoutMs, "timeout");
        isTrue(!ok.binary, "t = text");
        isTrue(ShellWire.parse("shell 1000 b " + b64("x")).binary, "b = binary");
        eq("ü€ 日本 \n\"q\"", ShellWire.parse("shell 1000 t " + b64("ü€ 日本 \n\"q\"")).command, "UTF-8, newline and quotes survive");
        eq(ShellWire.MIN_TIMEOUT_MS, (int) ShellWire.parse("shell 1 t " + b64("x")).timeoutMs, "a tiny timeout is raised to the minimum");
        eq(ShellWire.MAX_TIMEOUT_MS, (int) ShellWire.parse("shell 99999999 t " + b64("x")).timeoutMs, "a huge one is capped");

        String[] bad = {
                "shell", "shell 1000", "shell 1000 t", "shell 1000 x " + b64("x"), "shell abc t " + b64("x"),
                "shell 1000 t !!!notbase64!!!", "shell 1000 t " + b64(""), "shell 1000 " + b64("x"),
        };
        for (String line : bad) {
            ShellWire.Request r = ShellWire.parse(line);
            isTrue("bad_request".equals(r.error) && r.command == null, "refused as bad_request: " + line);
        }
        char[] big = new char[ShellWire.MAX_COMMAND_BYTES + 1];
        Arrays.fill(big, 'a');
        eq("bad_request", ShellWire.parse("shell 1000 t " + b64(new String(big))).error, "a command over the size limit");

        // text mode
        ShellWire.Reply r = ShellWire.encode(result("héllo\n".getBytes(StandardCharsets.UTF_8), "warn".getBytes(StandardCharsets.UTF_8), 0), false);
        isTrue(r.ok && "plain".equals(r.enc) && "héllo\n".equals(r.out) && "warn".equals(r.err) && r.exit == 0 && r.ms == 7, "small text reply is plain");
        r = ShellWire.encode(result(new byte[0], "boom".getBytes(StandardCharsets.UTF_8), 3), false);
        isTrue(r.ok && r.exit == 3 && "boom".equals(r.err) && "".equals(r.out), "a failed command is still a verdict, with its stderr");
        ShellRunner.Result late = new ShellRunner.Result(-1, new byte[0], new byte[0], true, false, null, 300);
        isTrue(ShellWire.encode(late, false).timedOut, "timed_out is carried");

        // binary mode is byte-exact, in either encoding
        byte[] png = new byte[100];
        for (int i = 0; i < png.length; i++) png[i] = (byte) (0x80 + i);
        r = ShellWire.encode(result(png, new byte[0], 0), true);
        isTrue("b64".equals(r.enc) && Arrays.equals(png, Base64.getDecoder().decode(r.out)), "small binary: b64, every byte intact (even invalid UTF-8)");
        byte[] bigBinary = new byte[100_000];
        for (int i = 0; i < bigBinary.length; i++) bigBinary[i] = (byte) (i % 7);
        r = ShellWire.encode(result(bigBinary, new byte[0], 0), true);
        isTrue("gz".equals(r.enc) && Arrays.equals(bigBinary, gunzip(r.out)), "compressible binary: gz, byte-exact");
        isTrue(r.out.length() < bigBinary.length / 4, "and much smaller on the wire");
        byte[] noise = new byte[100_000];
        new java.util.Random(1).nextBytes(noise);
        r = ShellWire.encode(result(noise, new byte[0], 0), true);
        isTrue("b64".equals(r.enc) && Arrays.equals(noise, Base64.getDecoder().decode(r.out)), "incompressible binary: b64, not a bigger gz");

        StringBuilder text = new StringBuilder();
        for (int i = 0; i < 20_000; i++) text.append("Window #").append(i).append(" mFrame=[0,0][1080,2400]\n");
        byte[] dump = text.toString().getBytes(StandardCharsets.UTF_8);
        r = ShellWire.encode(result(dump, new byte[0], 0), false);
        isTrue("gz".equals(r.enc) && text.toString().equals(new String(gunzip(r.out), StandardCharsets.UTF_8)), "a dumpsys-sized text reply is gzipped and round-trips");
        isTrue(r.out.length() < dump.length / 3, "and travels in a fraction of its size");

        // refusals
        eq("exec_failed", ShellWire.encode(new ShellRunner.Result(-1, new byte[0], new byte[0], false, false, "start_failed: x", 1), false).error, "start failure");
        ShellWire.Reply tooLarge = ShellWire.encode(new ShellRunner.Result(0, new byte[10], new byte[0], false, true, null, 1), false);
        isTrue(!tooLarge.ok && "too_large".equals(tooLarge.error), "an output past the cap is refused, never truncated");
        byte[] huge = new byte[ShellWire.MAX_RESPONSE_BYTES + 1];
        new java.util.Random(2).nextBytes(huge);
        ShellWire.Reply overlong = ShellWire.encode(result(huge, new byte[0], 0), true);
        isTrue(!overlong.ok && "too_large".equals(overlong.error), "a reply the backend's reader would refuse is refused here");
    }

    // ------------------------------------------------------------------ DaemonAuth

    private static void daemonAuth() throws Exception {
        eq("f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8",
                DaemonAuth.hmacHex("key", "The quick brown fox jumps over the lazy dog"), "HMAC-SHA256 test vector");

        // The exact wire definitions, pinned with values computed independently (Python's hmac module): a change in the
        // role prefixes or the order of the nonces would silently break every real daemon-client pair.
        eq("40f7df16550945218cd8f48a7cf0ebf52ee8a441ddd0c28da02e3a6e6dd29460",
                DaemonAuth.clientAnswer("key", "00ff00ff00ff00ff00ff00ff00ff00ff"), "client answer = HMAC(key, \"client|\" + Ns)");
        eq("ca30718179591c2fca5bad17b234a9a38924b9ad4a178152f30ddc61c3f128d1",
                DaemonAuth.serverProof("key", "c0dec0dec0dec0dec0dec0dec0dec0de", "00ff00ff00ff00ff00ff00ff00ff00ff"), "server proof = HMAC(key, \"server|\" + Nc + \"|\" + Ns)");

        String sn = DaemonAuth.newNonce();
        eq(32, sn.length(), "nonce is 16 bytes of hex");
        isTrue(DaemonAuth.isNonce(sn) && !sn.equals(DaemonAuth.newNonce()), "nonces are valid and differ");
        isTrue(!DaemonAuth.isNonce(null) && !DaemonAuth.isNonce("") && !DaemonAuth.isNonce("abc")
                && !DaemonAuth.isNonce("0123456789abcde") && !DaemonAuth.isNonce("0123456789ABCDEF0123")
                && !DaemonAuth.isNonce("0123456789abcdef|0123") && !DaemonAuth.isNonce(new String(new char[65]).replace('\0', 'a')),
                "a nonce is 16-64 lower-case hex characters, never a delimiter");

        String cn = DaemonAuth.newNonce();
        String good = "auth " + DaemonAuth.clientAnswer("secret-token", sn) + " " + cn;
        eq(cn, DaemonAuth.verifyClientAnswer("secret-token", sn, good), "the right answer verifies and yields the client nonce");
        isTrue(DaemonAuth.verifyClientAnswer("other-token", sn, good) == null, "a different token does not");
        isTrue(DaemonAuth.verifyClientAnswer("secret-token", DaemonAuth.newNonce(), good) == null, "an answer to another nonce (replay) does not");
        isTrue(DaemonAuth.verifyClientAnswer("secret-token", sn, good.substring(5)) == null, "no 'auth ' prefix");
        isTrue(DaemonAuth.verifyClientAnswer("secret-token", sn, good.toUpperCase()) == null, "wrong case");
        isTrue(DaemonAuth.verifyClientAnswer("secret-token", sn, "auth " + DaemonAuth.clientAnswer("secret-token", sn)) == null,
                "an answer without the client's nonce is not one (nothing for the proof to bind to)");
        isTrue(DaemonAuth.verifyClientAnswer("secret-token", sn, "auth " + DaemonAuth.clientAnswer("secret-token", sn) + " NOT-HEX") == null,
                "a malformed client nonce is refused");
        isTrue(DaemonAuth.verifyClientAnswer("secret-token", sn, good + " extra") == null, "trailing words are refused");
        isTrue(DaemonAuth.verifyClientAnswer("secret-token", sn, "auth  " + DaemonAuth.clientAnswer("secret-token", sn) + " " + cn) == null,
                "doubled spaces are refused");
        isTrue(DaemonAuth.verifyClientAnswer("secret-token", sn, "auth ") == null, "empty answer");
        isTrue(DaemonAuth.verifyClientAnswer("secret-token", sn, "GET / HTTP/1.1") == null, "an HTTP request line");
        isTrue(DaemonAuth.verifyClientAnswer("secret-token", sn, null) == null, "null line");
        isTrue(DaemonAuth.verifyClientAnswer("", sn, "auth 0000 " + cn) == null, "an empty token never authenticates");

        // the two roles must not be interchangeable
        isTrue(!DaemonAuth.clientAnswer("secret-token", sn).equals(DaemonAuth.serverProof("secret-token", cn, sn)), "client answer != server proof");
        isTrue(!DaemonAuth.serverProof("secret-token", cn, sn).equals(DaemonAuth.serverProof("secret-token", sn, cn)), "the proof depends on which nonce is whose");
        isTrue(!DaemonAuth.serverProof("secret-token", cn, sn).equals(DaemonAuth.serverProof("secret-token", DaemonAuth.newNonce(), sn)),
                "a proof for another client nonce does not fit (a recorded greeting cannot be replayed)");
        isTrue(!DaemonAuth.serverProof("secret-token", cn, sn).equals(DaemonAuth.serverProof("other-token", cn, sn)), "and only the key's holder can make it");
        boolean refused = false;
        try {
            DaemonAuth.serverProof("", cn, sn);
        } catch (IllegalArgumentException expected) {
            refused = true;
        }
        isTrue(refused, "an empty token cannot even compute a proof");

        eq("hello", DaemonAuth.readBoundedLine(new StringReader("hello\nrest"), 16), "a line");
        eq("hello", DaemonAuth.readBoundedLine(new StringReader("hello\r\n"), 16), "CRLF");
        eq(null, DaemonAuth.readBoundedLine(new StringReader(""), 16), "end of stream");
        eq("tail", DaemonAuth.readBoundedLine(new StringReader("tail"), 16), "last line without a break");
        boolean threw = false;
        try {
            DaemonAuth.readBoundedLine(new StringReader("0123456789abcdef0123"), 16);
        } catch (IOException expected) {
            threw = true;
        }
        isTrue(threw, "a line longer than the bound is refused, not buffered");
    }

    // ------------------------------------------------------------------ DaemonAuth.serve (the daemon's half, end to end)

    /** A client on the other end of piped streams, driven by the test thread; serve() runs on its own thread. */
    private static final class Handshake {
        final PipedWriter toDaemon = new PipedWriter();
        final BufferedReader fromDaemon;
        final List<Integer> deadlines = Collections.synchronizedList(new ArrayList<Integer>());
        final java.util.concurrent.BlockingQueue<String> lines = new java.util.concurrent.LinkedBlockingQueue<String>();
        final String END_OF_STREAM = new String("<end of stream>");
        volatile String proof;
        volatile boolean returned;
        final Thread daemon;

        Handshake(final String token, final long failureDelayMs) throws IOException {
            final BufferedReader daemonIn = new BufferedReader(new PipedReader(toDaemon, 4096));
            PipedWriter daemonOutPipe = new PipedWriter();
            fromDaemon = new BufferedReader(new PipedReader(daemonOutPipe, 4096));
            Thread lineReader = new Thread(new Runnable() {
                @Override
                public void run() {
                    try {
                        String line;
                        while ((line = fromDaemon.readLine()) != null) lines.add(line);
                    } catch (IOException ended) {
                        // the daemon side is gone
                    }
                    lines.add(END_OF_STREAM);
                }
            });
            lineReader.setDaemon(true);
            lineReader.start();
            final PrintWriter daemonOut = new PrintWriter(daemonOutPipe, false);
            daemon = new Thread(new Runnable() {
                @Override
                public void run() {
                    proof = DaemonAuth.serve(token, daemonIn, daemonOut, new DaemonAuth.Deadline() {
                        @Override
                        public void set(int millis) {
                            deadlines.add(millis);
                        }
                    }, new DaemonAuth.Frames() {
                        @Override
                        public String challenge(String serverNonce) {
                            return "{\"type\":\"auth_required\",\"nonce\":\"" + serverNonce + "\"}";
                        }

                        @Override
                        public String failure() {
                            return "{\"type\":\"auth_failed\"}";
                        }
                    }, 5000, failureDelayMs);
                    returned = true;
                    daemonOut.close();
                }
            });
            daemon.setDaemon(true); // a stuck serve() must fail the test, not keep the JVM alive
            daemon.start();
        }

        /**
         * The daemon's next line (null at its end of stream), or a failure after 5 s: a daemon that stays silent fails
         * the test, it does not hang it. One long-lived reader thread per handshake — a piped stream breaks ("Read end
         * dead") when the thread that last read from it has ended.
         */
        String nextLine() throws Exception {
            String line = lines.poll(5, TimeUnit.SECONDS);
            if (line == null) throw new AssertionError("the daemon sent nothing within 5 s");
            return line == END_OF_STREAM ? null : line;
        }

        String challengeNonce() throws Exception {
            String line = nextLine();
            java.util.regex.Matcher m = java.util.regex.Pattern.compile("^\\{\"type\":\"auth_required\",\"nonce\":\"([0-9a-f]{32})\"\\}$").matcher(line);
            if (!m.matches()) throw new AssertionError("not a challenge: " + line);
            return m.group(1);
        }

        void send(String line) throws IOException {
            toDaemon.write(line + "\n");
            toDaemon.flush();
        }

        /** Waits for serve() to finish and returns what it returned. */
        String finish() throws Exception {
            daemon.join(10_000);
            if (!returned) throw new AssertionError("serve() did not return");
            return proof;
        }
    }

    private static void daemonHandshake() throws Exception {
        final String key = "abababababababababababababababababababababababababababababababab";

        // an honest client: gets the challenge, answers it with its own nonce, and the daemon returns its proof for that pair
        Handshake h = new Handshake(key, 0);
        String sn = h.challengeNonce();
        String cn = DaemonAuth.newNonce();
        h.send("auth " + DaemonAuth.clientAnswer(key, sn) + " " + cn);
        eq(DaemonAuth.serverProof(key, cn, sn), h.finish(), "an honest client passes and the daemon owes it exactly this proof");
        isTrue(h.nextLine() == null, "and was told nothing else (no auth_failed) before its greeting");
        eq(Arrays.asList(5000, 0), new ArrayList<Integer>(h.deadlines), "the answer is awaited under a deadline, which is lifted once it passed");

        // a client with another key: refused, told so, no proof
        h = new Handshake(key, 20);
        sn = h.challengeNonce();
        long t0 = System.nanoTime();
        h.send("auth " + DaemonAuth.clientAnswer("cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd", sn) + " " + DaemonAuth.newNonce());
        eq(null, h.finish(), "a client with another key gets no proof");
        isTrue(ms(t0) >= 15, "and a failure is held back a little");
        eq("{\"type\":\"auth_failed\"}", h.nextLine(), "and is told so");

        // not an answer at all: an HTTP request line (the cross-protocol attack)
        h = new Handshake(key, 0);
        h.challengeNonce();
        h.send("POST / HTTP/1.1");
        eq(null, h.finish(), "a web page's request is refused");
        eq("{\"type\":\"auth_failed\"}", h.nextLine(), "like any other wrong answer");

        // an answer to a previous challenge
        h = new Handshake(key, 0);
        h.challengeNonce();
        h.send("auth " + DaemonAuth.clientAnswer(key, DaemonAuth.newNonce()) + " " + DaemonAuth.newNonce());
        eq(null, h.finish(), "an answer computed for another nonce (a replay) is refused");

        // an endless line is cut off, not buffered
        h = new Handshake(key, 0);
        h.challengeNonce();
        StringBuilder endless = new StringBuilder();
        for (int i = 0; i < 400; i++) endless.append('a');
        h.send(endless.toString());
        eq(null, h.finish(), "an overlong first line is refused");

        // a client that connects and says nothing (closes): nobody passed
        h = new Handshake(key, 0);
        h.challengeNonce();
        h.toDaemon.close();
        eq(null, h.finish(), "a client that never answers does not pass");
    }

    // ------------------------------------------------------------------ ProcProbe

    private static void procProbe() throws Exception {
        isTrue(ProcProbe.belongsToAny("com.x", Arrays.asList("com.x")), "package itself");
        isTrue(ProcProbe.belongsToAny("com.x:service", Arrays.asList("com.x")), "package:suffix");
        isTrue(!ProcProbe.belongsToAny("com.xy", Arrays.asList("com.x")), "a longer package is another app");
        isTrue(!ProcProbe.belongsToAny("com.x2:svc", Arrays.asList("com.x")), "and so is its prefixed process");
        isTrue(!ProcProbe.belongsToAny("a b", Arrays.asList("a b")), "invalid package names never match");
        isTrue(!ProcProbe.belongsToAny("../x", Arrays.asList("../x")), "nor do path-like ones");

        File proc = Files.createTempDirectory("fakeproc").toFile();
        write(new File(proc, "stat"), "cpu  100 0 50 800 5 0 1 0 0 0\ncpu0 50 0 25 400 2 0 1 0 0 0\ncpu1 50 0 25 400 3 0 0 0 0 0\nintr 1 2 3\n");
        File p123 = new File(proc, "123");
        p123.mkdir();
        write(new File(p123, "cmdline"), "com.app\0--flag\0");
        write(new File(p123, "stat"), "123 (com.app) S 1 1 1 0 -1 4194560 100 0 0 0 7 3 0 0 20 0 5 0 4242 0 0\n");
        File p124 = new File(proc, "124");
        p124.mkdir();
        write(new File(p124, "cmdline"), "com.app:push\0");
        write(new File(p124, "stat"), "124 (com.app:push) S 1 1 1 0 -1 0 0 0 0 0 1 1 0 0 20 0 2 0 4343 0 0\n");
        File p125 = new File(proc, "125");
        p125.mkdir();
        write(new File(p125, "cmdline"), "com.other\0");
        write(new File(p125, "stat"), "125 (com.other) S 1\n");
        File p126 = new File(proc, "126");
        p126.mkdir();
        write(new File(p126, "cmdline"), "");               // kernel thread: no name
        new File(proc, "self").mkdir();                      // non-numeric entry
        File p127 = new File(proc, "127");
        p127.mkdir();
        write(new File(p127, "cmdline"), "com.app:gone\0"); // no stat: ended between the reads

        String out = ProcProbe.probe(proc, Arrays.asList("com.app"));
        List<String> lines = new ArrayList<>(Arrays.asList(out.split("\n")));
        isTrue(lines.get(0).startsWith("cpu  100") && lines.get(1).startsWith("cpu0") && lines.get(2).startsWith("cpu1"),
                "the cpu lines come first, aggregate then cores");
        isTrue(!out.contains("intr"), "and nothing else from /proc/stat");
        isTrue(out.contains("P 123 com.app\n123 (com.app) S 1"), "the app's main process: P line, then its stat line");
        isTrue(out.contains("P 124 com.app:push\n124 (com.app:push)"), "and its extra process");
        isTrue(!out.contains("com.other") && !out.contains("126") && !out.contains("127"), "others, nameless and vanished ones are left out");
        eq("", ProcProbe.probe(new File(proc, "missing"), Arrays.asList("com.app")), "no /proc/stat: nothing");
        isTrue(!ProcProbe.probe(proc, new ArrayList<String>()).contains("P "), "no packages: counters only");

        String real = ProcProbe.probe(Arrays.asList("java"));
        isTrue(real.startsWith("cpu") && real.contains("\nP "), "this machine's /proc: counters and this JVM");
    }


    // ------------------------------------------------------------------ FsWire / FsPolicy / FsOps

    private static void fsWire() {
        FsWire.Request r = FsWire.parse("fs_list " + FsWire.encode("/sdcard/DCIM") + " - 500");
        isTrue(r.error == null && "fs_list".equals(r.command) && r.args.length == 3, "fs_list parses with three arguments");
        eq("bad_request", FsWire.parse("fs_list abc").error, "a wrong argument count is bad_request");
        eq("unknown_command", FsWire.parse("fs_format x").error, "an unknown fs_ command is refused");
        eq(null, FsWire.parse("FS_ROOTS").error, "command words are case-insensitive");
        isTrue(FsWire.isFsCommand("fs_stat") && !FsWire.isFsCommand("shell") && !FsWire.isFsCommand(null), "isFsCommand");

        eq("/sdcard/ş ö/a b", FsWire.decode(FsWire.encode("/sdcard/ş ö/a b")), "unicode and spaces survive");
        eq(null, FsWire.decode("%%%"), "invalid base64 is refused");
        eq(null, FsWire.decode(""), "empty is refused");
        eq(null, FsWire.decode(java.util.Base64.getEncoder().encodeToString(new byte[] {(byte) 0xC3, 0x28})), "invalid UTF-8 is refused");
        eq(null, FsWire.decode(FsWire.encode("a\0b")), "NUL is refused");
        eq("a\nb", FsWire.decode(FsWire.encode("a\nb")), "a newline inside base64 is just data (the LINE protocol never sees it)");

        List<String> batch = FsWire.decodeBatch(FsWire.encode("/a\n/b c\n/ş"));
        eq(Arrays.asList("/a", "/b c", "/ş"), batch, "a batch splits on newlines");
        eq(null, FsWire.decodeBatch(FsWire.encode("/a\n\n/b")), "an empty entry makes the batch malformed");
        StringBuilder many = new StringBuilder();
        for (int i = 0; i <= FsWire.MAX_BATCH; i++) many.append("/p").append(i).append('\n');
        many.setLength(many.length() - 1);
        eq(null, FsWire.decodeBatch(FsWire.encode(many.toString())), "over MAX_BATCH entries is refused");

        eq(FsWire.DEFAULT_PAGE, FsWire.clampPage("x"), "a garbage page size gets the default");
        eq(1, FsWire.clampPage("0"), "page size is at least 1");
        eq(FsWire.MAX_PAGE, FsWire.clampPage("999999"), "and at most MAX_PAGE");
        eq(256, FsWire.clampThumb("junk"), "thumbnail default edge");
        eq(FsWire.MAX_THUMB_PX, FsWire.clampThumb("5000"), "thumbnail edge is capped");
        eq(FsWire.THUMB_IMAGE, FsWire.thumbKind("IMG_1.JPG"), "thumbKind image, case-insensitive");
        eq(FsWire.THUMB_VIDEO, FsWire.thumbKind("a.b.mp4"), "thumbKind video");
        eq(FsWire.THUMB_NONE, FsWire.thumbKind("README"), "no extension: no thumbnail");
        eq(FsWire.THUMB_NONE, FsWire.thumbKind("archive."), "a trailing dot: no thumbnail");
        isTrue(FsWire.flag("p", 'p') && !FsWire.flag("-", 'p') && !FsWire.flag("pp", 'p') && !FsWire.flag(null, 'p'), "flags");
    }

    private static File tempDir(String prefix) throws IOException {
        return Files.createTempDirectory(prefix).toFile().getCanonicalFile();
    }

    private static FsPolicy policyFor(File root) {
        return new FsPolicy(Arrays.asList(root.getPath()), Arrays.asList(java.util.regex.Pattern.compile(root.getPath() + "/Android(/data)?")));
    }

    private interface Action {
        void run() throws Exception;
    }

    private static String code(Action call) {
        try {
            call.run();
            return "no failure";
        } catch (FsOps.Failure f) {
            return f.code;
        } catch (Exception e) {
            return "unexpected " + e;
        }
    }

    private static void fsPolicy() throws Exception {
        File base = tempDir("fs-policy");
        File root = new File(base, "storage");
        File outside = new File(base, "outside");
        isTrue(root.mkdirs() && outside.mkdirs(), "fixture");
        write(new File(outside, "secret.txt"), "secret");
        File dcim = new File(root, "DCIM");
        isTrue(dcim.mkdirs(), "fixture dcim");
        write(new File(dcim, "a.jpg"), "x");
        Files.createSymbolicLink(new File(root, "inside-link").toPath(), dcim.toPath());
        Files.createSymbolicLink(new File(root, "escape-link").toPath(), outside.toPath());
        Files.createSymbolicLink(new File(root, "dangling").toPath(), new File(base, "nowhere").toPath());
        FsPolicy policy = policyFor(root);

        eq(dcim.getPath(), policy.lexical(root + "/DCIM/../DCIM"), ".. is resolved lexically");
        eq("outside_roots", code(() -> policy.lexical(root + "/../outside/secret.txt")), ".. cannot climb out");
        eq("outside_roots", code(() -> policy.lexical(root + "x/DCIM")), "a sibling that merely shares the prefix is outside");
        eq("bad_request", code(() -> policy.lexical("DCIM")), "relative paths are refused");
        eq("bad_request", code(() -> policy.lexical(root + "/a\nb")), "a line break is refused");
        eq("bad_request", code(() -> policy.lexical(root + "/a\0b")), "NUL is refused");

        eq(dcim.getPath(), policy.existing(root + "/inside-link").toString(), "a link that stays inside is followed");
        eq("outside_roots", code(() -> policy.existing(root + "/escape-link")), "a link that leads out is refused");
        eq("outside_roots", code(() -> policy.existing(root + "/escape-link/secret.txt")), "and so is anything beneath it");
        eq("not_found", code(() -> policy.existing(root + "/missing")), "missing is not_found");
        eq("not_found", code(() -> policy.existing(root + "/dangling")), "a dangling link cannot be entered");

        eq(new File(root, "escape-link").getPath(), policy.entry(root + "/escape-link").toString(),
                "entry() keeps a link as the link: deleting it must not touch its target");
        eq("not_found", code(() -> policy.entry(root + "/missing")), "entry of a missing name");
        eq(new File(dcim, "new").getPath(), policy.forCreate(root + "/DCIM/new").toString(), "forCreate: parent real, leaf kept");
        eq("not_found", code(() -> policy.forCreate(root + "/nope/new")), "forCreate: the parent must exist");
        StringBuilder longName = new StringBuilder();
        for (int i = 0; i < 256; i++) longName.append('a');
        eq("invalid_name", code(() -> policy.forCreate(root + "/DCIM/" + longName)), "a 256-byte name is refused");

        eq(new File(root, "n1/n2/n3").getPath(), policy.forCreateWithParents(root + "/n1/n2/n3").toString(), "mkdir -p: the missing parents are appended to the deepest existing folder");
        eq(new File(dcim, "x/y").getPath(), policy.forCreateWithParents(root + "/DCIM/x/y").toString(), "mkdir -p under an existing folder");
        eq("outside_roots", code(() -> policy.forCreateWithParents(root + "/escape-link/new/deeper")), "mkdir -p cannot start from a link that leads out");
        eq("outside_roots", code(() -> policy.forCreateWithParents(root + "/../outside/new")), "mkdir -p cannot climb out");
        eq("invalid_name", code(() -> policy.forCreateWithParents(root + "/n1/" + longName)), "mkdir -p: a missing part over 255 bytes");

        File android = new File(root, "Android");
        isTrue(android.mkdirs() && new File(android, "data").mkdirs(), "fixture android");
        isTrue(policy.isProtected(android.toPath()) && policy.isProtected(new File(android, "data").toPath()), "Android and Android/data are protected");
        isTrue(!policy.isProtected(dcim.toPath()), "DCIM is not");
    }

    private static List<String> names(FsOps.Page page) {
        List<String> out = new ArrayList<>();
        for (FsOps.Item item : page.items) out.add(item.name);
        return out;
    }

    private static void fsOps() throws Exception {
        File base = tempDir("fs-ops");
        File dir = new File(base, "d");
        isTrue(dir.mkdirs(), "fixture");
        for (int i = 0; i < 25; i++) write(new File(dir, String.format("f%02d.txt", i)), "12345");
        write(new File(dir, ".hidden"), "h");
        // The JVM maps file names with the locale's encoding: under a POSIX locale a non-ASCII name cannot be created at all.
        boolean unicode = "UTF-8".equalsIgnoreCase(System.getProperty("sun.jnu.encoding"));
        if (unicode) write(new File(dir, "ş ö ğ.txt"), "x");
        write(new File(dir, "line\nbreak.txt"), "x");
        isTrue(new File(dir, "sub").mkdirs(), "fixture sub");
        long fixed = 1_650_000_000L;
        isTrue(new File(dir, "f00.txt").setLastModified(fixed * 1000), "fixture mtime");

        // paging: a NAME cursor, stable while the folder changes
        FsOps.Page p1 = FsOps.list(dir.toPath(), null, 10);
        eq(10, p1.items.size(), "first page has `limit` items");
        isTrue(p1.next != null, "and a cursor");
        FsOps.Page p2 = FsOps.list(dir.toPath(), p1.next, 10);
        isTrue(p2.items.size() == 10 && p2.next != null, "second page");
        final String vanished = names(p2).get(0);
        // The vanished entry is the NEXT one to be listed, so page 3 must trip over it. The folder's modification time is put
        // back as it was (a coarse-clock file system such as FAT, 2 s granularity, does not move it): the cached names are
        // then stale, which is exactly the case where an entry can be gone between the readdir and the stat.
        long stamp = dir.lastModified();
        final String gone = FsOps.list(dir.toPath(), p2.next, 1).items.get(0).name;
        isTrue(new File(dir, gone).delete(), "the entry that would head page 3 disappears");
        isTrue(dir.setLastModified(stamp), "fixture: the folder looks untouched");
        FsOps.Page p3 = FsOps.list(dir.toPath(), p2.next, 10);
        eq(null, p3.next, "the last page has no cursor");
        List<String> all = new ArrayList<>(names(p1));
        all.addAll(names(p2));
        all.addAll(names(p3));
        eq(all.size(), new java.util.HashSet<>(all).size(), "no entry is returned twice across pages");
        isTrue(all.contains(".hidden") && all.contains("line\nbreak.txt") && (!unicode || all.contains("ş ö ğ.txt")), "odd names are listed (hidden, unicode, newline)");
        eq(unicode ? 28 : 27, all.size(), "every entry came back exactly once, minus the one that vanished (" + vanished + " had been returned already)");
        isTrue(!names(p3).contains(gone), "and the entry that vanished between readdir and stat is skipped, not an error");

        FsOps.Page whole = FsOps.list(dir.toPath(), null, 2000);
        eq(null, whole.next, "a page size above the folder size ends the listing");
        FsOps.Item hidden = null;
        FsOps.Item f00 = null;
        FsOps.Item sub = null;
        for (FsOps.Item it : whole.items) {
            if (it.name.equals(".hidden")) hidden = it;
            if (it.name.equals("f00.txt")) f00 = it;
            if (it.name.equals("sub")) sub = it;
        }
        isTrue(hidden != null && (hidden.flags & FsOps.F_HIDDEN) != 0, "dot files carry the hidden flag");
        isTrue(f00 != null && f00.size == 5 && f00.mtimeSec == fixed && !f00.dir, "size and mtime in seconds");
        isTrue(sub != null && sub.dir && sub.size == 0, "a directory has size 0");

        eq("not_found", code(() -> FsOps.list(new File(base, "missing").toPath(), null, 10)), "listing a missing folder");
        eq("not_a_dir", code(() -> FsOps.list(new File(dir, "f01.txt").toPath(), null, 10)), "listing a file");
        FsOps.Page empty = FsOps.list(sub.dir ? new File(dir, "sub").toPath() : null, null, 10);
        isTrue(empty.items.isEmpty() && empty.next == null, "an empty folder");

        // links: described as links; the target's kind decides whether they can be entered
        File outside = new File(base, "outside");
        isTrue(outside.mkdirs(), "fixture outside");
        write(new File(outside, "secret.txt"), "secret");
        Files.createSymbolicLink(new File(dir, "dirlink").toPath(), outside.toPath());
        Files.createSymbolicLink(new File(dir, "filelink").toPath(), new File(dir, "f01.txt").toPath());
        Files.createSymbolicLink(new File(dir, "dangling").toPath(), new File(base, "nowhere").toPath());
        FsOps.forgetNames();
        FsOps.Item dirLink = FsOps.stat(new File(dir, "dirlink").toPath());
        isTrue(dirLink.dir && (dirLink.flags & FsOps.F_SYMLINK) != 0 && outside.getPath().equals(dirLink.target), "a link to a folder is a symlink folder");
        FsOps.Item fileLink = FsOps.stat(new File(dir, "filelink").toPath());
        isTrue(!fileLink.dir && fileLink.size == 5 && (fileLink.flags & FsOps.F_SYMLINK) != 0, "a link to a file shows the file's size");
        FsOps.Item dangling = FsOps.stat(new File(dir, "dangling").toPath());
        isTrue(!dangling.dir && (dangling.flags & FsOps.F_SYMLINK) != 0, "a dangling link is listed, not fatal");
        eq("not_found", code(() -> FsOps.stat(new File(dir, "nothing").toPath())), "stat of a missing entry");

        // mkdir
        FsOps.mkdir(new File(dir, "new").toPath(), false);
        isTrue(new File(dir, "new").isDirectory(), "mkdir");
        eq("exists", code(() -> FsOps.mkdir(new File(dir, "new").toPath(), false)), "mkdir on an existing name");
        FsOps.mkdir(new File(dir, "p/q/r").toPath(), true);
        isTrue(new File(dir, "p/q/r").isDirectory(), "mkdir -p");
        eq("not_found", code(() -> FsOps.mkdir(new File(dir, "x/y").toPath(), false)), "mkdir without parents");
        isTrue(names(FsOps.list(dir.toPath(), null, 2000)).contains("new"), "a listing right after a mkdir sees it (the name cache is dropped)");
        long before = dir.lastModified();
        names(FsOps.list(dir.toPath(), null, 5));                                        // fills the cache
        FsOps.mkdir(new File(dir, "fresh").toPath(), false);
        isTrue(dir.setLastModified(before), "fixture: a coarse clock leaves the folder's modification time as it was");
        isTrue(names(FsOps.list(dir.toPath(), null, 2000)).contains("fresh"), "…and the new folder is still listed: the cache is dropped by the change itself, not by the clock");

        // rename: never replaces unless asked
        write(new File(dir, "a.txt"), "A");
        write(new File(dir, "b.txt"), "B");
        eq("exists", code(() -> FsOps.rename(new File(dir, "a.txt").toPath(), new File(dir, "b.txt").toPath(), false)), "rename onto an existing name");
        eq("B", new String(Files.readAllBytes(new File(dir, "b.txt").toPath()), StandardCharsets.UTF_8), "…and the target is untouched");
        FsOps.rename(new File(dir, "a.txt").toPath(), new File(dir, "c.txt").toPath(), false);
        isTrue(!new File(dir, "a.txt").exists() && new File(dir, "c.txt").exists(), "rename");
        FsOps.rename(new File(dir, "c.txt").toPath(), new File(dir, "b.txt").toPath(), true);
        eq("A", new String(Files.readAllBytes(new File(dir, "b.txt").toPath()), StandardCharsets.UTF_8), "rename with overwrite replaces");
        eq("not_found", code(() -> FsOps.rename(new File(dir, "ghost").toPath(), new File(dir, "g2").toPath(), false)), "rename of a missing entry");

        // delete: a tree goes, a link goes but its target stays
        File tree = new File(dir, "tree");
        isTrue(new File(tree, "x/y").mkdirs(), "fixture tree");
        write(new File(tree, "x/y/f.txt"), "1");
        write(new File(tree, "top.txt"), "2");
        Files.createSymbolicLink(new File(tree, "x/escape").toPath(), outside.toPath());
        long removed = FsOps.delete(tree.toPath());
        isTrue(!tree.exists() && removed == 6, "a whole tree is removed (counted: " + removed + ")");
        isTrue(new File(outside, "secret.txt").exists(), "…without following the link inside it");
        FsOps.delete(new File(dir, "dirlink").toPath());
        isTrue(!Files.exists(new File(dir, "dirlink").toPath(), java.nio.file.LinkOption.NOFOLLOW_LINKS) && new File(outside, "secret.txt").exists(),
                "deleting a link removes the link only");
        eq("not_found", code(() -> FsOps.delete(new File(dir, "ghost").toPath())), "delete of a missing entry");

        // volumes
        File storage = new File(base, "storage");
        isTrue(new File(storage, "emulated/0").mkdirs() && new File(storage, "1234-ABCD").mkdirs() && new File(storage, "self").mkdirs(), "fixture volumes");
        File tmp = new File(base, "tmp");
        isTrue(tmp.mkdirs(), "fixture tmp");
        List<FsOps.Volume> vols = FsOps.volumes(storage.toPath(), tmp.toPath());
        eq(3, vols.size(), "internal + one removable + tmp (`self` is not a volume)");
        eq("internal", vols.get(0).kind, "the internal volume comes first");
        eq("removable", vols.get(1).kind, "then the card");
        eq("tmp", vols.get(2).kind, "then the adb scratch folder");
        isTrue(vols.get(0).total > 0 && vols.get(0).free > 0 && vols.get(0).free <= vols.get(0).total, "sizes come from the file store");
    }

    // ------------------------------------------------------------------ helpers

    private static void write(File f, String s) throws IOException {
        Files.write(f.toPath(), s.getBytes(StandardCharsets.UTF_8));
    }

    private static String text(byte[] b) {
        return new String(b, StandardCharsets.UTF_8);
    }

    private static long ms(long t0) {
        return (System.nanoTime() - t0) / 1_000_000L;
    }

    private static void eq(Object expected, Object actual, String what) {
        checks++;
        boolean same = expected == null ? actual == null : expected.equals(actual);
        if (!same) throw new AssertionError(what + ": expected <" + expected + "> but was <" + actual + ">");
    }

    private static void near(double expected, double actual, double tolerance, String what) {
        isTrue(Math.abs(expected - actual) <= tolerance, what + ": expected " + expected + " got " + actual);
    }

    private static void isTrue(boolean condition, String what) {
        checks++;
        if (!condition) throw new AssertionError(what);
    }
}
