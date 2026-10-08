package com.opendex.tools;

import android.media.AudioAttributes;
import android.media.AudioFormat;
import android.media.AudioTimestamp;
import android.media.AudioTrack;

import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.BlockingQueue;
import java.util.concurrent.TimeUnit;

/**
 * The phone's own copy of an app's sound when the route is "İkisi" and phone and DeX must be heard at the same instant.
 *
 * With the capture policy in LOOP_BACK mode the app is silent on the phone; this class plays the captured PCM back through an
 * {@link AudioTrack} so that every chunk's first frame is PRESENTED at {@code pts + target} on the device clock (see
 * {@link PlayoutClock}) — the same instant the DeX page presents it, because the page reads the same PTS.
 *
 * It does not guess its own latency: the track's {@code getTimestamp()} says when frames really leave the speaker; for each
 * chunk the next frame's presentation time is predicted from it, and silence is inserted (or audio skipped) when that is off
 * by more than a few milliseconds. A track that cannot be built throws from {@link #create}; the caller then keeps the app's
 * own phone playback (LOOP_BACK_RENDER) — sound is never lost, only the alignment.
 */
final class PhoneRender {

    /** Longest target (ms after capture) the phone accepts; the track buffer is sized for it. */
    static final int MAX_TARGET_MS = 1500;
    private static final int QUEUE_CHUNKS = 128;                       // ≈ 2.5 s of 20 ms chunks: a stalled writer drops the oldest
    private static final int BYTES_PER_FRAME = AudioRouter.BYTES_PER_FRAME;
    private static final long PRIME_WAIT_NANOS = 600_000_000L;

    private static final class Chunk {
        final byte[] data;
        final long ptsNanos;

        Chunk(byte[] data, long ptsNanos) {
            this.data = data;
            this.ptsNanos = ptsNanos;
        }
    }

    private final AudioTrack track;
    private final BlockingQueue<Chunk> queue = new ArrayBlockingQueue<>(QUEUE_CHUNKS);
    private final Thread thread;
    private final AudioTimestamp timestamp = new AudioTimestamp();
    private volatile boolean running = true;
    private volatile long targetNanos;
    private long framesWritten;
    private volatile long lastErrorNanos;                              // the last measured misalignment, for the log/diagnosis

    private PhoneRender(AudioTrack track, int targetMs) {
        this.track = track;
        this.targetNanos = targetMs * 1_000_000L;
        this.thread = new Thread(this::run, "OpenDex-PhoneRender");
        this.thread.setDaemon(true);
    }

    static PhoneRender create(int targetMs) {
        return create(targetMs, 0);
    }

