// HEVC (H.265) SPS'ten kodlanmış görüntü boyutunu okur (Annex B baytlarından).
//
// Neden: WebView2'nin HEVC çözücüsü, VideoDecoderConfig'te codedWidth/codedHeight verilmeyince ve akış içinde SPS
// değişince (scrcpy flex resize: yeni boyut yalnız keyframe içindeki SPS'te gelir, ayrı yapılandırma paketi YOKTUR)
// eski/varsayılan boyutta (1280x720) kare üretmeye devam ediyordu — Chrome'da görülmeyen bir fark. Boyutu SPS'ten
// okuyup çözücüyü o boyutla yapılandırmak spesifikasyona uygun yoldur (tangoadb: "decoder parses the new config").

const NAL_SPS = 33;

/** Annex B akışındaki ilk HEVC SPS NAL'ının (başlık dahil) baytlarını döner; yoksa null. */
export function findHevcSps(data) {
  const u8 = data instanceof Uint8Array ? data : new Uint8Array(data);
  const n = u8.length;
  for (let i = 0; i + 4 < n; i++) {
    if (u8[i] !== 0 || u8[i + 1] !== 0) continue;
    let start = -1;
    if (u8[i + 2] === 1) start = i + 3;
    else if (u8[i + 2] === 0 && u8[i + 3] === 1) start = i + 4;
    if (start < 0 || start + 2 >= n) continue;
    if (((u8[start] >> 1) & 0x3f) !== NAL_SPS) continue;
    let end = n;
    for (let j = start + 2; j + 2 < n; j++) {
      if (u8[j] === 0 && u8[j + 1] === 0 && (u8[j + 2] === 1 || (u8[j + 2] === 0 && j + 3 < n && u8[j + 3] === 1))) {
        end = j;
        break;
      }
    }
    return u8.subarray(start, end);
  }
  return null;
}

/** NAL yükünden emülasyon önleme baytlarını (00 00 03 → 00 00) çıkarır. */
function unescape(nal) {
  const out = new Uint8Array(nal.length);
  let o = 0;
  let zeros = 0;
  for (let i = 0; i < nal.length; i++) {
    const b = nal[i];
    if (zeros >= 2 && b === 3) {
      zeros = 0;
      continue;
    }
    out[o++] = b;
    zeros = b === 0 ? zeros + 1 : 0;
  }
  return out.subarray(0, o);
}

class BitReader {
  constructor(bytes) {
    this.b = bytes;
    this.pos = 0;
  }

  bit() {
    const byte = this.b[this.pos >> 3];
    if (byte === undefined) throw new RangeError('SPS bitleri bitti');
    const v = (byte >> (7 - (this.pos & 7))) & 1;
    this.pos += 1;
    return v;
  }

  bits(n) {
    let v = 0;
    for (let i = 0; i < n; i++) v = v * 2 + this.bit();
    return v;
  }

  skip(n) {
    this.pos += n;
  }

  ue() {
    let zeros = 0;
    while (this.bit() === 0) {
      zeros += 1;
      if (zeros > 31) throw new RangeError('geçersiz ue(v)');
    }
    return (2 ** zeros) - 1 + this.bits(zeros);
  }
}

/** profile_tier_level(1, maxSubLayersMinus1) — yalnız atlanır. */
function skipProfileTierLevel(r, maxSubLayersMinus1) {
  r.skip(88); // general: 2+1+5 + 32 + 4 + 43 + 1 = 88 bit
  r.skip(8); // general_level_idc
  const profilePresent = [];
  const levelPresent = [];
  for (let i = 0; i < maxSubLayersMinus1; i++) {
    profilePresent.push(r.bit());
    levelPresent.push(r.bit());
  }
  if (maxSubLayersMinus1 > 0) r.skip(2 * (8 - maxSubLayersMinus1)); // reserved_zero_2bits
  for (let i = 0; i < maxSubLayersMinus1; i++) {
    if (profilePresent[i]) r.skip(88);
    if (levelPresent[i]) r.skip(8);
  }
}

/**
 * Bir HEVC SPS NAL'ından (2 baytlık NAL başlığı dahil) görüntü boyutu: { width, height } (kırpma penceresi uygulanmış),
 * ayrıştırılamazsa null.
 */
export function parseHevcSpsSize(nal) {
  try {
    const rbsp = unescape(nal);
    const r = new BitReader(rbsp);
    r.skip(16); // NAL başlığı
    r.skip(4); // sps_video_parameter_set_id
    const maxSubLayersMinus1 = r.bits(3);
    r.skip(1); // sps_temporal_id_nesting_flag
    skipProfileTierLevel(r, maxSubLayersMinus1);
    r.ue(); // sps_seq_parameter_set_id
    const chroma = r.ue();
    if (chroma === 3) r.skip(1); // separate_colour_plane_flag
    const picW = r.ue();
    const picH = r.ue();
    let width = picW;
    let height = picH;
    if (r.bit()) {
      const subW = chroma === 1 || chroma === 2 ? 2 : 1;
      const subH = chroma === 1 ? 2 : 1;
      const left = r.ue();
      const right = r.ue();
      const top = r.ue();
      const bottom = r.ue();
      width = picW - subW * (left + right);
      height = picH - subH * (top + bottom);
    }
    if (!(width > 0) || !(height > 0) || width > 16384 || height > 16384) return null;
    return { width, height };
  } catch {
    return null;
  }
}

/** Annex B verisindeki (varsa) ilk SPS'in boyutu. */
export function hevcSizeFromAnnexB(data) {
  const sps = findHevcSps(data);
  return sps ? parseHevcSpsSize(sps) : null;
}
