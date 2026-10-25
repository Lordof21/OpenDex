> **Language note:** Turkish (translation is on the [roadmap](../ROADMAP.md)). Research on holding the last good frame during resize/handoff.

> Durum: araştırma + ölçüm (2026-10-12); kapı uygulanmadı. Sonradan resize'da Display 0'a sızan geçiş karesi ayrıca çözüldü: [HANDOFF.md](../design/HANDOFF.md) §7.

# Geçiş karelerini ekrana sızdırmamak — araştırma (2026-10-12)

Soru: Telefona aktarma ve yeniden boyutlandırma sırasında "çöp" kareler (yarım çizilmiş, gerilmiş, boş) PC'ye ulaşıyor. Biz
Android'in pencere/SurfaceFlinger sırasını belirleyemiyoruz; ama **hazır olana kadar eski kareyi tutup hazır olunca yeni bir
I-frame ile devam eden** bir kapı (gate) kurulabilir mi? Ekran siyaha dönmemeli. Bu belge yalnızca araştırmadır; kod değişmedi.

## 1. Bugün kareler nereden nereye akıyor

| Halka | Dosya | Geçişte ne yapıyor |
|---|---|---|
| Kodlayıcı | scrcpy `SurfaceEncoder.encode()` | Her paketi `streamer.writePacket` ile yazar. Resize/reset'te sıra: `writeSessionMeta` → config paketi → **I-frame #0** (yani reset anında SurfaceFlinger'ın VD'ye ne kompoze ettiyse o). |
| Backend pompa | `session_reconfigure.start_video_pump` | Her kareyi `broadcaster.broadcast`'a verir; içerik denetimi yok. Session paketini yutar (yalnızca resize onayı için). |
| Dağıtıcı | `streams/broadcaster.py` | GOP bütünlüğü kuralı: ortadan kare atmaz. **`needs_key` durumu zaten var**: istemci "son geçerli resimde kalır", keyframe gelince devam eder. |
| Çözücü | `media/videoDecoder.js` | Gelen her kareyi çözer ve `drawImage` ile boyar. `FramePacer` yalnızca birikme olunca *sunumu* atlar (çözme zinciri bozulmaz). |
| Önyüz | `VideoCanvas.jsx` | Çözünürlük değişince önceki kareyi `freezeCanvas`a kopyalar, ilk yeni kareyle 120 ms'de söndürür. Handoff'ta `HandoffOverlay` (%60 buzlu cam) üstte durur; altındaki canvas canlı kalır. |

Yani **hiçbir halkada "bu kare geçiş karesi mi?" sorusu sorulmuyor**; `freezeCanvas` yalnızca *boyut değişim anındaki* tek kareyi örtüyor.

## 2. Çöp kareler neden oluşuyor

Üç bağımsız oyuncu var ve aralarında sıra garantisi yok:
1. **DisplayManager**: `VirtualDisplay.resize` hemen uygulanır; SurfaceFlinger çıkışı yeni boyuta geçer, kodlayıcı resetlenir.
2. **WM/ATMS**: uygulamaya yeni konfigürasyonu iletir.
3. **Uygulama**: yeniden yerleşim + çizim (50–300 ms; Chrome/WebView daha uzun).

