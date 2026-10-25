> **Language note:** Turkish (translation is on the [roadmap](../ROADMAP.md)). Measurements of how video, audio, touch and file transfer interfere on the shared adb transport.

> Durum: ölçüm raporu (2026-10-12); kod değişmedi. İlke: adb burst modunu paylaşılan taşımada açma.

# Veri yolu: video, ses, dokunma ve dosya aktarımı birbirini etkiliyor mu? Daha iyi yollar var mı?

Tarih: 2026-10-12 · Ortam: POCO X7 Pro hotspot'u (ax **kapalı**, 5 GHz ch149, 866 Mbps) ↔ laptop (MT7921) · **Kod değiştirilmedi**
(telefona yalnızca geçici test dosyaları/`nc` süreçleri konup silindi) · Okunan kod: `scrcpy_launcher.py`, `adb.py`, `fs/{adb_sync,transfer}.py`,
`AudioStreamServer.java`, `OpenDexDaemon.java`, `docs/DAEMON_PROTOCOL.md`.

## 1. Kısa cevap

**Evet, birbirlerini etkiliyorlar ve bunu ölçtüm.** İki ayrı mekanizma var:

1. **adb taşımasında sıra kuyruğu (head-of-line)**: video, dokunma, ses, daemon kontrolü ve dosya aktarımı **aynı adb taşıma bağlantısını**
   paylaşıyor. Bugün bir dosya çekerken taşıma gecikmesi 7 → 19 ms (p95 34 ms) çıkıyor. Dosya aktarımını adb'de *hızlandırınca*
   (delayed-ACK/burst) bu gecikme **390–850 ms**'ye fırlıyor.
