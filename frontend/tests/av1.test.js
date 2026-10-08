import { describe, it, expect } from 'vitest';
import { isAnnexB, AV1_CODEC } from '../src/media/av1.js';

describe('AV1 akış yardımcıları', () => {
  it('Annex B ile OBU akışını ayırır', () => {
    expect(isAnnexB(Uint8Array.from([0, 0, 0, 1, 0x40]))).toBe(true);
    expect(isAnnexB(Uint8Array.from([0, 0, 1, 0x67]))).toBe(true);
    expect(isAnnexB(Uint8Array.from([0x12, 0x00, 0x0a, 0x0b]))).toBe(false); // temporal delimiter + sequence header
    expect(isAnnexB(Uint8Array.from([0x81, 0x0c, 0x00, 0x00]))).toBe(false); // av1C
    expect(isAnnexB(Uint8Array.from([0, 0]))).toBe(false);
  });

  it('codec dizesi av01 ile başlar', () => {
    expect(AV1_CODEC.startsWith('av01.')).toBe(true);
  });
});
