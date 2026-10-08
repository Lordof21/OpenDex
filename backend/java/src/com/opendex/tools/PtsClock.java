package com.opendex.tools;

/**
 * Turns "when did this read() return" into a SMOOTH capture timeline.
 *
 * A capture chunk's presentation time is its PTS + a target; the DeX page and the phone's own playback both place every chunk
 * against it. If each chunk carried {@code System.nanoTime()} of the moment its blocking {@code AudioRecord.read()} returned,
 * the PTS would inherit the read's wake-up jitter — several milliseconds, in bursts (two reads back to back, then a gap).
 * Both outputs would then "correct" for jitter that is not in the audio, once per chunk: a run of tiny silences and skipped
 * heads, i.e. stutter.
 *
 * Audio frames themselves are sample-accurate: frame N is exactly N/rate after frame 0. So the PTS of a chunk is
 * {@code anchor + framesBefore / rate} with ONE anchor (the capture time of frame 0), and the anchor is estimated from
 * the reads: a read returns at or AFTER its data was captured, never before, so {@code now − framesSoFar/rate} is the anchor
 * plus a non-negative delay — the true anchor is the LOWEST such value (the lower envelope, as in one-way-delay clock sync).
 * The envelope creeps up a few µs per read so it follows the slow drift between the sample clock and the system clock, and
 * a sustained jump (lost frames after an overrun, a restart) re-anchors it.
 *
 * Plain Java, no Android types (tested on a JVM by PureClassesSelfTest).
 */
final class PtsClock {

    /** The envelope may rise this much per read: follows ±150 ppm of sample-clock drift (3 µs per 20 ms). */
    static final long CREEP_US_PER_READ = 3;
    /** A candidate this far above the envelope is not jitter but lost frames / a gap … */
    static final long JUMP_US = 50_000;
    /** … once it persists for this many reads in a row, the timeline re-anchors. */
    static final int JUMP_READS = 5;

    private final int sampleRate;
    private boolean anchored;
    private long anchorUs;
    private long frames;               // frames delivered before the chunk being stamped
    private int highReads;

    PtsClock(int sampleRate) {
        this.sampleRate = sampleRate;
    }

    /** Forget the timeline (the capture stalled or restarted): the next chunk anchors afresh. */
    void reset() {
        anchored = false;
        frames = 0;
        highReads = 0;
    }

    /**
     * @param nowUs      the system monotonic clock (µs) when the read returned
     * @param framesRead frames that read delivered
     * @return the PTS (µs, the same clock) of the FIRST frame of this chunk
     */
    long stamp(long nowUs, int framesRead) {
        long endFrames = frames + framesRead;
        long candidate = nowUs - endFrames * 1_000_000L / sampleRate;       // the anchor, plus this read's delay
        if (!anchored) {
            anchorUs = candidate;
            anchored = true;
            highReads = 0;
        } else if (candidate <= anchorUs + CREEP_US_PER_READ) {
            anchorUs = candidate;                                            // a new low (or the envelope's own creep)
            highReads = 0;
        } else if (candidate - anchorUs > JUMP_US) {
            if (++highReads >= JUMP_READS) {                                 // frames were lost: this IS the new timeline
                anchorUs = candidate;
                highReads = 0;
            }
        } else {
            anchorUs += CREEP_US_PER_READ;                                   // jitter: the envelope rises only slowly
            highReads = 0;
        }
        long pts = anchorUs + frames * 1_000_000L / sampleRate;
        frames = endFrames;
        return pts;
    }
}