2. **Wi-Fi bağlantısındaki kuyruk (bufferbloat)**: bağlantıyı dolduran herhangi bir aktarım — ayrı bir TCP bağlantısı bile olsa —
   diğer herkesin gecikmesini artırıyor (telefon→PC 75 MB/s'de **3 → 38 ms**). Bu, video ile **aynı yön**.

**Ders:** dosya aktarımını hızlandırmak tek başına latency'yi bozar. Hız ancak **(a) gerçek zamanlı akışlardan ayrı bir taşıma** ve
**(b) hız sınırı/pacing** ile birlikte güvenle alınabilir. Ölçüm: bağlantıyı ~60 MB/s'de sınırlamak, hız kaybı %20 iken gecikme
eklentisini 35 ms'den 4 ms'ye indiriyor.

## 2. Bugünkü veri yolu haritası (koddan)

| Akış | Nasıl taşınıyor | Ne ister |
|---|---|---|
| **Video** (pencere başına bir scrcpy sunucusu) | `adb forward tcp:PORT localabstract:scrcpy_<scid>` → PC → WebSocket `/ws/video` | **düşük gecikme**, ~12 Mbps (1,5 MB/s), kayıp/duraksama görünür |
| **Dokunma/klavye** | scrcpy kontrol soketi (aynı forward tüneli) | küçük paket, **gecikme** < ~30 ms |
| **Ses (PCM)** | daemon `AudioStreamServer` soyut soketi → `adb forward tcp:28101` | ~1,5 Mbps, **jitter** duyarlı (keepalive 4 sn) |
| **Daemon kontrolü** (medya, odak, shell, `fs_*`) | `adb forward tcp:28100` | küçük mesajlar, olay itme |
| **Dosya aktarımı** | adb SYNC oturumları (adb sunucusu → adbd) | **throughput** |

Hepsi **tek adb taşımasından** (Wi-Fi'de adbd'ye tek TCP bağlantısı, USB'de tek bulk boru) geçiyor. Projede `TCP_NODELAY`/`SO_*BUF`/DSCP ayarı
yok (grep boş); asyncio varsayılanı kalıyor. adb kendi içinde akışları çoğullar ama altındaki TCP tek.

## 3. Ölçümler (hotspot ax kapalı; yankı = 1 baytlık gidiş-dönüş, ~25/sn)

"Doğrudan" = adb'siz, ayrı TCP bağlantısı (Wi-Fi bağlantısının kendi gecikmesi); "adb taşıması" = adb üzerinden kalıcı bir akışın gidiş-dönüşü
(video/dokunma/ses akışlarının yaşadığına eşdeğer).

| Yük (aynı anda) | Yük hızı | Doğrudan yankı: medyan / p95 | adb taşıması yankı: medyan / p95 |
|---|---|---|---|
| boşta | – | 3,0 / 6,9 ms | 7,3 / 12,2 ms |
| adb **push** (eski adb 30.0.4) | 45 MB/s | 4,3 / 13,8 | 10,4 / 25,7 |
| adb **pull** (eski adb) | 34 MB/s | 3,4 / 6,4 | **19,1 / 33,9** |
| doğrudan TCP, PC→telefon (sınırsız) | 69 MB/s | **14,6 / 26,8** | 17,6 / 30,3 |
| doğrudan TCP, telefon→PC (sınırsız; **video ile aynı yön**) | 75 MB/s | **38,3 / 45,1** | **41,1 / 47,6** |
| adb push + **delayed-ACK/burst** (adb 37.0.1) | 82 MB/s | 33,8 / 47,6 | **390 / 411** |
| adb pull + burst | 38 MB/s | 3,5 / 8,9 | **846 / 993** |

Bulgular:
* **Hızlandırılmış adb, aynı taşımadaki herkesi 0,4–1 sn dondurabilir** (burst'te adb yankısı 390–850 ms). Bugünkü eski adb'nin
  "tek akışta tek paket" sınırı (aşağıda) kazara bir **koruma** — yavaşlığı, video/dokunmayı korumuş.
* **Ayrı TCP bağlantısı** (doğrudan yankı) adb HOL'ünden kurtuluyor: burst push sırasında doğrudan yankı 33,8 ms (adb: 390 ms).
  Yani **taşımayı ayırmak, HOL'ü çözer** — ama Wi-Fi kuyruğu (≈ +30 ms) kalır.
* **Hız sınırı bufferbloat'u neredeyse bitiriyor** (alıcı/gönderici pacing, ayrı TCP, aynı yön):

| Sınır | telefon→PC (video yönü) yankı medyan / p95 | PC→telefon yankı medyan / p95 |
|---|---|---|
| sınırsız (75 / 69 MB/s) | 38,3 / 45,1 ms | 14,6 / 26,8 |
| 60 / 55 MB/s | **7,3 / 19,3** | **3,6 / 8,0** |
| 45 / 40 MB/s | 6,2 / 11,4 | 3,8 / 7,7 |
| 30 / 20 MB/s | 4,6 / 18,1 | 2,7 / 6,5 |
| 15 MB/s | 4,1 / 8,3 | – |

Not: tek hotspot, tek laptop, tek koşu (n≈190/nokta). AP'nin kendisi telefon olduğu için gerçek bir yönlendirici bambaşka olabilir
(bkz. §4-3).

## 4. İnternet araştırmasından (kaynaklar sonda)

1. **adb tek akışta neden yavaş?** AOSP delayed-ACK belgesi: *"There could be only one `A_WRTE` apacket in-flight on an asocket"* — her
   akış her paketten sonra `A_OKAY` bekler → tek akış hızı ≈ paket/RTT. Çözüm "burst/delayed ACK" (akış başına "available send bytes"
   sayacı); belgede USB3'te itme **%70** hızlanıyor. Bizde Wi-Fi'de itme **45 → 82 MB/s (+%82)** (5/5 tutarlı). **Varsayılan kapalı**:
   adb sunucusu `ADB_BURST_MODE=1` ile başlatılınca `features` listesine `delayed_ack` giriyor (`ADB_DELAYED_ACK=1` tek başına yetmedi;
   ölçtüm). Kullandığınız adb **30.0.4 (2020)**; adb 37.0.1'in de varsayılanı kapalı ve **çekmede hız artışı yok** (36 MB/s).
2. **ADB Wi-Fi 2.0** (Android 17, platform-tools 37): bağlantı hızı (kurulum) %66, otomatik bağlanma %32 iyileşti; **throughput/gecikme
   iyileştirmesi yok** (yazıda geçmiyor).
3. **Wi-Fi'de gecikme neden artıyor?** "Ending the Anomaly" (USENIX ATC'17): bufferbloat + performans anomalisi; istasyon-başı **fq_codel +
   airtime fairness + AQL** yük altındaki gecikmeyi **bir büyüklük mertebesi** düşürüyor ve Linux çekirdeğinde (mac80211) var. MediaTek
   telefon sürücüsünün bunu kullanıp kullanmadığı bilinmiyor; ölçümümüz (+35 ms) kullanmadığını ima ediyor (çıkarım).
4. **WMM/DSCP:** Wi-Fi 4 erişim kategorisi (ses, video, normal, arka plan); yüksek kategori **kazanma olasılığını** artırır, garanti etmez.
   Linux'ta DSCP'nin üst 3 biti 802.1d önceliğine (`cfg80211_classify8021d`) ve oradan erişim kategorisine eşleniyor (RFC 8325 varsayılanı).
   Yani telefon tarafında gerçek zamanlı soketlere `IP_TOS`/`setTrafficClass` vermek *aşağı yönde* (telefon → PC, video yönü) işe yarayabilir.
   Windows'ta uygulama `IP_TOS`'u genelde yok sayılır; DSCP için `New-NetQosPolicy` gerekir (bu oturumda kaynakla doğrulanamadı).
5. **Arka plan aktarımı kuralları:** LEDBAT (RFC 6817, deneysel) gecikme-tabanlı "yol ver" algoritması; RFC 8622 "Lower Effort" DSCP.
   Prensip: toplu aktarım **gecikme arttıkça kendi hızını düşürmeli**. Bizim pacing ölçümü bunun elle yapılmış hâli.
6. **QUIC/WebTransport:** bağımsız akışlar (paket kaybı diğerlerini durdurmaz), güvenilmez datagram. Video için cazip; ama telefon tarafında
   (shell kimliği, `app_process`) QUIC kütüphanesi ve tarayıcı tarafında bunu kullanacak yeni boru gerekir — büyük iş; kaynaklar olgunluk
   konusunda çelişiyor.
7. **Oyun akışı örneği (Moonlight/Sunshine):** ses ve video için **ayrı QoS ayarı**, FEC, ayrı portlar. Tasarım referansı; ayrıntı kaynakları
   bulunamadı.
8. **scrcpy:** `--tunnel-host`/reverse/forward hepsi yine adb tüneli; adb'yi atlayan bir yolun gecikme ölçümünü yayınlayan kaynak bulamadım.

## 5. Seçenekler ve öneri sırası

| # | Öneri | Etki (ölçülü) | Risk/iş |
|---|---|---|---|
| **1** | **Burst'ü paylaşılan taşımada ASLA açma** | önler: yanıt 7 → 390–850 ms | sıfır |
| **2** | **Toplu dosya aktarımını ayrı taşımaya al**: ikinci adb sunucusu (kendi `ANDROID_ADB_SERVER_PORT`, kendi `adb connect`) ya da daemon'da gerçek TCP veri kanalı. Ayrı sunucuda `ADB_BURST_MODE=1` güvenli → itme 45 → 82 MB/s; gerçek zamanlı taşıma etkilenmez (doğrudan yankı 34 ms, 390 değil) | HOL biter; hız +%80 (itme) | orta. **USB'de uygulanamaz** (tek adb sunucusu cihazı tutar); yalnız Wi-Fi |
| **3** | **Bağlantı düzeyinde pacing/hız sınırı**: transfer hızını ~55–60 MB/s ile (veya bağlantı tavanının ~%75'i) sınırla; daha iyisi: gerçek zamanlı kanalın RTT'sini izleyip aktarım hızını uyarlamak (LEDBAT benzeri) | gecikme eklentisi 35 → 4–7 ms, hız kaybı ~%20 | düşük–orta |
| 4 | Eşzamanlı dosya sayısını (`FS_TRANSFER_WORKERS=3`) video penceresi açıkken/etkileşim varken düşürmek | bufferbloat azalır | düşük |
| 5 | Telefon tarafı soketlere (video/ses) DSCP (`setTrafficClass`) — önce deney | belirsiz (AP/sürücü eşlemesine bağlı) | düşük (deney) |
| 6 | Uzun vade: video için adb tünelini atlayan doğrudan TCP/UDP + FEC, ayrı soketler, QoS | HOL tamamen biter | yüksek |
| 7 | Ağ düzeyi: ax kapalı (4×), mümkünse gerçek bir yönlendirici (fq_codel/AQL'li) ya da USB 3 | hız/gecikme | kullanıcı ayarı |

**Önerilen uygulama sırası:** (1) kuralı koy → (3) pacing'i dosya aktarımına ekle (en ucuz, en büyük gecikme kazancı) → (2) toplu aktarımı
ayrı taşımaya al ve orada burst aç (hız) → (5)-(6) araştırma.

## 6. Sınırlar
Tek telefon/laptop/hotspot; gecikmeler ~25 örnek/sn, her nokta bir koşu; "adb taşıması" yankısı `adb shell -T` + `read/echo` ile ölçüldü (gerçek
video akışının kendisi değil; gerçek video kare gecikmesi ölçülmedi). Burst senaryolarında adb yankı örneği az (n=10, probe bloke olduğu için)
— değerler alt sınır. Pacing deneyi alıcıda/gönderen uçta yapıldı; AP kuyruğu telefonda olduğu için başka ağlarda sonuç değişebilir.
Ayrı adb sunucusunun aynı cihazda eşzamanlı çalışması denendi (iki sunucu, iki TCP bağlantısı) ve çalıştı; üretimde sürdürülebilirliği
(kimlik doğrulama anahtarları, `adb connect` ömrü) denenmedi. DSCP/WMM etkisi ölçülmedi.

## Kaynaklar
* AOSP adb — delayed ACK / burst mode: https://android.googlesource.com/platform/packages/modules/adb/+/refs/heads/main/docs/dev/delayed_ack.md
* ADB Wi-Fi 2.0 (Android 17): https://android-developers.googleblog.com/2026/09/wireless-debugging-adb-wifi-2.html
* Ending the Anomaly — Wi-Fi gecikme ve airtime fairness (USENIX ATC'17): https://www.usenix.org/conference/atc17/technical-sessions/presentation/hoilan-jorgesen
* WMM erişim kategorileri: https://help.mikrotik.com/docs/x/_oAADg
* Linux kablosuz QoS (DSCP → 802.1d → AC): https://wireless.docs.kernel.org/en/latest/en/developers/documentation/qos.html
* LEDBAT (RFC 6817): https://www.rfc-editor.org/info/rfc6817 · Lower-Effort PHB (RFC 8622): https://datatracker.ietf.org/doc/draft-ietf-tsvwg-le-phb/09/
* WebSocket vs WebTransport: https://websocket.org/comparisons/webtransport/
* Sunshine yapılandırması (ses/video ayrı QoS): https://docs.lizardbyte.dev/projects/sunshine/master/structstream_1_1config__t.html
* scrcpy bağlantı/tünel: https://docs.tangoapp.dev/scrcpy/connect-server
