// Sunum (paint) hızlandırıcı — decoder'ı ASLA atlamadan "hızlı sarma" artefaktını önler.
//
// H.264/H.265'te bir delta kareyi çözmeden geçmek sonraki tüm kareleri bozar
// (referans zinciri). Bu yüzden ağ tıkanıp birikmiş kareler bir anda gelse bile HEPSİ
// çözülür; ama bekleyen (henüz çözülmemiş) daha yeni kareler varken eski bir karenin
// ekrana BASILMASI anlamsızdır — kullanıcı bunu hızlandırılmış oynatma olarak görür.
// Çözücü çıktısındaki eski kare atlanır (VideoFrame.close()), yalnızca en yeni kare çizilir.
//
// `minBacklog`: kuyrukta en az bu kadar kare bekliyorsa gerçek bir birikme vardır. Sağlıklı
// akışta çözücü kuyruğu 0–1 arasında gezinir; o durumda HİÇBİR kare atlanmaz (aksi halde
// normal akışta bile FPS düşerdi).
// `maxStaleMs`: sürekli yoğun akışta (çözücü hiç boşalmıyorsa) ekranın donmaması için en
// geç bu aralıkta bir kare yine de çizilir.

export class FramePacer {
  constructor({ maxStaleMs = 66, minBacklog = 2 } = {}) {
    this.maxStaleMs = maxStaleMs;
    this.minBacklog = minBacklog;
    this._lastPaintMs = -Infinity;
  }

  /**
   * @param {number} pendingDecodeCount çözücünün kuyruğundaki (henüz çıktısı alınmamış) kare sayısı
   * @param {number} nowMs
   * @returns {boolean} true ⇒ bu kareyi çiz; false ⇒ atla (kapat)
   */
  shouldPaint(pendingDecodeCount, nowMs) {
    if (pendingDecodeCount < this.minBacklog || nowMs - this._lastPaintMs >= this.maxStaleMs) {
      this._lastPaintMs = nowMs;
      return true;
    }
    return false;
  }

  reset() {
    this._lastPaintMs = -Infinity;
  }
}
