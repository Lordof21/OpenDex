# Hotspot'ta 802.11ax (Wi-Fi 6) açıkken dosya aktarımı neden yavaşlıyor?

Tarih: 2026-10-12 · Cihazlar: POCO X7 Pro (HyperOS 3 / Android 16, MediaTek, Wi-Fi A-die `0x6637`) hotspot'u → laptop
(MediaTek **MT7921** Wi-Fi 6, Windows sürücü `3.0.1.1331`, 17.10.2024) · **Kod/ayar değiştirilmedi** (ax anahtarını yalnızca siz çevirdiniz).

## 1. Sonuç

Gözleminiz doğru ve ölçümle doğrulandı: **ax açıkken telefondan PC'ye yön 4 kat yavaşlıyor.** Bunun sebebi "ax yavaştır" değil;
iki ayrı bulgu var:

1. **ax, bağlantıda hiç kullanılmıyor.** Hotspot'un içeride "11ax" çalıştığı doğrulandı (`SoftApInfo wifiStandard=6`, 5 GHz ch149, 80 MHz),
   ama laptop bağlantıyı iki durumda da **802.11ac, 866,7 Mbps** olarak kurmuş. Yani ax'ın getirmesi beklenen şeylerin hiçbiri
   (HE hızları, OFDMA…) devrede değil; yalnızca telefonun **AP tarafı "ax modu"na** geçiyor.
2. **O AP modunda telefonun gönderme (aşağı yön) hızı çöküyor**; PC→telefon yönü etkilenmiyor.

## 2. Ölçüm (aynı yer, aynı kanal, ham TCP — adb yok)

Yöntem: telefonda `nc` ile veri sunucusu, PC'den 120 MB × 3 tekrar (medyan). Trafik adb'siz, doğrudan hotspot bağlantısı üzerinden.

| | **ax AÇIK** | **ax KAPALI** |
|---|---|---|
| Telefon → PC (dosya **çekme**) | **19,2 MB/s** (18,2 – 19,5) | **76,5 MB/s** (75,4 – 77,7) |
| PC → telefon (dosya **gönderme**) | 74,9 MB/s | 72,0 MB/s |
| Laptop bağlantısı | 802.11ac, 5 GHz, ch149, 866,7 Mbps, sinyal %87 | 802.11ac, 5 GHz, ch149, 866,7 Mbps, sinyal %85 |
| Ping (60 örnek) | ort 1,7 ms · sapma 0,8 · maks 4 ms | ort 3,7 ms · sapma 3,3 · maks 15 ms |

Not: iki ölçümde de OpenDeX'in video akışı aynı bağlantıdaydı; 4 katlık fark bundan büyük. Kayıpsız (0 % paket kaybı).

### Sizin 12 / 35 MB/s rakamlarınız neden bunlardan düşük?
Dosya aktarımı adb ile yapılıyor; adb'nin kendi tavanı var. ax **kapalı** durumda aynı bağlantıda ölçtüm:

| Yol | MB/s |
|---|---|
| Ham TCP (bağlantının gerçek hızı) | ~76 |
| `adb pull` (telefon → PC), Wi-Fi | 54 – 57 |
| `adb push` (PC → telefon), Wi-Fi | 41 – 45 |
| `adb pull`, **USB** (kablo) | 38 |

Sizin 35 MB/s'niz bu bandın içinde (uygulama katmanı + dosya sistemi ek yükü). ax açıkken ham çekme hızı 19 MB/s'ye
düştüğü için adb ile ~12 MB/s'ye iniyor — iki rakam birbiriyle tutarlı.

## 3. "Yeni olan ax daha hızlı olmalı değil mi?"

* **Tek istemcide kazanç zaten küçük.** 2×2, 80 MHz'de teorik fark ac 780 → ax ~864 Mbps ≈ %11; asıl kazanç (OFDMA, çok istemci,
  verimlilik) birçok cihaz bağlıyken ve **iki uç da HE konuşurken** ortaya çıkıyor.
* **Bizde HE konuşulmuyor** (bulgu 1). Laptop sürücüsünde "802.11ax/ac/n = 802.11ax" seçili olmasına rağmen link ac.
* **Uygulama katmanı ham hızın yarısına yakın** (adb): ax açılsa bile 76 MB/s'nin üstüne çıkamazdınız, adb'de 54–57'de takılırdınız.

## 4. Neden yavaşlıyor? (doğrulanmamış, olasılık sırasıyla)

1. **Telefonun AP yazılımı/ürün yazılımı (MediaTek)**: "ax modu" açıkken HE yayını yapan bir BSS'e ac (VHT) pazarlığıyla bağlanan
   istemciye aşağı yönde düşük hız. Aynı yapılandırmada yukarı yön normal → sorun telefonun **gönderme** yolunda (TX agregasyonu/hız
   adaptasyonu). Kanıt: yön-asimetrisi + AP'nin ac modunda 76 MB/s vermesi.
