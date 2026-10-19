> **Language note:** Turkish (translation is on the [roadmap](../ROADMAP.md)). Product requirements and the implemented design of the
> Device Center (connect, saved devices, disconnect, USB ⇄ Wi-Fi) — research first, then the plan, then what was built.

# Cihaz Yöneticisi — Ürün Gereksinimleri ve Tasarım

> Durum: **Uygulandı** (backend + frontend). Yöntem: önce kod okundu ve kullanıcı iş akışları uçtan uca izlendi (§1–§2),
> kök nedenler kodla gösterildi (§3), sonra kararlar (§4) ve tasarım (§5–§7) yazıldı.

---

## 0. Özet

**Problem.** Cihaz Merkezi bir kullanıcının telefonuyla ilişkisini *yönetemiyordu*: "Bağlantıyı kes" bağlantıyı kesiyor, birkaç saniye
sonra takılı kablodan ya da açık kablosuz hattan **kendiliğinden yeniden bağlanıyordu**; kayıtlı cihazlar yalnız taskbar panelinde,
tahmini bir eşleştirmeyle görünüyordu; eşleştirme penceresinde (QR) ne kayıtlı cihazlar ne de "USB ile bağlan" seçeneği vardı.

**Karar.** Cihazı *fiziksel telefon* olarak modellemek (bir telefonun USB ve Wi-Fi hatları tek kartta), kullanıcının "kes" kararını
backend'de **otomatik bağlanmayı duraklatan** bir durum olarak saklamak ve tek bir **"Cihaz bağla"** penceresinde *Cihazlarım*
(bu bilgisayarda görünenler + kayıtlılar + USB) ile *Yeni cihaz ekle*'yi (QR / kod / 5555) birleştirmek.

---

## 1. Kullanıcılar ve işleri (Jobs to be done)

| # | Kullanıcı ne ister | Bugün | Hedef |
|---|---|---|---|
| J1 | İlk kez: telefonu bağlamak | QR penceresi kendiliğinden açılır; USB yolu anlatılmaz | Tek pencere: USB'yi tak (canlı bekler) · QR · kod · 5555 |
| J2 | Her gün: aynı telefona tek tıkla dönmek | Kayıtlı liste yalnız taskbar panelinde; pencerede yok | Kayıtlı cihazlar hem panelde hem bağlanma penceresinde, tek tık |
| J3 | Kabloyu çıkarmak için kablosuza geçmek | Çalışır ama ilerleme görünmez, port alanı göze batar | Hat seçici (USB ⇄ Wi-Fi), adım adım ilerleme, "kabloyu çıkarabilirsiniz" |
| J4 | Kablosuzdan daha hızlı USB'ye dönmek | **Başka bir telefonun** USB hattını seçebilir | Yalnız *aynı telefonun* USB hattı; kablo yoksa nedeni söylenir |
| J5 | Bağlantıyı kesmek (mola, telefonu götürmek) | **Kesmiyor**: 4 sn sonra yeniden bağlanıyor | Kesilir ve kesik kalır; Cihazlarım listesi açılır |
| J6 | İki telefon arasında geçmek | Pencereleri öteki telefona *taşımaya* çalışır | Temiz geçiş: pencereler kapanacağı önceden söylenir |
| J7 | Kayıtlı cihazı ayıklamak / adlandırmak | Yalnız "unut" (onaysız) | Sağ tık menüsü: yeniden adlandır, kopyala, onaylı unut |
| J8 | Ne olduğunu anlamak (yetki bekliyor, çevrimdışı, yeniden bağlanıyor) | adb durumu UI'ya hiç taşınmıyor | Her satırda dürüst durum + ne yapılacağı |

## 2. İş akışlarının bugünkü izi (kod okuması)

* **Kes** — `DeviceCenter` → `POST /device/disconnect` → `AppContext._unbind_locked`: pencereler kapanır, `device_lost(user_disconnect)`,
  sonra **4 sn gecikmeli `device_bootstrap`** başlar ve `ready` olan ilk cihaza (kablosuz öncelikli) bağlanır. `GET /devices`,
  `GET /apps`, pencere açma da `ensure_device()` ile aynı şeyi yapar.
