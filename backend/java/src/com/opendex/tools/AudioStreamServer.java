package com.opendex.tools;

import android.net.Credentials;
import android.net.LocalServerSocket;
import android.net.LocalSocket;

import java.io.OutputStream;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.BlockingQueue;

/**
 * Binary PCM out-channel on localabstract:opendex_audio (the backend forwards it to PC :28101). Exactly ONE consumer
 * (the backend); a new connection replaces the old one. Same peer-UID gate as the control socket.
 *
 * Frame (big-endian): u16 stream_id | u16 flags | u64 pts_us | u32 size | size bytes of s16le stereo 48 kHz PCM.
 *
 * Capture threads never touch the socket: {@link #send} only enqueues. The consumer's own writer thread drains a
 * bounded queue and a stalled consumer loses the OLDEST audio (freshness over completeness, like the backend's audio
 * broadcaster) — so a slow PC link can neither block AudioRecord reads nor the daemon's command thread.
 */
final class AudioStreamServer {

    static final String SOCKET_NAME = "opendex_audio";
    static final int HEADER = 16;
    static final int FLAG_END = 0x1;
    /** ≈1.3 s of one 20 ms stream; shared by all streams of the consumer. */
    private static final int QUEUE_FRAMES = 64;
    private static final int TRUSTED_ROOT = 0, TRUSTED_SHELL = 2000;

    private static final Object lock = new Object();
    private static Consumer consumer;

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
                    if (previous != null) previous.close();
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

    /** Enqueues one frame for the current consumer; dropped silently when the PC is not reading. Never blocks. */
    static void send(int streamId, int flags, long ptsUs, byte[] data, int len) {
        Consumer c;
        synchronized (lock) {
            c = consumer;
        }
        if (c == null) return;
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
        c.offer(frame);
    }

    private static void detach(Consumer c) {
        synchronized (lock) {
            if (consumer == c) consumer = null;
        }
    }

    private static final class Consumer {
        private final LocalSocket socket;
        private final OutputStream out;
        private final BlockingQueue<byte[]> queue = new ArrayBlockingQueue<>(QUEUE_FRAMES);
        private final Thread writer;
        private volatile boolean closed;
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

        void offer(byte[] frame) {
            if (closed) return;
            while (!queue.offer(frame)) {
                if (queue.poll() != null && (++dropped % 250) == 1) {
                    Log.warn("AudioStream", "consumer is slow, dropped " + dropped + " frame(s) so far");
                }
            }
        }

        private void writeLoop() {
            try {
                while (!closed) {
                    out.write(queue.take());
                }
            } catch (InterruptedException ignored) {
            } catch (Throwable t) {
                if (!closed) Log.warn("AudioStream", "consumer gone: " + t.getMessage());
            } finally {
                close();
            }
        }

        void close() {
            if (closed) return;
            closed = true;
            detach(this);
            writer.interrupt();
            queue.clear();
            try { socket.close(); } catch (Throwable ignored) {}
        }
    }
}