2. **HE pazarlığı başarısız / sürücü geri düşüşü**: laptop MT7921 sürücüsü HE-etkin AP'ye ac olarak bağlanıyor. Bu, AP'nin yayınladığı
   HE bilgisi ile sürücünün beklentisi arasında uyumsuzluk olabilir; web aramasında MT7921'in rastgele düşük hız/geri düşüş
   şikâyetleri var (çoğu Linux; Windows tarafında "802.11ax/ac/n" ayarının kendi kendine değiştiği bildirimleri). Bu belirli
   eşleşme (telefon hotspot + MT7921) için kaynak bulamadım.
3. **Ayar tutarsızlığı**: kayıtlı hotspot yapılandırmasında **`Ieee80211beEnabled = true`** (Wi-Fi 7) bulundu; çalışan AP'de
   `be = false`. Tek anahtarın hem ax hem be'yi açıyor olması mümkün (HyperOS'a özgü; doğrulanmadı) ve be bayrağı ek
   davranış değişikliği getirebilir.
4. Elenenler: kanal/bant farkı (iki durumda da 5 GHz ch149, 866,7 Mbps), sinyal (%85–87), paket kaybı (0), PC güç
   yönetimi (tek istemci, U-APSD kapalı, "Power Saving: Auto").

## 5. Öneri (kod yok, ayarlar ve sonraki adımlar)

**Hemen:**
* Hotspot'ta **ax kapalı** kalsın (dosya çekme 4× hızlı).
* **Gecikme** açısından tek ölçümde ax açık daha düşük/kararlı görünüyor (ort 1,7 vs 3,7 ms; maks 4 vs 15 ms). Video akışı
  telefondan PC'ye yalnız ~1,5 MB/s (12 Mbps) ister → ax açıkken bile 19 MB/s fazlasıyla yeter. Yani ödünleşim:
  *akış gecikmesi/jitter* (ax açık) ↔ *dosya aktarımı* (ax kapalı). Tek 60'lık örnek; kesin değil.

**Kök nedeni ayırmak için (10 dakika):**
1. ax **açıkken** `netsh wlan show networks mode=bssid` çalıştırın: telefonun BSSID'sinde "Radio type: 802.11ax" görünüyorsa AP HE
   yayınlıyor ve **istemci geri düşüyor** (neden 2); görünmüyorsa AP "ax" deyip HE yayınlamıyor (neden 1).
2. Laptop'ta MT7921 sürücüsünü güncelleyin (mevcut 3.0.1.1331, 2024) ve aynı testi tekrarlayın.
3. Başka bir istemciyle (başka laptop/telefon) ax açık/kapalı karşılaştırın — sorun telefonda mı, bu laptopta mı belli olur.
4. HyperOS hotspot ayarında Wi-Fi 6 anahtarı Wi-Fi 7'yi de değiştiriyorsa (kayıtlı `be=true`) ayrı bir "uyumluluk/Wi-Fi 7" seçeneği var mı bakın.

**Ürün tarafı (OpenDeX için fırsat):**
* **Dosya aktarımı adb tavanında** (41–57 MB/s; ham hız 76). Daemon'un `fs_*` kanalına ek, doğrudan TCP veri kanalıyla ~70 MB/s'ye
  yaklaşılabilir (adb'siz, tek akış). Önce küçük bir deney: aynı dosyayı daemon üzerinden akıtıp ölçmek.
* **Bağlantı tanılama kartı**: hotspot standardı/kanalı/genişliği (daemon `SoftApInfo`'yu okuyabilir), laptop link hızı ve
  1 sn'lik ham hız testi; "Hotspot'ta ax açık: telefondan çekme hızı düşebilir" uyarısı. Bu sorunu kullanıcı kendi başına bulamaz.
* USB (2.0) 38 MB/s'de kalıyor: iyi bir ax-kapalı Wi-Fi USB'den daha hızlı; belgelerde "Wi-Fi bazen daha hızlı" notu faydalı.

## 6. Sınırlar
Tek telefon, tek laptop, tek ölçüm turu (her durumda 3 tekrar); ax-açık ve ax-kapalı ölçümler arasında ~4 dk fark var; iki durumda
da OpenDeX akışı aynı bağlantıdaydı. Ping tek 60'lık örnek. AP'nin HE yayınlayıp yayınlamadığı (neden 1 / 2 ayrımı) ölçülmedi.
Hotspot'un sürücü/firmware düzeyi kaynak koduna erişilemediği için neden kesinleşmedi; yön asimetrisi ölçümle kanıtlı.

## Kaynaklar
* Android — SoftApConfiguration (ax/be anahtarları): https://developer.android.com/reference/android/net/wifi/SoftApConfiguration.Builder
* Wi-Fi 5 vs 6, tek istemci kazancı (≈%11 teorik): https://www.helpmij.nl/forum/threads/advies-nieuwe-router.953242/post-6230883
* Wi-Fi 6 gerçek avantajları (çok istemci/OFDMA): https://www.intel.com/content/dam/www/central-libraries/us/en/documents/intel-it-wi-fi-6-real-advantages-paper.pdf
* MT7921 yavaşlık/ayar şikâyetleri: https://community.acer.com/pt/discussion/686124/troubleshooting-para-adaptador-de-rede-sem-fio-mt7921-mediatek