* **USB'de kes** — `adb.disconnect(None)` = argümansız `adb disconnect` → **tüm** kablosuz adb bağlantıları kopar.
* **USB'ye dön** — `useDeviceHub.switchLink`: `devices.find(d => d.link === 'usb')` — listedeki *herhangi* bir USB cihazı.
* **Başka cihazı etkinleştir** — `POST /device/bind` → `switch_transport` → `migrate_transport(old, new)`: başka telefona pencere taşıma.
* **Kayıtlı cihaz "zaten görünüyor mu"** — seri numarası `ip:port` tahminiyle; USB kaydı hiçbir zaman eşleşmez.
* **Eşleştirme penceresi** — `App.jsx`: yalnız `disconnected && pencere yok && bir kez kapatılmamış` ise; bir kez kapatılınca oturum
  boyunca bir daha açılmaz. İçinde cihaz listesi yok.
* **Durum** — `useDeviceHub` adb durumunu (`unauthorized`, `offline`) atıyor: her liste satırı "Kullanılabilir".
* **Bilinen cihazlar** — panel kapalıyken bile 8 sn'de bir yoklanıyor (`Taskbar` her zaman `useDeviceHub` çağırıyor).

## 3. Kök nedenler

1. "Kullanıcı kesti" bilgisi hiçbir yerde tutulmuyor → otomatik bağlanma onu geri alıyor.
2. Backend bir adb hattının *hangi telefona* ait olduğunu bilmiyor (yalnız bağlı olanın `android_id`'si) → hatlar gruplanamıyor,
   kayıtlılar eşlenemiyor, "aynı telefonun USB'si" sorulamıyor.
3. Bağlanma deneyimi iki ayrı yüzeyde (panel + QR penceresi), ortak durumsuz.

## 4. Kararlar

| Karar | Gerekçe |
|---|---|
| **K1 · Otomatik bağlanma duraklatma** (`auto_connect_paused`). Kullanıcı kesince açılır; açık bir bağlanma eylemi (cihaz seç, kayıtlıya bağlan, eşleştir, manuel IP) kapatır. Açılış döngüsü ve `ensure_device` buna uyar. Bellekte tutulur: uygulama yeniden açılınca otomatik bağlanma yine çalışır. | "Kes" bir karardır, geçici bir durum değil. Kalıcı yapmak ilk açılışta "neden bağlanmıyor?" sorusunu doğurur. |
| **K2 · Hat kimliği.** Backend, `device` durumundaki her hattın `android_id`'sini bir kez okur (hat başına tek `settings get`, `transport_id` değişince yeniden) ve `DeviceInfo.android_id` olarak yayınlar. | Fiziksel telefon modeli, kayıtlı eşleme ve güvenli USB'ye dönüş buna dayanır. |
| **K3 · Kesme yalnız kendi hattını keser.** Kablosuz hat `adb disconnect ip:port`; USB'de adb'ye dokunulmaz. | Argümansız `adb disconnect` başka bağlantıları da koparıyordu. |
| **K4 · Başka telefona geçiş = temiz oturum değişimi.** `switch_transport` farklı `android_id` görürse eski oturumu kapatır (`device_lost(device_switch)`) ve yenisini kurar. UI, açık pencere varsa önce onay ister. | Pencere taşıma yalnız aynı telefonun hatları arasında anlamlı. |
| **K5 · Tek "Cihaz bağla" penceresi.** Cihazlarım (bu bilgisayarda görünenler, kayıtlılar, USB yönergesi) + Yeni cihaz ekle (QR / 6 haneli kod / 5555). Panelden, kesmeden sonra ve ilk açılışta aynı pencere açılır. | Kullanıcı "nereden bağlanırım?" diye iki yüzey aramaz. |
| **K6 · Kayıtlı cihaza takma ad** (`alias`, `PATCH /devices/known/{id}`). | Aynı modelden iki telefon ("Redmi Note 13") ayırt edilemiyordu. |
| **K7 · Durum dürüstlüğü.** `unauthorized` → "Telefonda izin verin", `offline` → "Çevrimdışı", oturum `lost` → "Yeniden bağlanıyor", `switching` → "Hat değiştiriliyor". | Projenin "uydurma değer yok" ilkesi bağlantı durumu için de geçerli. |

## 5. Bilgi mimarisi

```
Fiziksel cihaz (android_id ile; bilinmiyorsa seri numarası)
 ├─ hatlar: [{seri, usb|wifi, adb durumu, etkin mi}]
 ├─ kayıt: KnownDevice | null   (ad, takma ad, son IP/port, kablosuz eşleşmiş mi)
 └─ durum: connected · reconnecting · binding · switching · ready · unauthorized · offline · discovered · saved
Bölümler: Etkin cihaz · Bu bilgisayarda (bağlı değil) · Kayıtlı (şu an görünmüyor)
```

Saf model: `frontend/src/devices/deviceModel.js` (`groupDevices`, `deviceMenu`) — testli.

## 6. Etkileşim tasarımı

* **Cihaz Merkezi (taskbar paneli).** Etkin cihaz kartı: ad + durum satırı, **hat seçici** (USB | Wi-Fi; olmayan hat devre dışı
  ve nedeni ipucunda), hat değişirken kartın üstünde ilerleme şeridi, ölçümler, katlanabilir işlemci dağılımı, "Bağlantıyı kes"
  (açık pencere varsa satır içi onay). Altında *Bu bilgisayarda* ve *Kayıtlı* listeleri, en altta "Yeni cihaz ekle".
* **Satırlar.** Fareyle üstüne gelince ikincil eylemler belirir; tüm satır klavyeyle odaklanır; **sağ tık** (ya da ⋯ düğmesi,
  ya da Shift+F10 / Menü tuşu) bağlam menüsünü açar: Bağlan / USB'ye geç / Kablosuza geç / Bağlantıyı kes · Yeniden adlandır ·
  Seri numarasını / IP'yi kopyala · Kayıtlılardan kaldır (onaylı). Menü ↑/↓/Home/End ile gezilir, Esc kapatır.
* **Yeniden adlandır** satır içinde: Enter kaydeder, Esc vazgeçer, boş bırakmak model adına döner.
* **Geri bildirim** eylemin yapıldığı yerde: düğme dönen simge + fiil ("Bağlanıyor…"), sonuç satırın altında kısa bir not; oturum
  değiştiren sonuçlar (kesildi, hat değişti) ayrıca sistem bildirimiyle duyurulur.
* **Hareket.** `framer-motion` `layout` ile satırlar bölümler arasında kayar (kayıtlı → etkin), giriş/çıkış 160–220 ms, azaltılmış
  hareket tercihinde yalnız opaklık.

## 7. API değişiklikleri

| Uç | Değişiklik |
|---|---|
| `DeviceInfo` | `android_id: str \| null` |
| `GET /devices/state`, `devices_changed` | `auto_connect_paused`, `switching`, `active_android_id` alanları |
| `POST /device/bind` | Oturum yoksa bağlar; başka telefonsa temiz geçiş; otomatik bağlanma duraklatmasını kaldırır |
| `POST /device/disconnect` | Yalnız etkin kablosuz hattı adb'den ayırır; otomatik bağlanmayı duraklatır |
| `PATCH /devices/known/{android_id}` | `{alias}` — takma ad (boş = model adı) |
| `KnownDevice` | `alias: str \| null` |

## 8. Kapsam dışı (bilerek)

* Duraklatmanın uygulama yeniden başlatmalarına taşınması (K1 gerekçesi).
* Aynı anda iki telefona oturum (backend tek oturum varsayar).
* Wi-Fi ⇄ USB geçişinin kabloyu takınca kendiliğinden yapılması — öneri olarak gösterilir, karar kullanıcınındır.
