package com.opendex.tools;

/**
 * The test sound of the "İkisi" calibration (the DeX page listens with the laptop's microphone and measures how far apart
 * the phone's copy and its own are heard — see frontend/src/media/syncCalibration.js).
 *
 * A short LINEAR CHIRP, Hann-windowed: a click's onset is smeared by every speaker and room, but a chirp has a sharp peak
 * under a matched filter however it is coloured. The phone sweeps 1.5→3.1 kHz and the page 5.1→3.5 kHz: two DISJOINT bands,
 * so a matched filter for one hardly answers to the other — even when one copy is far louder than the other, or the two
 * overlap in the recording. The page generates the same formula (syncCalibration.js `chirp`); both tests pin the same
 * reference samples.
 *
 * Plain Java, no Android types (tested on a JVM by PureClassesSelfTest).
 */
final class ProbeTone {

    /** The capture format (AudioRouter.SAMPLE_RATE / BYTES_PER_FRAME) — repeated here so this class stays free of Android types. */
    static final int SAMPLE_RATE = 48_000;
    static final int BYTES_PER_FRAME = 4;
    /** Exactly one capture chunk; time × bandwidth ≈ 32 is a sharp matched-filter peak (≈ 0.6 ms) with room for sub-sample timing. */
    static final int DURATION_MS = 20;
    /** The phone sweeps UP over its band; the page sweeps DOWN over a band of its own (disjoint: no crosstalk). */
    static final double PHONE_F0_HZ = 1500;
    static final double PHONE_F1_HZ = 3100;
    static final double PAGE_F0_HZ = 5100;
    static final double PAGE_F1_HZ = 3500;
    /** Loud enough to be heard over a room, far from clipping a phone speaker. */
    static final double AMPLITUDE = 0.6;
    /** One capture chunk (20 ms): the tone starts at the chunk's first frame, so the chunk's presentation time IS the tone's start. */
    static final int CHUNK_FRAMES = SAMPLE_RATE / 50;

    private ProbeTone() {}

    /** A Hann-windowed linear chirp f0 → f1 over {@code durationMs}; the same formula as the page's. */
    static float[] chirp(int sampleRate, int durationMs, double f0, double f1) {
        int n = sampleRate * durationMs / 1000;
        float[] out = new float[n];
        double seconds = n / (double) sampleRate;
        double sweep = (f1 - f0) / seconds;
        for (int i = 0; i < n; i++) {
            double t = i / (double) sampleRate;
            double window = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (n - 1));
            out[i] = (float) (Math.sin(2 * Math.PI * (f0 * t + 0.5 * sweep * t * t)) * window);
        }
        return out;
    }

    /**
     * The phone's test tone as one 20 ms stereo s16le chunk (the chirp fills it): what {@link PhoneRender#offer}
     * takes. Both channels carry it (the phone's speaker is mono anyway).
     */
    static byte[] phoneChunk(double gain) {
        float[] mono = chirp(SAMPLE_RATE, DURATION_MS, PHONE_F0_HZ, PHONE_F1_HZ);
        byte[] pcm = new byte[CHUNK_FRAMES * BYTES_PER_FRAME];
        for (int i = 0; i < mono.length && i < CHUNK_FRAMES; i++) {
            int v = (int) Math.round(Math.max(-1.0, Math.min(1.0, mono[i] * gain)) * 32767);
            int at = i * BYTES_PER_FRAME;
            pcm[at] = (byte) v;
            pcm[at + 1] = (byte) (v >> 8);
            pcm[at + 2] = (byte) v;
            pcm[at + 3] = (byte) (v >> 8);
        }
        return pcm;
    }
}