Kodlayıcı bu sırada kendi saatiyle örnekler. Reset'in I-frame'i (#0) çoğu zaman *eski tamponun gerilmiş hali*, siyah ya da duvar kâğıdıdır — "ilk kare bir anda sıçrıyor" budur. Handoff'ta da görev VD'den ayrılınca VD bir an boş kalır (duvar kâğıdı/siyah/geçiş animasyonu anlık görüntüsü), VD yok edilene kadar bu kareler akar ve buzlu katmanın arkasında "gidip gelme" olarak görünür.

**Önce şunu ayıkla:** bugün bulduğumuz adbd yeniden başlaması (ekran kilidi → USB işlevi değişimi) de pencereleri FROZEN → UNFROZEN döngüsüne sokuyor ve bu da "görüntü gidip geliyor" gibi görünür. Telefon ayarı düzeltildiyse o kısım gider; geriye kalanlar bu belgenin konusu.

## 3. Doğru ilkel: "tut ve devam et", tek I-frame silmek değil

Tek bir I-frame'i çöpe atmak yetmez: arkasından gelen P-kareler ona dayanır. İki doğru yol var:

**A. Sunum kapısı (PC, çözücüde):** Kareler çözülmeye devam eder (zincir sağlam), ama kapı kapalıyken `drawImage` yapılmaz. Canvas eski pikselleri tutar, siyah olmaz. Kapı açılınca bir sonraki çözülen kare boyanır.
- Ekstra I-frame gerekmez, backend/APK değişmez; çözme maliyeti önemsiz.
- Yalnızca `_renderWithSync` içinde (FramePacer'ın olduğu yerde) bir bayrak.
- Tetikleyici **bant içi** olabilir: reset her zaman yeni bir **config paketi** getirir (`isConfig`; HEVC'de boyut SPS'te). Backend'in ayrı bir olay göndermesi gerekmez, yarış (olay soketi ↔ video soketi) olmaz.

**B. Tut ve yeni I-frame ile devam (backend ya da sunucu):** Kapı kapalıyken hiç kare iletilmez; açılırken `PARAMETER_KEY_REQUEST_SYNC_FRAME` ile taze I-frame istenir (**yama 0004 zaten var**, kodlayıcı yeniden başlamaz) ve akış ondan başlar.
- Backend sürümü: `FrameBroadcaster` zaten `needs_key` bayrağına sahip; "kapı" = tüm istemcileri `needs_key` yap + `_gop` önbelleğini düşür (geç bağlanan çöpü oynatmasın) + açılışta keyframe iste. `KEYFRAME_REQUEST_MIN_INTERVAL_S=1.5` sınırı bu istek için aşılmalı.
- Sunucu sürümü = **yama 0005** (`OPENDEX_HOLD`, tip 202, `u16 settle_ms`; `SurfaceEncoder.encode()` içinde kapı kapalıyken `writePacket` atlanır, açılışta `requestSyncFrame()`, duyuru `frame_hold`). ~40 satır Java; adb hattında çöp kare bant genişliği de harcanmaz. Ama APK yeniden derleme + vendor + sha gerekir ve README'nin "küçük yama" kuralını zorlar.
- Bedel: bir ek I-frame (10–150 KB) ve geçiş gecikmesi kadar bekleme.

Öneri sırası: **A** (en ucuz, en güvenli) → gerekirse B-backend → B-sunucu yalnızca bant genişliği/kesinlik gerekirse.

## 4. Asıl zor soru: kapı ne zaman açılır ("hazır" sinyali)

| Sinyal | Güvenilirlik | Not |
|---|---|---|
| Sabit süre (ör. 150–250 ms) | Orta | En basit; uygulamaya göre değişir (Chrome 300–800 ms). Tek başına yama gibi kalır. |
| Kare boyutu sakinleşmesi | **Düşük** | Gerilmiş eski tampon *statik* olduğundan küçük P-kareler üretir → "oturdu" sanılır; asıl çizim bundan sonra büyük bir kare olarak gelir. Tek başına kullanılamaz. |
| WM/SF "uygulama yeni boyutta çizdi" | **Yüksek** | `dumpsys SurfaceFlinger`'da görev katmanının `scale x/y` değeri tampon yeni boyuta oturunca 1,0'a döner (handoff çalışmasında zaten bu satırı okuyorduk: `Layer … Task=ID# … scale x= y=`); WindowState `mDrawState=HAS_DRAWN` de aynı bilgiyi verir. Daemon'dan süreç içi okunabilir (dumpsys poll'u ağır ve HyperOS'a bağlı; ölçülmeli). |
| Handoff için bilinen olaylar | **Kesin** | Görev VD'den ayrıldığı an (WCT move tamam) kapı kapanır ve **geri alma (reclaim) / yeni VD'ye kadar açılmaz**. Heuristik yok. |

Güvenlik: her durumda **sert üst sınır** (resize ≈ 400–500 ms, ilk açılış hariç) — video/oyun gibi hiç oturmayan içerik kilitlenmesin.

## 5. Önerilen uygulama sırası

0. **Ölçüm (kod yok, ~1 saat):** video WS'ine bağlanıp reset sonrası kare (zaman, boyut, key) profilini kaydet; aynı anda görev katmanı `scale`ini 50 ms'de örnekle. Notlar / Chrome / YouTube için "çöp penceresi" süresini ve SF sinyalinin işe yarayıp yaramadığını görürüz. (Backend şu an kapalı; açılınca çalıştırılır.)
1. **Handoff kapısı:** görev ayrıldığında kapat, reclaim'de aç. Deterministik, en yüksek getiri/risk oranı.
2. **Resize kapısı:** config boyutu değişince kapat; kapanış = (varsa) SF sinyali ya da min bekleme, hepsi sert üst sınırla. Sürükleyerek boyutlandırmada kapı kullanılmaz (zaten eski kare ölçeklenerek gösteriliyor; gecikme hissi yaratır) — yalnızca sürükleme bitince ya da backend kaynaklı reset'lerde.
3. (İsteğe bağlı) Yama 0005.

## 6. Riskler

- Her kapı gecikme ekler: kullanıcı "eski kare uzun kaldı" diyebilir → süreler ölçümle seçilmeli.
- Çok istemcili durumlar (pop-out, Workspace PiP): A'da her çözücü kendi kapısını yönetir; bant içi tetik bunu tutarlı kılar.
- Kapı sırasında bağlanan yeni istemci: config + GOP ile başlar; kendi kapısı da config'te kapanır.
- `freezeCanvas` ile çift örtme olmasın: kapı varken freeze katmanı gereksizleşir (kaldırılabilir ya da kapıyla birleştirilir).

## 7. Ölçüm sonuçları (2026-10-12, adb over TCP `10.175.243.80:5555`)

Yöntem: backend'in video WS'ine bağlanıp ham akışı kaydettim, PyAV ile çözdüm; her kareyi, aynı kodlayıcı neslinin **son (oturmuş) karesine** olan
ortalama piksel farkıyla (`dist`, 0–255) ölçtüm. Zaman olarak PC'ye varış değil **cihaz PTS'i** kullanıldı (WS kareleri ~16 ms'lik gruplar halinde
geliyor). Aynı anda `dumpsys SurfaceFlinger` katman boyutu ~9 Hz örneklendi. Betikler: scratchpad `measure_gate.py`, `report_gate.py`. Kod değişmedi.

| Uygulama | Reset sonrası çöp penceresi (dist>1) | İlk kare | Görünen şey |
|---|---|---|---|
| Keep Notes (hafif, yeniden başlatmıyor) | **~130–150 ms**, 7–9 kare | dist ≈ 13–17 | Yarım çizilmiş liste, çift FAB, solan kartlar (uygulamanın kendi yerleşim animasyonu) |
| Ayarlar (etkinlik yeniden yaratılıyor) | **~390–480 ms**, 23–27 kare | dist ≈ 100–237 | **Siyah**, siyah, yarı beyaz/siyah, siyah… sonra içerik |
| Handoff ön-iniş (VD → telefon boyutu 1220×2712) | Keep: ~125–195 ms, ilk kare dist 17; Ayarlar: kısa | — | İçeriği boş liste (uygulama yükleniyor) |
| Chrome, YouTube | **ölçülemedi** | — | Tüm akış siyah: MIUI **Uygulama Kilidi** (`com.miui.securitycenter/applicationlock`) ekranda. Kilit açılmadan geçerli ölçüm yok. |

Çıkarımlar:
1. **Çöp kare gerçek ve ölçülebilir**; süresi uygulamaya göre 0,15–0,5 s. Sabit 250 ms Keep'i kapatır, Ayarlar'ı kapatmaz.
2. **Kare boyutu tek başına yanıltıcı** (varsayım doğrulandı): Keep handoff ön-inişinde ilk 4 kare ~6 KB (küçük!) ama dist 17 — gerilmiş/eksik tampon *statik*. Asıl çizim ardından
   büyük bir P-kare patlaması (40–176 KB) olarak geliyor ve çöp penceresi o patlamanın **sonunda** bitiyor (dist 10 → 1). Yani kural "sakinleş" değil **"patlama gördükten sonra sakinleş"**;
   patlama hiç gelmezse sert üst sınır.
3. **SurfaceFlinger sinyali tutarlı**: Ayarlar'da görev katmanı yeniden yaratma sırasında **2,3 sn kayboldu** (None), sonra yeni boyutlu tamponla göründü (7610 ms) — akışın oturduğu an
   (cfg 7094 + ~460 ms ≈ 7554 ms) ile ~50 ms içinde örtüşüyor. Katman yok / boyutu hedefle aynı değil → "hazır değil" okunabilir. Çözünürlük ~9 Hz (dumpsys ~320 ms); daemon içinden okunursa çok daha sık olur.
4. Handoff'ta VD yok edilirken **boş kare akmıyor** (son kareler hep uygulama içeriği; akış kesiliyor). Yani handoff'taki "gidip gelme" VD'nin boşalmasından değil, **ön-iniş yeniden boyutlandırması
   (telefon boyutuna sıçrama + uygulamanın o boyutta yeniden yüklenmesi)** kareleridir — kullanıcının "telefon ekranına sıçrıyor" dediği an bu (stream 1220×2712 olur).
5. **Yan bulgu (hata):** Ayarlar'da her resize `FLEX_FAIL: no session packet confirming … within 3.0s` ile 3 sn bekleyip **freeze/unfreeze (VD'yi yeniden kurma)** yoluna düştü
   (RESIZE-REQ→DONE ≈ 4,7–6 s; Keep'te 0,15–0,3 s). Sebep log'da: `ACK_IGNORED sunucu kaynaklı session paketi 800x1100 (beklenen 1100x800)` — **dikey kilitli uygulama ekranı döndürüyor**,
   sunucu boyutu çevrilmiş (transpoze) geliyor ve onay eşleşmiyor. Beklenen boyutun transpoze hali de onay sayılırsa 3 sn + VD yeniden kurma ortadan kalkar; bu bağımsız bir düzeltme ve çöp kare
   sayısını da azaltır (her yeniden kurma ekstra bir kodlayıcı nesli = ekstra çöp penceresi).

Sonuç: kapı fikri **uygulanabilir ve ölçüm onu destekliyor**; en az 3 sinyal birleşimi (bant içi config → ardından büyük-P patlaması + sakinleşme **ve/veya** SF katmanı yeni boyutta → sert üst sınır ~500 ms) gerekir.
Handoff'ta tetik: ön-iniş yeniden boyutlandırması başlayınca kapat, görev taşınana (WCT move tamam / pompa bitişi) kadar açma.
