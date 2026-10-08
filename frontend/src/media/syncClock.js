
export const SYNC_WINDOW_MS = 40;

/**
 * @param {number} videoFramePtsUs frame PTS in microseconds (device clock)
 * @param {{ getCurrentAudioPosition(): number|null }} audioPlayer
 * @returns {'hold'|'drop'|'show'}
 */
export function compareToAudioClock(videoFramePtsUs, audioPlayer) {
  const audioPtsUs = audioPlayer?.getCurrentAudioPosition?.();
  if (audioPtsUs === null || audioPtsUs === undefined) return 'show'; // no audio clock (yet) → free-run video
  const diffMs = (videoFramePtsUs - audioPtsUs) / 1000;

  // If drift is large (> 100ms), the window has an independent PTS origin — free-run to prevent black/frozen frames
  if (Math.abs(diffMs) > 100) {
    return 'show';
  }

  if (diffMs > SYNC_WINDOW_MS) return 'hold'; // video ahead of audio
  if (diffMs < -SYNC_WINDOW_MS) return 'drop'; // video behind audio
  return 'show';
}
