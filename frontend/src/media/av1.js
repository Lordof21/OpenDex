// AV1 akışı için yardımcılar.
//
// H.264/HEVC scrcpy akışı Annex B'dir (00 00 01 başlangıç kodları); AV1 ise OBU akışıdır — başlangıç kodu YOKTUR. Çözücü
// eskiden tanımadığı her şeyi H.264 sanıyordu: AV1 verisi H.264 olarak çözülmeye çalışılıp "Decoding error" veriyordu.

/** Main profil, 8 bit, seviye 5.1 (3200x1800'e kadar). Gerçek parametreler akış içindeki dizi başlığındadır. */
export const AV1_CODEC = 'av01.0.13M.08';

/** Veri Annex B (00 00 01 / 00 00 00 01 ile başlıyor) mı? */
export function isAnnexB(data) {
  const u8 = data instanceof Uint8Array ? data : new Uint8Array(data);
  return u8.length >= 4 && u8[0] === 0 && u8[1] === 0 && (u8[2] === 1 || (u8[2] === 0 && u8[3] === 1));
}
