package com.opendex.tools;

import android.net.Credentials;
import android.net.LocalServerSocket;
import android.net.LocalSocket;

import java.io.OutputStream;
import java.util.ArrayList;
import java.util.Iterator;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;
import java.util.concurrent.LinkedBlockingDeque;
import java.util.concurrent.TimeUnit;

/**
 * Binary PCM out-channel on localabstract:opendex_audio (the backend forwards it to PC :28101). Exactly ONE consumer
 * (the backend); a new connection replaces the old one. Same peer-UID gate as the control socket.
 *
 * Frame (big-endian): u16 stream_id | u16 flags | u64 pts_us | u32 size | size bytes of s16le stereo 48 kHz PCM.
 *
 * Capture threads never touch the socket: {@link #send} only enqueues. The consumer's own writer thread drains a
 * bounded queue and a stalled consumer loses the OLDEST audio (freshness over completeness, like the backend's audio
 * broadcaster) — so a slow PC link can neither block AudioRecord reads nor the daemon's command thread.
 *
 * The PC reaches this socket over adb, often Wi-Fi, so the link breaks. Audio may be lost then, the END of a stream may not:
 * the backend would keep routing an app to a channel that no longer produces. An END is never evicted from the queue, and
 * one that finds nobody connected (or dies unwritten with its connection) is kept for the next consumer, who gets it first.
 * While idle the writer sends an empty KEEPALIVE frame each second, so the backend can tell a quiet link from a dead one.
 */
final class AudioStreamServer {

    static final String SOCKET_NAME = "opendex_audio";
    static final int HEADER = 16;
    static final int FLAG_END = 0x1;
    static final int FLAG_KEEPALIVE = 0x2;
    /** ≈1.3 s of one 20 ms stream; shared by all streams of the consumer. */
    private static final int QUEUE_FRAMES = 64;
    private static final long KEEPALIVE_MS = 1000;
    private static final byte[] KEEPALIVE_FRAME = frame(0, FLAG_KEEPALIVE, 0, null, 0);
    private static final int TRUSTED_ROOT = 0, TRUSTED_SHELL = 2000;

    private static final Object lock = new Object();
    private static Consumer consumer;
    /** Streams whose END found no consumer to tell (guarded by {@link #lock}); the next consumer hears them first. */
    private static final Set<Integer> unreportedEnds = new LinkedHashSet<>();

    private AudioStreamServer() {}

    static void startAcceptLoop() {
        Thread t = new Thread(() -> {
            try (LocalServerSocket server = new LocalServerSocket(SOCKET_NAME)) {
                while (true) {
                    LocalSocket s = server.accept();
                    Credentials creds = s.getPeerCredentials();
                    if (creds.getUid() != TRUSTED_ROOT && creds.getUid() != TRUSTED_SHELL) {
                        Log.warn("AudioStream", "Rejected untrusted UID: " + creds.getUid());
                        try { s.close(); } catch (Throwable ignored) {}
                        continue;
                    }
                    Consumer next = new Consumer(s, s.getOutputStream());
                    Consumer previous;
                    synchronized (lock) {
                        previous = consumer;
                        consumer = next;
                    }
                    if (previous != null) previous.close();      // its unwritten ENDs land in unreportedEnds
                    List<Integer> missed;
                    synchronized (lock) {
                        missed = new ArrayList<>(unreportedEnds);
                        unreportedEnds.clear();
                    }
                    for (int streamId : missed) next.offer(frame(streamId, FLAG_END, System.nanoTime() / 1000, null, 0));
                    next.start();
                    Log.info("AudioStream", "PC audio consumer connected");
                }
            } catch (Throwable t2) {
                Log.error("AudioStream", "accept loop died: " + t2);
            }
        }, "OpenDex-AudioAccept");
        t.setDaemon(true);
        t.start();
    }

    /** Enqueues one frame for the current consumer; audio is dropped silently when the PC is not reading. Never blocks. */
    static void send(int streamId, int flags, long ptsUs, byte[] data, int len) {
        Consumer c;
        synchronized (lock) {
            c = consumer;
            if (c == null && (flags & FLAG_END) != 0) unreportedEnds.add(streamId);
        }
        if (c != null) c.offer(frame(streamId, flags, ptsUs, data, len));
    }

    private static byte[] frame(int streamId, int flags, long ptsUs, byte[] data, int len) {
        byte[] frame = new byte[HEADER + len];
        frame[0] = (byte) (streamId >>> 8);
        frame[1] = (byte) streamId;
        frame[2] = (byte) (flags >>> 8);
        frame[3] = (byte) flags;
        for (int i = 0; i < 8; i++) frame[4 + i] = (byte) (ptsUs >>> (56 - 8 * i));
        frame[12] = (byte) (len >>> 24);
        frame[13] = (byte) (len >>> 16);
        frame[14] = (byte) (len >>> 8);
        frame[15] = (byte) len;
        if (len > 0) System.arraycopy(data, 0, frame, HEADER, len);
        return frame;
    }

    private static boolean isEnd(byte[] frame) {
        return (frame[3] & FLAG_END) != 0;
    }

    private static void rememberEnd(byte[] frame) {
        synchronized (lock) {
            unreportedEnds.add(((frame[0] & 0xFF) << 8) | (frame[1] & 0xFF));
        }
    }

    private static void detach(Consumer c) {
        synchronized (lock) {
            if (consumer == c) consumer = null;
        }
    }

    private static final class Consumer {
        private final LocalSocket socket;
        private final OutputStream out;
        private final LinkedBlockingDeque<byte[]> queue = new LinkedBlockingDeque<>();
        private final Thread writer;
        private boolean closed;          // guarded by this
        private long dropped;

        Consumer(LocalSocket socket, OutputStream out) {
            this.socket = socket;
            this.out = out;
            this.writer = new Thread(this::writeLoop, "OpenDex-AudioWriter");
            this.writer.setDaemon(true);
        }

        void start() {
            writer.start();
        }

        synchronized void offer(byte[] frame) {
            if (closed) {
                if (isEnd(frame)) rememberEnd(frame);
                return;
            }
            // Full: the oldest AUDIO goes (never an END).
            if (!isEnd(frame) && queue.size() >= QUEUE_FRAMES && dropOldestAudio() && (++dropped % 250) == 1) {
                Log.warn("AudioStream", "consumer is slow, dropped " + dropped + " frame(s) so far");
            }
            queue.addLast(frame);
        }

        private boolean dropOldestAudio() {
            for (Iterator<byte[]> it = queue.iterator(); it.hasNext(); ) {
                if (!isEnd(it.next())) {
                    it.remove();
                    return true;
                }
            }
            return false;
        }

        private void writeLoop() {
            byte[] frame = null;
            try {
                while (!closed) {
                    frame = queue.poll(KEEPALIVE_MS, TimeUnit.MILLISECONDS);
                    out.write(frame != null ? frame : KEEPALIVE_FRAME);
                    frame = null;
                }
            } catch (InterruptedException ignored) {
            } catch (Throwable t) {
                if (!closed) Log.warn("AudioStream", "consumer gone: " + t.getMessage());
            } finally {
                if (frame != null && isEnd(frame)) rememberEnd(frame);    // taken from the queue, never written
                close();
            }
        }

        synchronized void close() {
            if (closed) return;
            closed = true;
            detach(this);
            writer.interrupt();
            for (byte[] frame : queue) {
                if (isEnd(frame)) rememberEnd(frame);
            }
            queue.clear();
            try { socket.close(); } catch (Throwable ignored) {}
        }
    }
}
