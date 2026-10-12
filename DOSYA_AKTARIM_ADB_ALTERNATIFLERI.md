# Dosya aktarımı: adb'den daha hızlı yol var mı? Daemon üzerinden mi, başka bir yoldan mı?

Tarih: 2026-10-12 · Cihaz: POCO X7 Pro (Android 16) ↔ laptop, hotspot **ax kapalı**, 5 GHz ch149, 866,7 Mbps (80 MHz, 2×2) ·
**Kod değiştirilmedi.** Okunan kod: `backend/app/fs/{adb_sync,transfer,ranged,providers/phone}.py`, `backend/java/.../{FsService,FsPolicy,
AudioStreamServer,OpenDexDaemon}.java`, `docs/DAEMON_PROTOCOL.md`.

## 1. Kısa cevap

* **Bağlantının gerçek tavanı ≈ 77 MB/s** (ham TCP, 1–4 akış fark etmiyor). Hiçbir yöntem bunun üstüne çıkamaz.
* **adb'nin tek akışı bu tavanın altında kalıyor** (çekme 56, gönderme 44 MB/s) — ama **adb'nin kendisi yavaş değil, tek akışı yavaş**:
  3 dosyayı paralel yapınca adb aynı bağlantıdan **76 (çekme) / 82 (gönderme) MB/s** veriyor.
* Daemon'a koymak **tek başına hız getirmez**: daemon soketi `adb forward` ile aynı adbd tünelinden geçiyor (ölçtüm: 56 MB/s = adb pull).
  Hız ancak telefonda **gerçek bir TCP dinleyici** (adbd'yi tamamen dışarıda bırakan) ile gelir: 74–78 MB/s.
* Pratikte en ucuz kazanç **büyük tek dosyayı aralıklara bölüp 3–4 paralel akışla** taşımak (mevcut kodun parçalarıyla yapılabilir).

## 2. Ölçümler (aynı ortam, 3'er tekrar, ax kapalı)

| Yol | Telefon → PC (çekme) | PC → telefon (gönderme) |
|---|---|---|
| **Ham TCP, adb'siz** (telefonda `nc` dinleyici), 1 akış | **74** | ~72–75 |
| Ham TCP, 2 / 4 paralel akış | 78 / 76 | — |
| `adb pull/push`, **1 dosya** | **56** | **44** |
| `adb`, **3 dosya paralel** (toplam) | **76** | **82** |
| `adb forward` tüneli (Wi-Fi), 1 akış | 56 | — |
| `adb forward` tüneli (**USB**) | 38 | — |
| `adb pull`, USB | 38 | — |

Yorum:
* Paralel adb = ham TCP tavanı → adb'nin **toplam** kapasitesi sorun değil; **akış başına** sınır var (muhtemelen akış-başı akış
  denetimi; çıkarım, kaynak koduna bakılmadı).
* `adb forward` (daemon soketlerinin kullandığı yol) tek akışta adb sync ile **aynı** (56) → daemon soketi hız getirmez.
* USB 38 MB/s ≈ **USB 2.0** (480 Mbps ≈ 40 MB/s) tavanı; kablo/port ya da telefon USB 2.0 ile sınırlı olabilir. (Telefonun USB 3
  desteklediğini doğrulamadım.)
* Kayıtlı USB yapılandırması `ptp,adb`; bellek notlarında PTP/MTP'nin periyodik donma yaptığı kayıtlı.

## 3. Bugünkü kod ne yapıyor?

* Bayt akışı **adb SYNC** üzerinden, Python'daki kendi istemcimizle (`adb_sync.py`): adb sunucusu (127.0.0.1:5037) → adbd.
  `docs`/kod yorumu: *"Bytes of a transfer do NOT travel [on the daemon] — the backend streams them over adb's sync protocol"*;
  gerekçe: daemon soketi satır-JSON ve telemetri/medya olayını da taşıyor, 2 GB'lık video orada herkesi tıkar.
