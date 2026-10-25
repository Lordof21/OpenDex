> **Language note:** Turkish (translation is on the [roadmap](../ROADMAP.md)). Review of the on-phone helper's architecture.

> Durum: değerlendirme raporu (2026-10-11). R1–R9 önerileri bu raporla uygulanmadı; ayrıntılı gelişmeler için ilgili kod ve [DAEMON_PROTOCOL.md](../DAEMON_PROTOCOL.md).

# "Daemon" gerçekten daemon mu? — Mimari değerlendirme

Tarih: 2026-10-11 · Kapsam: `OpenDexDaemon.java` (+ `backend/java/src/com/opendex/tools/*`), `device_daemon_client.py`,
`docs/DAEMON_PROTOCOL.md`, canlı cihaz (POCO 2412DPC0AG, HyperOS 3 / Android 16) · **Kod değiştirilmedi.**
Cihazdan yalnızca okuma yapıldı (`ps`, `/proc/<pid>`, daemon logu).

---

## 1. Kısa cevap

**Kısmen.** İsim, Unix anlamında doğru: uzun ömürlü, terminalden ayrılmış, kendi sürecinde, bir soket üzerinden hizmet veren
arka plan süreci. Ama "daemon" kelimesinin çağırdığı **kendi kendini ayakta tutan, kalıcı, gözetilen servis** beklentisini
karşılamıyor. Gerçekte olan şey:

> **PC tarafından gözetilen, oturum-ömürlü, cihaz-içi bir yardımcı servis (agent/sidecar).** Telefonda onu yaşatan, izleyen
> ya da yeniden başlatan hiçbir şey yok; bütün gözetim PC'deki backend'de.

Bu bir kusur değil, root'suz çalışmanın doğal sonucu (init'e servis eklenemez). Ama isim bazı şeyleri vaat ediyor
(otomatik toparlanma, kalıcılık, kendi sağlık denetimi) ve bu vaatlerin bir kısmı kodda **yok**. Aşağıda kanıtlarla.

Genel not: **6 / 10** — protokol, güvenlik ve geri-düşüş (fallback) tasarımı güçlü; süreç içi dayanıklılık, gözlemlenebilirlik
ve modülerlik zayıf.

---

## 2. Daemon ölçütleri — ne var, ne yok

