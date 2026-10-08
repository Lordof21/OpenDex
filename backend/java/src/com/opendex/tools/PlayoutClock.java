package com.opendex.tools;

/**
 * The arithmetic of "İkisi": phone and DeX present the same captured moment at the same instant.
 *
 * Every capture chunk carries the device clock's time of its first frame (PTS, {@code System.nanoTime()}); an output is
 * in step when it presents that frame at {@code pts + target}. The DeX page does this on its own side (media/deviceClock +
 * appAudioMixer); this class is the phone's half: given when the track would present the NEXT frame written, how many
 * frames of silence to insert — or of audio to skip — so the chunk lands on time.
 *
 * Plain Java, no Android types (tested on a JVM by PureClassesSelfTest). All times are the device's monotonic clock in
 * nanoseconds — the clock of the capture PTS and of {@code AudioTrack.getTimestamp()}.
 */
final class PlayoutClock {

    /** Within this the output is "in step": correcting for measurement noise would cost more (a click) than it gains. */
    static final long TOLERANCE_NANOS = 6_000_000L;
    /** Until the track reports a timestamp: a frame written now is assumed to leave the speaker this much later. */
    static final long DEFAULT_PIPELINE_NANOS = 40_000_000L;
    /** A frame written now is never presented sooner than this (guards a stale timestamp after an underrun). */
    static final long MIN_PIPELINE_NANOS = 8_000_000L;
    /** One correction never inserts/skips more than this: a runaway estimate must not blank a whole stream. */
    static final long MAX_CORRECTION_NANOS = 2_000_000_000L;

    private PlayoutClock() {}

    /**
     * When a frame written NOW would be presented.
     * With a track timestamp ({@code framePosition} was presented at {@code nanoTime}) the frames still queued ahead of it
     * each take 1/rate; without one the playback head and a typical pipeline stand in.
     */
    static long predictPresentNanos(long nowNanos, long framesWritten, int sampleRate, boolean haveTimestamp,
                                    long tsFramePosition, long tsNanoTime, long headFrames) {
        long predicted;
        if (haveTimestamp) {
            predicted = tsNanoTime + (framesWritten - tsFramePosition) * 1_000_000_000L / sampleRate;
        } else {
            predicted = nowNanos + (framesWritten - headFrames) * 1_000_000_000L / sampleRate + DEFAULT_PIPELINE_NANOS;
        }
        return Math.max(predicted, nowNanos + MIN_PIPELINE_NANOS);
    }

    /**
     * Frames to correct before writing a chunk whose first frame must be presented at {@code desired}:
     * positive = insert that many frames of silence first (the chunk would be early), negative = skip that many frames from
     * its start (it would be late), 0 = in step.
     */
    static long correctionFrames(long desiredPresentNanos, long predictedPresentNanos, int sampleRate) {
        long err = predictedPresentNanos - desiredPresentNanos;        // + : the chunk would be late
        if (Math.abs(err) <= TOLERANCE_NANOS) return 0;
        long capped = Math.max(-MAX_CORRECTION_NANOS, Math.min(MAX_CORRECTION_NANOS, err));
        return -(capped * sampleRate / 1_000_000_000L);
    }
}