* Bir iş içinde **3 dosya paralel** (`FS_TRANSFER_WORKERS=3`), oturumlar havuzda (`SyncPool`, 4 boşta). Yani **çok dosyalı iş zaten
  paralel**; yavaşlığı **tek büyük dosya** yaşar (tek akış: 44–56 MB/s; sizin 35 MB/s'niz buna ek dosya sistemi/Python ek yükü).
* SYNC çerçeveleri ≤ 64 KiB (`SYNC_DATA_MAX`); çekmede `RECV` bayt 0'dan başlar, devam için **`exec:` + `tail -c +N`** aralık okuması
  zaten var (`PhoneRangeReader`/`read_range`, video önizleme ve kesilen çekmeyi sürdürmek için). Gönderme yazıcısı eklemeyi
  (append) desteklemiyor (`resumable_write=False`).

## 4. Seçenekler

### A. Büyük dosyayı aralıklara bölüp paralel akıt (adb'de kal) — **önerilen ilk adım**
* **Çekme:** 3–4 `exec:` akışı, her biri bir bayt aralığı (`tail -c +N | head -c L`), PC'de ofsete yazılır. Gerekli parçalar kodda var.
* **Gönderme:** SYNC `SEND` ofset yazamaz; üç yol: (1) parçaları ayrı geçici dosyalar olarak paralel SEND edip telefonda
  birleştirmek (`cat`; 2× flash yazımı + 2× yer), (2) `exec:` stdin'ine `dd of=… seek=… conv=notrunc` ile aralık yazmak,
  (3) dosyayı hiç bölmeden birden çok dosya gibi paralelleştirmek (yalnız çok dosyada işe yarar, zaten var).
* Beklenen kazanç (ölçüldü, paralel eşdeğeri): çekme 56 → ~76 (**+35 %**), gönderme 44 → ~82 (**+85 %**).
* Artı: yeni güvenlik yüzeyi yok, daemon değişmez; mevcut devam etme (resume) mantığıyla uyumlu (çekmede).
* Eksi: gönderme için parça birleştirme/`dd` karmaşıklığı; çok küçük dosyalarda gereksiz; adbd'nin açık akış sayısı sınırlı
  (`_streams` semaforu zaten var).

### B. Daemon'da **gerçek TCP veri kanalı** (adb'yi tamamen dışarıda bırak)
* Yapı: kontrol düzlemi aynı kalır (kimlik doğrulamalı daemon soketi: `fs_open_read <yol> <ofset> <uzunluk>` → tek-kullanımlık jeton + port).
  Veri düzlemi: telefonda **Wi-Fi arayüzünün IP'sine** (hotspot'ta `ap0`, normal ağda `wlan0`) bağlı bir `ServerSocket`; PC doğrudan
  `telefon_ip:port`'a bağlanır. `AudioStreamServer` kalıbı (kuyruk, tek tüketici, keepalive, eşler UID kontrolü) örnek alınabilir; ses
  kanalı bugün soyut soket + `adb forward` kullandığı için **aynı kalıpla yazılsa bile hız getirmez** — bağlama noktası değişmeli.
* Ölçüm: 74–78 MB/s tek akış, adb'ye bağımlı değil (adbd yeniden başlasa, akış sınırı dolsa bile çalışır). **Kabul edilebilirlik:** shell
  kimliğiyle TCP dinlemek bu telefonda çalıştı (`nc` testi; SELinux engellemedi).
* Güvenlik gereksinimleri: (1) yalnız ilgili arayüze bağlan, (2) bağlantıdaki ilk satır = daemon anahtarıyla HMAC (mevcut
  `DaemonAuth` yeniden kullanılır) + tek-kullanımlık jeton, (3) yol politikası `FsPolicy` ile **cihazda** doğrulanır (zaten var; veri
  kanalı onu atlamamalı), (4) ağdaki başkası okuyamasın: WPA2 hotspot'ta bağlantı katmanı şifreli; paylaşılan/açık ağda uygulama
  katmanı şifrelemesi (AES-GCM, donanım hızlandırmalı) veya yalnız güvenilir ağda aç.
* Sınır: **USB'de uygulanamaz** (IP yok; yine adb tüneli, 38 MB/s). Yani B yalnız Wi-Fi içindir.
* Kazanç: A ile aynı tavan (≈77–82); farkı **sadelik/dayanıklılık** (tek akış yetiyor, adbd'den bağımsız). Eksi: yeni bileşen, test,
  güvenlik tasarımı — A'dan pahalı.

### C. Hotspot ayarı (önceki rapor)
* ax açıkken telefon→PC yönü 19 MB/s'ye düşüyor; **ax kapalı** bırakın. A/B yöntemlerinin hiçbiri bunu düzeltmez.

### D. Fiziksel yol
* USB **3.x** kablo/port ve USB 3 destekleyen telefon modeli: adb 100+ MB/s mümkün olabilir (model/kablo belirsiz; doğrulanmadı).
  Telefonda USB kipi `ptp,adb` → "Veri aktarımı yok" kipine geçmek bellek notlarına göre donma riskini de kaldırıyor.

### E. Düşük öncelik / önerilmeyen
* **adb sıkıştırma (`-z`, sync v2 brotli/lz4/zstd):** yalnız sıkıştırılabilir dosyada (metin, APK, belge) kazandırır; foto/video/zip'te
  telefon CPU'su boşa gider. İstemcimiz sync v2 sıkıştırmasını kullanmıyor; geri-düşüş olarak bile faydası sınırlı.
* **SMB/FTP/HTTP/WebDAV sunucusu uygulaması:** ham TCP tavanını aşmaz, telefona uygulama kurmayı gerektirir; projenin "kurulumsuz"
  ilkesine ters.
* **Daha geniş kanal/6 GHz:** hotspot 80 MHz'de; telefonun hotspot'u 160 MHz/6 GHz sunuyorsa tavan artabilir — bu telefonda
  denenmedi.

## 5. Öneri sırası
1. **Hemen:** hotspot'ta ax kapalı.
2. **A (büyük dosya paralel aralık akışı)** — en düşük risk, ölçülmüş +35…85 %.
3. Gerekirse **B** (Wi-Fi'de adb'siz doğrudan TCP) — mimari bağımsızlık ve dayanıklılık için; hız A'yı aşmaz.
4. Kullanıcıya **bağlantı tanılama** (SoftAP standardı, link hızı, 1 sn'lik ham hız) ve "USB 2.0'a takılı" uyarısı.

## 6. Sınırlar
Tek telefon/laptop; her satır 2–3 tekrar; ölçüm sırasında OpenDeX video akışı da bağlantıdaydı; adb'nin akış-başı sınırının nedeni
(akış denetimi) çıkarım; B'nin güvenlik/izin yönleri `nc` ile yalnız dinleme açısından doğrulandı (kimlik doğrulama/şifreleme
yazılmadı); USB 3 kazancı ölçülmedi.