| Ölçüt | Durum | Kanıt |
|---|---|---|
| Terminalden/oturumdan ayrılma | ✅ | `nohup app_process … &` (`device_daemon_client.py:352`); cihazda `PID 25392 PPID 1` — init'e devredilmiş |
| Ayrı süreç + tanımlı IPC | ✅ | soyut UNIX soketi `opendex_daemon` + satır-JSON (`DAEMON_PROTOCOL.md`); ikinci soket PCM için |
| Tek örnek (singleton) | ✅ (örtük) | soyut soket bağlanması ikinci örneği reddeder (`LocalServerSocket`); PID dosyası/kilit yok ama gerekmiyor |
| Kimlik doğrulama | ✅✅ | `SO_PEERCRED` (yalnız uid 0/2000) + karşılıklı HMAC-SHA256, anahtar stdin'den, `shell`/`fs_*` yalnız anahtarla |
| Sürüm / uyumluluk | ✅ | protokol 1.2 "yalnız ekle", `build` = jar MD5 → eski bytecode tespit + bir kez yeniden başlatma, yetenek listesi ile kapılama |
| Geri-düşüş (fallback) | ✅ | her yetenek için `adb shell` yolu; daemon "hızlandırıcı, zorunluluk değil" |
| Kendini yeniden başlatma / süpervizör | ❌ (telefonda) | gözetmen PC'de: `_connection_supervisor` (1 s ×1,5, tavan 5 s) ve `_ensure_daemon_spawned` (`pgrep -f` → `pkill -f` → spawn). Telefonda watchdog/respawn yok |
| Kalıcılık (boot, PC'siz yaşam) | ❌ | tasarım gereği: son istemci ayrıldıktan **5 dk sonra kendini kapatır** (`IDLE_TIMEOUT_MS`, `System.exit(0)`) — "oturum-ömürlü" |
| Süreç içi hata yalıtımı | ⚠️ | tek JVM, 37 iş parçacığı; yakalanmamış istisna yalnız `main` için ölümcül (iyi), ama aşağıda bkz. §3.3 |
| Sağlık/liveness | ⚠️ | açılışta `health_check` (3×3 sn). Sonrasında **kontrol soketinde canlılık döngüsü bulamadım**: okuma `timeout=None` (`device_daemon_client.py:431`); `ping` yalnız RTT ölçümü (telemetri) ve ses senkronu için. Sessiz kalmış (half-open) bir bağlantı RPC zaman aşımlarıyla anlaşılır. Ses kanalında keepalive var (4 sn), kontrol kanalında yok |
| Gözlemlenebilirlik | ⚠️ | `status` RPC ve `/data/local/tmp/opendex-daemon.log` var; ama günlük döndürme yok, hatalar çoğunlukla yutuluyor (§3.4) |
| Modülerlik / test edilebilirlik | ❌ | `OpenDexDaemon.java` **2613 satır**, 133 `static`, 52 `case`; Java testleri 1175 satır ve yalnız "saf" sınıfları kapsıyor |

---

## 3. Cihazda ve kodda doğrulanan bulgular

### 3.1 Süreç profili (canlı cihaz, 2026-10-11 19:2x)
* `PID 25392, PPID 1, kullanıcı shell, SELinux u:r:shell:s0`, 37 iş parçacığı, 143 açık dosya tanıtıcısı.
* **Bellek: VmRSS 174 MB, tepe (VmHWM) 259 MB.** Bir "yardımcı servis" için ağır; bir ART çalışma zamanı + ikon/küçük-resim
  işleri (`IconExtractor`, `fs_thumb`) aynı süreçte. Ölçülmedi: hangi alt sistem payı taşıyor.
* `oom_score_adj = -1000`: LMK tarafından öldürülmez. Bu bir tasarım garantisi değil, **adbd'den miras kalan** bir değer
  (aynı cgroup'ta: `0::/system/uid_0/pid_13903`, `13903 = adbd`). Yararlı bir tesadüf; belgelenmemiş.
* **Hipotez (doğrulanmadı):** süreç adbd'nin cgroup'unda olduğu için adbd yeniden başlarsa (`adb tcpip`, USB kipi/Kablosuz
  hata ayıklama değişimi) init cgroup'u temizleyip daemon'u da öldürebilir. PC gözetmeni bunu "daemon düştü" olarak görüp
  yeniden başlatır; ama ayrım yapılmadığı için gereksiz gecikme olur. Denemek için: çalışırken `adb tcpip 5555` + `ps`.

### 3.2 Çalışan daemon'da sürekli başarısız bir yetenek
Daemon logunda **23 dakikada 314 kez** (her ~4,8 sn, `tick % 4` döngüsü):

```
WARN [States] toggles unreadable — shell identity: Unable to find app for caller …IApplicationThread$Stub$Proxy… when getting
content provider settings; system context: Given calling package android does not match caller's uid 2000
```

Yani Android 16/HyperOS 3'te daemon'un hızlı-ayar durumlarını (Wi-Fi, Bluetooth, mobil veri…) süreç içinde okuma yolu
**kalıcı olarak bozuk**, ama:
* `states_get` greeting'deki **yetenek listesinde duruyor** — yetenekler statik bir liste, çalışma zamanı sağlığı yok;
* aynı başarısız çağrı **geri çekilme (back-off) olmadan** sonsuza dek tekrarlanıyor;
* backend yedek yola düşüyor (`devices.py:301-318`, tek `adb` komutu) — yani **fallback tasarımı işe yarıyor**, kullanıcı
  bozulmayı görmüyor, ama daemon sağlıklı görünürken bir özelliği sessizce kaybediyor.

### 3.3 Tek `scheduler` iş parçacığı bütün itici (push) alt sistemleri taşıyor
`Executors.newSingleThreadScheduledExecutor()` (`OpenDexDaemon.java:119`) şu işleri paylaşıyor: 1,2 sn'lik ana tick
(medya, ses seviyeleri, pil, durumlar), `TaskEvents`, `ThermalEvents`, `NotificationEvents`. Bunlardan biri bir Binder
çağrısında takılırsa **hepsi** durur; tick içinde bütün istisnalar `catch (Throwable ignored) {}` ile yutuluyor
(`OpenDexDaemon.java:2484`) — bir arıza ne log ne metrik üretir. Telefon tarafında bu durumu fark edip süreci temiz bir
şekilde sonlandıracak (PC'nin yeniden doğurması için) bir bekçi yok. Tek RPC havuzu 2 iş parçacığı; dolunca `busy`.

### 3.4 Hataları yutma ve gizli-API kırılganlığı
* `catch (Throwable` **228** yerde; bunların **127'si sessiz** (`ignored`).
* Yansıtma (`getMethod/getField/Class.forName`…) **153** çağrı: Android sürümü/OEM değiştikçe sessizce bozulabilecek gizli API
  yüzeyi. (Bunun gerçek örneği §3.2.) Yeni cihazda hangi yeteneğin çalıştığını açılışta doğrulayan bir "öz-sınama" yok.
* Yanıltıcı log: `[WCT:TIER2_BINDER_SUCCESS] … ok=false` (`OpenDexDaemon.java:1722`) — "SUCCESS" yazıp başarısızlığı
  bildiriyor; bugünkü logda iki kez görüldü (`taskId=489 -> display=0 ok=false`).

### 3.5 Gözetim asimetrisi
* Yaşatma/yeniden başlatma **tamamen PC'de**. PC uykuya geçerse/backend düşerse: 5 dk sonra daemon kapanır; ses politikaları
  3 sn, ekran-karartma 30 sn sonra geri alınıyor (iyi tasarlanmış bir "ölü adam" mantığı).
* `pgrep -f OpenDexDaemon` ile ad-tabanlı tespit (adbd üzerinden çalıştırılan kendi `sh -c` satırını da eşleştirebilen,
  kırılgan bir desen; PC kodu bunu yorumla biliyor ve dolaşıyor). Daha sağlam: soket varlığına bakmak (`/proc/net/unix`).

---

## 4. Güçlü yanlar (korunmalı)
1. **Anahtar yönetimi ve protokol** üretim kalitesinde: karşılıklı kimlik doğrulama, anahtar argv'de yok, `shell` ayrıcalığı
   yalnız el sıkışmadan sonra, satır sonu enjeksiyonuna karşı istemci tarafı koruma.
2. **"Yalnız ekle" sürümleme + yetenek kapılama + her yerde fallback** — eski/yeni jar eşleşmesi bir kesinti değil, yavaşlama.
3. **Ölü-adam güvenlikleri**: ekranı geri açma (işaret dosyasıyla çökme sonrası da), ses politikalarının serbest bırakılması.
4. **Stale-bytecode tespiti** (`build` MD5) ve tek sefer yeniden başlatma.

---

## 5. Öneriler (öncelik sırasıyla — hiçbiri uygulanmadı)

| # | Öneri | Etki |
|---|-------|------|
| R1 | **Yetenek başına çalışma-zamanı sağlığı**: açılışta her okuma yeteneğini bir kez dene, çalışmayanı greeting'e koyma; tekrarlayan hatada geri çekil + `status`'ta raporla (§3.2'deki 314 log satırı biter) | Yüksek, düşük risk |
| R2 | **Kontrol kanalı canlılık döngüsü**: 5–10 sn'de bir `ping`, N kayıp → bağlantıyı kapat ve yeniden kur (şimdi yalnız RPC zaman aşımı yakalar). Ses kanalındaki keepalive deseninin aynısı | Yüksek |
| R3 | **Her itici alt sistem için ayrı yürütücü** + telefon tarafı bekçi iş parçacığı (tick N sn ilerlemediyse `System.exit` → PC temiz yeniden doğurur) | Orta-yüksek |
| R4 | **Gözlemlenebilirlik**: `status`'a yetenek başına {çağrı, hata, son hata}, yürütücü kuyruk derinliği, bellek; sessiz `ignored` yakalamalarını sayaçlı hale getir; log döndürme | Orta |
| R5 | **Parçalama**: 52 `case`'lik anahtar → komut kayıt defteri (`ad → işleyici sınıf`), alt sistemleri ayır; sahte Binder ile JVM testi | Orta (uzun vade) |
| R6 | **adbd yeniden başlama ayrımı** (§3.1 hipotezini önce doğrula): cihaz `offline`→`device` olayını daemon çöküşünden ayır, daha hızlı yeniden bağlan | Düşük-orta |
| R7 | **Bellek**: 174/259 MB'ın dökümü (heap + alt sistem); `app_process -Xmx…` ile tavan düşünülebilir | Orta (ölçüm gerekir) |
| R8 | **Adlandırma**: "daemon" korunabilir; dokümanda "PC-gözetmenli, oturum-ömürlü cihaz-içi servis" tanımı açıkça yazılsın (kimsenin "telefonda kendi kendine toparlanır" varsaymaması için). Karşılaştırma: Shizuku de aynı modeli kullanır (adb ile `app_process`, shell uid) — bu sektörde yerleşik bir desen | Düşük |
| R9 | Yanıltıcı log düzeltmesi (`TIER2_BINDER_SUCCESS … ok=false`) | Düşük, çok ucuz |

**Sınırlar:** Shizuku karşılaştırması genel bilgidir (bu oturumda aramadım). §3.1'deki adbd-cgroup öldürme hipotezi ve
bellek payı dökümü ölçülmedi. Java tarafı satır sayıları/`grep` sayımlarıdır, kapsamlı bir kod incelemesi değildir.
