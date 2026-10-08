package com.opendex.tools;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.Executors;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.ThreadFactory;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * Runs one shell command the way {@code adb shell <command>} does — {@code sh -c <command>}, stdin closed, stdout and
 * stderr kept apart, the exit status reported — and reports what happened. The backend sends every device command here
 * first (no host-side {@code adb} process, no new stream on the adb transport per command) and falls back to adb only
 * when the daemon cannot take it.
 *
 * <p>Pure Java (no Android classes): the daemon's wire layer lives in {@link OpenDexDaemon}; this class is exercised on
 * a plain JVM by {@code backend/java/test}.
 *
 * <p>Guarantees, each one a failure mode of a naive {@code ProcessBuilder} call:
 * <ul>
 *   <li><b>Bounded time.</b> A watchdog destroys the process at the deadline; the result says {@code timedOut}.</li>
 *   <li><b>No hang on orphans.</b> Killing {@code sh} leaves its children holding the pipes open, so a blocked
 *       {@code read} would outlive the timeout. The pumps are joined with a short grace and then abandoned (they are
 *       daemon threads that end with the orphan) — the caller always gets its result in time.</li>
 *   <li><b>Bounded memory.</b> Output beyond {@code maxOutputBytes} kills the process and sets {@code tooLarge}
 *       (the caller falls back to adb, which has no cap, instead of acting on silently truncated output).</li>
 *   <li><b>Bounded concurrency.</b> At most {@code maxConcurrent} commands run, {@code queueCapacity} wait; beyond that
 *       {@link #submit} refuses at once ("busy") and the caller uses adb instead of piling work onto the phone.</li>
 * </ul>
 */
final class ShellRunner {

    /** What the command did. Output bytes are what was read before the process ended (or was killed). */
    static final class Result {
        final int exitCode;
        final byte[] stdout;
        final byte[] stderr;
        final boolean timedOut;
        final boolean tooLarge;
        /** Non-null when the process could not even be started (nothing ran). */
        final String startError;
        final long elapsedMs;

        Result(int exitCode, byte[] stdout, byte[] stderr, boolean timedOut, boolean tooLarge, String startError,
               long elapsedMs) {
            this.exitCode = exitCode;
            this.stdout = stdout;
            this.stderr = stderr;
            this.timedOut = timedOut;
            this.tooLarge = tooLarge;
            this.startError = startError;
            this.elapsedMs = elapsedMs;
        }
    }

    interface Callback {
        /** Called exactly once, on a runner thread. Must not block for long. */
        void done(Result result);
    }

    /**
     * Variables a command must NOT inherit from the daemon. The token is the credential that guards this very socket —
     * a command that printed its environment would hand it to whatever reads the output. CLASSPATH is an artefact of
     * how the daemon itself was launched (our jar); an {@code adb shell} command does not have it.
     */
    static final String[] SCRUBBED_ENV = {"OPENDEX_DAEMON_TOKEN", "CLASSPATH"};

    /** How long a pump may linger after its process is gone (an orphaned grandchild can keep the pipe open). */
    private static final long PUMP_GRACE_MS = 250;
    private static final int STDERR_CAP_BYTES = 64 * 1024;

    private final ThreadPoolExecutor jobs;
    private final ScheduledExecutorService watchdog;
    private final ThreadFactory pumpThreads = daemonThreads("OpenDex-ShellPump");

    ShellRunner(int maxConcurrent, int queueCapacity) {
        this.jobs = new ThreadPoolExecutor(maxConcurrent, maxConcurrent, 30, TimeUnit.SECONDS,
                new ArrayBlockingQueue<Runnable>(queueCapacity), daemonThreads("OpenDex-Shell"),
                new ThreadPoolExecutor.AbortPolicy());
        this.jobs.allowCoreThreadTimeOut(true);
        this.watchdog = Executors.newSingleThreadScheduledExecutor(daemonThreads("OpenDex-ShellWatchdog"));
    }

    /** Queues the command. False when the runner is saturated — nothing was started and {@code cb} will not be called. */
    boolean submit(final String command, final long timeoutMs, final int maxOutputBytes, final Callback cb) {
        try {
            jobs.execute(new Runnable() {
                @Override
                public void run() {
                    Result r;
                    try {
                        r = ShellRunner.this.run(command, timeoutMs, maxOutputBytes);
                    } catch (Throwable t) {
                        r = new Result(-1, new byte[0], new byte[0], false, false,
                                "runner_failed: " + t.getClass().getSimpleName(), 0);
                    }
                    cb.done(r);
                }
            });
            return true;
        } catch (RejectedExecutionException saturated) {
            return false;
        }
    }

    /** Runs the command on the calling thread (see class doc for the guarantees). */
    Result run(String command, final long timeoutMs, final int maxOutputBytes) {
        final long started = System.nanoTime();
        final Process process;
        try {
            ProcessBuilder builder = new ProcessBuilder("sh", "-c", command);
            for (String name : SCRUBBED_ENV) builder.environment().remove(name);
            process = builder.start();
        } catch (Throwable t) {
            return new Result(-1, new byte[0], new byte[0], false, false,
                    "start_failed: " + t.getClass().getSimpleName() + ": " + t.getMessage(), elapsedMs(started));
        }
        try {
            process.getOutputStream().close(); // stdin: EOF at once, like a non-interactive adb shell
        } catch (IOException ignored) {
        }

        final AtomicBoolean timedOut = new AtomicBoolean(false);
        final AtomicBoolean tooLarge = new AtomicBoolean(false);
        ScheduledFuture<?> deadline = watchdog.schedule(new Runnable() {
            @Override
            public void run() {
                timedOut.set(true);
                process.destroyForcibly();
            }
        }, timeoutMs, TimeUnit.MILLISECONDS);

        Pump out = new Pump(process.getInputStream(), maxOutputBytes, process, tooLarge);
        Pump err = new Pump(process.getErrorStream(), STDERR_CAP_BYTES, process, null);
        Thread outThread = pumpThreads.newThread(out);
        Thread errThread = pumpThreads.newThread(err);
        outThread.start();
        errThread.start();

        int exit = -1;
        try {
            exit = process.waitFor();
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
            process.destroyForcibly();
        } finally {
            deadline.cancel(false);
        }
        join(outThread);
        join(errThread);
        closeQuietly(process.getInputStream());
        closeQuietly(process.getErrorStream());

        return new Result(exit, out.bytes(), err.bytes(), timedOut.get(), tooLarge.get(), null, elapsedMs(started));
    }

    private static void join(Thread pump) {
        try {
            pump.join(PUMP_GRACE_MS);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
    }

    private static long elapsedMs(long startedNanos) {
        return (System.nanoTime() - startedNanos) / 1_000_000L;
    }

    private static void closeQuietly(InputStream in) {
        try {
            in.close();
        } catch (IOException ignored) {
        }
    }

    /** Reads one stream into a capped buffer; past the cap it kills the process (when {@code tooLarge} is given). */
    private static final class Pump implements Runnable {
        private final InputStream in;
        private final int cap;
        private final Process process;
        private final AtomicBoolean tooLarge;
        private final ByteArrayOutputStream buffer = new ByteArrayOutputStream();

        Pump(InputStream in, int cap, Process process, AtomicBoolean tooLarge) {
            this.in = in;
            this.cap = cap;
            this.process = process;
            this.tooLarge = tooLarge;
        }

        @Override
        public void run() {
            byte[] chunk = new byte[8192];
            try {
                int n;
                while ((n = in.read(chunk)) != -1) {
                    synchronized (buffer) {
                        int room = cap - buffer.size();
                        if (n > room) {
                            buffer.write(chunk, 0, Math.max(room, 0));
                            if (tooLarge != null) {
                                tooLarge.set(true);
                                process.destroyForcibly();
                                return;
                            }
                            continue; // stderr: keep draining so the process is not blocked, drop the excess
                        }
                        buffer.write(chunk, 0, n);
                    }
                }
            } catch (IOException ignored) {
                // the process was killed or the stream closed: what we have is what there is
            }
        }

        byte[] bytes() {
            synchronized (buffer) {
                return buffer.toByteArray();
            }
        }
    }

    private static ThreadFactory daemonThreads(final String name) {
        final AtomicInteger n = new AtomicInteger();
        return new ThreadFactory() {
            @Override
            public Thread newThread(Runnable r) {
                Thread t = new Thread(r, name + "-" + n.incrementAndGet());
                t.setDaemon(true);
                return t;
            }
        };
    }
}