    /**
     * @param primeMs silence written (and waited out until the track reports its first timestamp) before the first chunk
     *                is accepted: the first chunk is then placed against a MEASURED latency, not the default guess. The
     *                calibration probe needs that; live capture does not (its first chunks self-correct within a few).
     */
    static PhoneRender create(int targetMs, int primeMs) {
        AudioTrack track = null;
        try {
            AudioAttributes attrs = new AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_MEDIA)
                    .setContentType(AudioAttributes.CONTENT_TYPE_MUSIC)
                    .build();
            AudioFormat format = new AudioFormat.Builder()
                    .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
                    .setSampleRate(AudioRouter.SAMPLE_RATE)
                    .setChannelMask(AudioFormat.CHANNEL_OUT_STEREO)
                    .build();
            int min = AudioTrack.getMinBufferSize(AudioRouter.SAMPLE_RATE, AudioFormat.CHANNEL_OUT_STEREO,
                    AudioFormat.ENCODING_PCM_16BIT);
            // The silence that lines the track up with the PC (up to the target) sits in this buffer, plus headroom.
            int bufferBytes = Math.max(Math.max(min, 0), (MAX_TARGET_MS + 300) * (BYTES_PER_FRAME * AudioRouter.SAMPLE_RATE / 1000));
            track = new AudioTrack.Builder()
                    .setAudioAttributes(attrs)
                    .setAudioFormat(format)
                    .setBufferSizeInBytes(bufferBytes)
                    .setTransferMode(AudioTrack.MODE_STREAM)
                    .build();
            if (track.getState() != AudioTrack.STATE_INITIALIZED) {
                throw new IllegalStateException("AudioTrack not initialized");
            }
            track.play();
            PhoneRender render = new PhoneRender(track, targetMs);
            if (primeMs > 0) render.prime(primeMs);
            render.thread.start();
            Log.info("PhoneRender", "started target=" + targetMs + "ms buffer=" + bufferBytes + "B");
            return render;
        } catch (RuntimeException e) {
            if (track != null) {
                try { track.release(); } catch (Throwable ignored) {}
            }
            throw e;
        }
    }

    /** Silence in, then wait (briefly) for the track's first timestamp — runs before the render thread exists. */
    private void prime(int ms) {
        writeSilence((long) ms * AudioRouter.SAMPLE_RATE / 1000);
        long deadline = System.nanoTime() + PRIME_WAIT_NANOS;
        while (System.nanoTime() < deadline) {
            try {
                if (track.getTimestamp(timestamp)) return;
            } catch (Throwable ignored) {
                return;
            }
            try {
                Thread.sleep(10);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                return;
            }
        }
    }

    /** Called from the capture's reader thread for every chunk; copies, never blocks. */
    void offer(byte[] data, int len, long ptsNanos) {
        if (!running || len <= 0) return;
        Chunk c = new Chunk(java.util.Arrays.copyOf(data, len), ptsNanos);
        if (!queue.offer(c)) {
            queue.poll();                                              // the writer is stuck: freshness wins
            queue.offer(c);
        }
    }

    /** Retunes in place: the next chunk is placed against the new target (silence inserted, or audio skipped, once). */
    void setTargetMs(int targetMs) {
        targetNanos = Math.max(0, Math.min(MAX_TARGET_MS, targetMs)) * 1_000_000L;
    }

    int targetMs() {
        return (int) (targetNanos / 1_000_000L);
    }

    private void run() {
        try {
            android.os.Process.setThreadPriority(android.os.Process.THREAD_PRIORITY_URGENT_AUDIO);
        } catch (Throwable ignored) {}
        try {
            while (running) {
                Chunk chunk = queue.poll(100, TimeUnit.MILLISECONDS);
                if (chunk == null) continue;
                place(chunk);
            }
        } catch (InterruptedException ignored) {
            // closed while waiting
        } catch (Throwable t) {
            // An uncaught exception on any thread kills the app_process daemon (and with it every capture).
            Log.warn("PhoneRender", "renderer crashed: " + t);
        }
    }

    /** Writes the chunk where the common timeline wants it: silence first when it would be early, its head skipped when late. */
    private void place(Chunk chunk) {
        final int rate = AudioRouter.SAMPLE_RATE;
        long now = System.nanoTime();
        boolean haveTimestamp = false;
        try {
            haveTimestamp = track.getTimestamp(timestamp);
        } catch (Throwable ignored) {}
        long head = track.getPlaybackHeadPosition() & 0xFFFFFFFFL;
        long predicted = PlayoutClock.predictPresentNanos(now, framesWritten, rate, haveTimestamp,
                timestamp.framePosition, timestamp.nanoTime, head);
        long desired = chunk.ptsNanos + targetNanos;
        lastErrorNanos = predicted - desired;
        long correction = PlayoutClock.correctionFrames(desired, predicted, rate);

        int chunkFrames = chunk.data.length / BYTES_PER_FRAME;
        int skip = 0;
        if (correction > 0) {
            writeSilence(correction);
        } else if (correction < 0) {
            if (-correction >= chunkFrames) return;                    // wholly stale: the next chunk is re-evaluated anyway
            skip = (int) -correction;
        }
        int offset = skip * BYTES_PER_FRAME;
        int length = chunk.data.length - offset;
        write(chunk.data, offset, length);
        framesWritten += length / BYTES_PER_FRAME;
    }

    private void writeSilence(long frames) {
        byte[] zeros = new byte[(int) Math.min(frames, 4800) * BYTES_PER_FRAME];     // ≤ 100 ms per write
        long left = frames;
        while (left > 0 && running) {
            int n = (int) Math.min(left, zeros.length / BYTES_PER_FRAME);
            write(zeros, 0, n * BYTES_PER_FRAME);
            framesWritten += n;
            left -= n;
        }
    }

    private void write(byte[] data, int offset, int length) {
        int off = offset;
        int end = offset + length;
        while (off < end && running) {
            int written = track.write(data, off, end - off);           // blocking: paces itself to the track
            if (written <= 0) break;
            off += written;
        }
    }

    /** Idempotent: stops feeding and drops what was queued (it must not play after the app is back on the phone). */
    void close() {
        if (!running) return;
        running = false;
        queue.clear();
        thread.interrupt();
        try { thread.join(300); } catch (InterruptedException ignored) {}
        try { track.pause(); } catch (Throwable ignored) {}
        try { track.flush(); } catch (Throwable ignored) {}
        try { track.release(); } catch (Throwable ignored) {}
        Log.info("PhoneRender", "stopped (last misalignment " + lastErrorNanos / 1_000_000L + " ms)");
    }
}
