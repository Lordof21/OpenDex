import { describe, it, expect } from 'vitest';
import { findHevcSps, parseHevcSpsSize, hevcSizeFromAnnexB } from '../src/media/hevcSps.js';

// Bit yazıcı: gerçek bir SPS'i (H.265 §7.3.2.2) kurar; ayrıştırıcı bunu geri okumalı.
class BitWriter {
  constructor() {
    this.bits = [];
  }

  u(n, v) {
    for (let i = n - 1; i >= 0; i--) this.bits.push(Math.floor(v / 2 ** i) % 2);
  }

  ue(v) {
    const x = v + 1;
    const len = Math.floor(Math.log2(x));
    this.u(len, 0);
    this.u(len + 1, x);
  }

  bytes() {
    const b = [...this.bits, 1]; // rbsp_stop_one_bit
    while (b.length % 8) b.push(0);
    const out = [];
    for (let i = 0; i < b.length; i += 8) out.push(parseInt(b.slice(i, i + 8).join(''), 2));
    return out;
  }
}

/** Emülasyon önleme: 00 00 {00,01,02,03} → araya 03. */
function escapeRbsp(bytes) {
  const out = [];
  let zeros = 0;
  for (const b of bytes) {
    if (zeros >= 2 && b <= 3) {
      out.push(3);
      zeros = 0;
    }
    out.push(b);
    zeros = b === 0 ? zeros + 1 : 0;
  }
  return out;
}

function buildSps({ width, height, crop = null, chroma = 1, subLayers = 0 }) {
  const w = new BitWriter();
  w.u(4, 0); // vps id
  w.u(3, subLayers); // max_sub_layers_minus1
  w.u(1, 1); // temporal_id_nesting
  // profile_tier_level: general (88 bit) + level (8 bit)
  w.u(2, 0); w.u(1, 0); w.u(5, 1); // profile space, tier, profile idc (Main)
  w.u(32, 0x60000000); // compat flags
  w.u(4, 0b1001); w.u(43, 0); w.u(1, 0);
  w.u(8, 120); // level 4.0
  const profilePresent = [];
  for (let i = 0; i < subLayers; i++) {
    profilePresent.push(1);
    w.u(1, 1); // sub_layer_profile_present
    w.u(1, 1); // sub_layer_level_present
  }
  if (subLayers > 0) w.u(2 * (8 - subLayers), 0);
  for (let i = 0; i < subLayers; i++) {
    w.u(88, 0);
    w.u(8, 90);
  }
  w.ue(0); // sps id
  w.ue(chroma);
  if (chroma === 3) w.u(1, 0);
  w.ue(width);
  w.ue(height);
  if (crop) {
    w.u(1, 1);
    w.ue(crop.left); w.ue(crop.right); w.ue(crop.top); w.ue(crop.bottom);
  } else {
    w.u(1, 0);
  }
  w.ue(0); w.ue(0); // bit depths (devamı ayrıştırılmaz)
  return [0x42, 0x01, ...escapeRbsp(w.bytes())]; // NAL type 33
}

const START = [0, 0, 0, 1];

describe('HEVC SPS boyutu', () => {
  it('basit boyutu okur', () => {
    expect(parseHevcSpsSize(Uint8Array.from(buildSps({ width: 1032, height: 528 })))).toEqual({ width: 1032, height: 528 });
  });

  it('kırpma penceresini uygular (1080p = 1088 − 8)', () => {
    const sps = buildSps({ width: 1920, height: 1088, crop: { left: 0, right: 0, top: 0, bottom: 4 } });
    expect(parseHevcSpsSize(Uint8Array.from(sps))).toEqual({ width: 1920, height: 1080 });
  });

  it('alt katmanlı profile_tier_level atlanır', () => {
    expect(parseHevcSpsSize(Uint8Array.from(buildSps({ width: 904, height: 1000, subLayers: 2 })))).toEqual({ width: 904, height: 1000 });
  });

  it('4:4:4 renk biçiminde kırpma birimi 1', () => {
    const sps = buildSps({ width: 1000, height: 600, chroma: 3, crop: { left: 0, right: 8, top: 0, bottom: 0 } });
    expect(parseHevcSpsSize(Uint8Array.from(sps))).toEqual({ width: 992, height: 600 });
  });

  it('Annex B içinden (VPS + SPS + PPS arasında) SPS bulur', () => {
    const vps = [0x40, 0x01, 0x0c, 0x01];
    const pps = [0x44, 0x01, 0xc1, 0x72];
    const data = Uint8Array.from([...START, ...vps, ...START, ...buildSps({ width: 1552, height: 776 }), ...START, ...pps]);
    expect(findHevcSps(data)).not.toBeNull();
    expect(hevcSizeFromAnnexB(data)).toEqual({ width: 1552, height: 776 });
  });

  it('SPS yoksa / bozuksa null', () => {
    expect(hevcSizeFromAnnexB(Uint8Array.from([...START, 0x26, 0x01, 0xaf, 0x08]))).toBeNull();
    expect(parseHevcSpsSize(Uint8Array.from([0x42, 0x01, 0x01]))).toBeNull();
  });
});
