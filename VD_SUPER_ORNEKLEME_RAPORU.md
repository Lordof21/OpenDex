# VD'yi büyük çizip küçük akıtmak (süper-örnekleme) — rapor

2026-10-13 · yalnızca rapor, bu konuda kod değişikliği yok · kodu okuyarak yazıldı, cihazda ÖLÇÜLMEDİ

## 0. Soru ve kısa cevap

> Xiaomi 0,7 ölçekle yüksek çözünürlüğü SurfaceFlinger'a daha düşük göstererek daha keskin sonuç veriyor.
> Biz VD için aynısını yapabilir miyiz? Örn. 400×600'lük ekrana 600×900'lük VD çizip 400×600'lük veri akıtmak.

**Yapılabilir, ama iki şeyi ayırmak gerek:**

1. **Bant genişliği kazancı bu yöntemden gelmez.** Akıtılan video yine 400×600; bit hızı, kodlayıcı yükü ve PC tarafı **bugünkü 1:1 düzenle aynı**. Süper-örnekleme bant genişliğini düşürmez, **aynı bit hızında görüntü kalitesini** (kenar yumuşatma, bloklaşma) biraz artırır. Bant genişliğini düşüren şey akıtılan çözünürlüğü küçültmektir; o zaten ayrı bir ayar.
2. **Xiaomi'nin "daha keskin" görünüşünün büyük kısmı çözünürlük değil, yerleşimdir.** Pencere mantıksal olarak 1/0,7 = 1,43 kat büyük kutuda çizilir (örnekte 1220×1952 → sw381dp), sonra 0,7'ye küçülür. Yazı küçük ama ince ve düzenli görünür çünkü uygulama telefonun tam düzenini çizer. Bu etkiyi biz zaten DPI/boyut seçerek elde ediyoruz.

**Net sonuç:** fikir, telefonun GPU'sunu k² kat daha çok çalıştırıp (k = 1,5 → 2,25 kat piksel) karşılığında yalnızca kenar kalitesinde küçük bir artış verir. Isı raporundaki (TELEFON_ISI_VE_YUK_KORUMA_RAPORU.md) tespitle çelişir: telefon zaten darboğaz. **Önce ölçmeden kod yazmamayı öneririm** (§6).

## 1. Xiaomi'nin yaptığı, bizim cihazdaki kanıtla

- HyperOS serbest pencereyi 0,7 ölçekle çizer (`HYPEROS_FREEFORM_SCALE`, [task_windowing.py](backend/app/windows/task_windowing.py)). Görevin mantıksal kutusu görünür kutunun 1/0,7 katıdır (`visible_to_android_bounds`, [eco_workspace.py](backend/app/windows/eco_workspace.py)).
- Uygulama mantıksal kutuda **tam** çözünürlükte çizer; SurfaceFlinger o katmanı 0,7'ye küçültür (GPU/HWC birleştirmesi, ek kodlayıcı maliyeti yok).
- **Yan etki (bu oturumda düzeltildi):** küçültme yazıyı da 0,7'ye indirir. Otomatik DPI görünür kutuya göre hesaplandığı için yazı hedefin %30 küçüğü çıkıyordu. Android'e artık `DPI / ölçek` yazılıyor (`android_density`, 260 → 371); arayüzdeki ve kayıtlı DPI görünür değer olarak kalıyor.

## 2. OpenDeX'te bugün VD ve akış boyutu nasıl

| Durum | VD boyutu | Akıtılan video | Arada GL geçişi |
|---|---|---|---|
| Tek pencere VD (flex, `ENABLE_FLEX_DISPLAY=True`) | pencere boyutu (`OPENDEX_RESIZE`) | VD ile **aynı** | yok (VD doğrudan kodlayıcı yüzeyine çizer) |
| Tek pencere VD (flex değil) | istenen WxH | `max_size`'a (varsayılan 1280) göre küçülür | **var**: `OpenGLRunner`, bilinear (`GL_LINEAR`) |
| Workspace paylaşımlı VD | 1920×1080 sabit | 1920×1080 (`max_size=0`) | yok |
| Telefon aynası (display 0) | telefonun ekranı | `max_size=0` | yok |

Kod yeri: [spawn_profile.py](backend/app/windows/spawn_profile.py), [scrcpy_launcher.py](backend/app/windows/scrcpy_launcher.py), `NewDisplayCapture.java` (scrcpy: flex'te `displaySize.constrain(...)` VD'yi kodlanan boyuta eşitler; flex değilken `filter.addResize` + GL küçültme).

Yani **"VD büyük, akış küçük" mekanizması scrcpy'de zaten var**, yalnızca flex olmayan kipte ve `max_size` ile. Flex kipte VD'nin kodlanan boyuta kilitli olması bilinçli: yeniden boyutlandırma tek `VirtualDisplay.resize` çağrısı ve ack'i (`_PendingAck`) bu eşitliğe dayanıyor.

## 3. Önerinin mekaniği

`k` = çizim ölçeği (örn. 1,5). Hedef akış W×H:

- VD = (k·W)×(k·H), yoğunluk = DPI·k (dp düzeni değişmesin diye; aksi halde uygulama k kat çok dp görür)
- Kodlayıcı W×H. Arada GL küçültme geçişi (VD → SurfaceTexture → W×H).
- Dokunma eşlemesi sorunsuz: scrcpy `PositionMapper` videoSize↔displaySize oranıyla çalışır, normalize koordinat kullanılır.

İki yol:

| Yol | Ne gerekir | Kapsam |
|---|---|---|
| **A. Mevcut mekanizma** | Workspace için `max_size=1280` (flex zaten kapalı) | Workspace: 1920×1080 çizilir, 1280×720 akar (k = 1,5). Kod değil, ayar. Frontend akış boyutunun VD'den farklı olabileceğini zaten destekliyor (`test_donen_stream_boyutu_VD_boyutundan_FARKLI_olabilir`). |
| **B. Yeni scrcpy yaması (0005)** | `OPENDEX_RESIZE`'a "çizim ölçeği" alanı; flex kipte VD = k·video ve GL geçişi | Tek pencere VD'ler. Ack/yeniden boyutlandırma protokolü yeniden düşünülmeli (VD ≠ video). Orta büyüklükte iş. |

## 4. Maliyet / kazanç — dürüst tablo

| Kalem | k = 1 (bugün) | k = 1,5 |
|---|---|---|
| Akıtılan piksel, bit hızı | W×H | **aynı** |
| Kodlayıcı (VPU) yükü | W×H | **aynı** |
| Uygulamanın çizdiği / SF'nin birleştirdiği piksel | W×H | **2,25×** (GPU, bellek bant genişliği, ısı) |
| Ek geçiş | yok (flex) | GL küçültme: ≈ 1 kare gecikme, ek GPU |
| Görüntü | uygulamanın yerel çizimi | küçültülmüş çizim: kenarlar yumuşak, kodlayıcıya daha "kolay" |
| PC tarafı | aynı | aynı |

Neden "keskin" beklentisi tutmayabilir:
- Yazı yerel çözünürlükte, ipuçlu (hinting) çizilince zaten en net halindedir. 1,5 kat çizip bilinear küçültmek yazıyı **biraz yumuşatır**; k = 1,5 gibi kesirli oranda moiré/titreşim riski vardır. Tam 2:1 veya yüksek kaliteli filtre (Lanczos/alan ortalaması) gerekir, bu da GPU maliyetini artırır.
- Kazanç gerçek olduğu yerler: düşük bit hızında bloklaşan ince çizgiler/UI kenarları (yumuşak kenar kodlayıcıya daha az yüksek frekans yükler) ve hareketli içerikte kenar kırpışması.

## 5. Bant genişliği asıl nerede kazanılır (süper-örneklemeden daha yüksek getiri)

1. **Workspace akışını küçültmek (Yol A):** 1920×1080 → 1280×720 piksel sayısını %56 azaltır. PC penceresi zaten çoğunlukla 1920 pikselden küçük (ölçek ≈ 0,57): bugün 1080p akıtıp PC'de küçültüyoruz, yani süper-örnekleme PC'de bedava yapılıyor, ama bant genişliği ve telefon kodlayıcısı 1080p'yi taşıyor. Akışı pencerenin fiziksel boyutuna yaklaştırmak hem bant genişliğini hem VPU'yu hem ısıyı düşürür.
2. **Kodlayıcı ayarları:** `video_codec_options` (I-kare aralığı, bit hızı kipi, profil), HEVC/AV1 donanım desteği olan cihazda ekran içeriği için büyük kazanç. Şu an yalnızca `video_codec=auto` ve sabit bit hızı kullanılıyor.
3. **PC tarafı keskinlik:** canvas ölçeği kesirliyken (0,57) küçültme kalitesi tarayıcının bilinear'ına bağlı. Akış boyutunu görüntülenen fiziksel piksele (DPR dahil) tam oturtmak, süper-örneklemeden daha çok keskinlik verir ve telefona maliyeti yoktur.
4. **Kare hızı:** durağan UI'de 60 fps gereksiz; hareketsizken fps düşürmek bit hızını doğrudan düşürür (ısı raporundaki S1-S2 basamakları).

## 6. Önerilen yol (ölçerek)

Cihazda üç varyantı aynı sahne (metin ağırlıklı uygulama + kaydırma) ve aynı bit hızıyla karşılaştırmak:

| Varyant | Workspace |
|---|---|
| V0 | 1920×1080 çiz, 1920×1080 akıt (bugün) |
| V1 | 1920×1080 çiz, 1280×720 akıt (`max_size=1280`, k = 1,5) |
| V2 | 1280×720 çiz (dpi·0,67), 1280×720 akıt (kontrol: süper-örnekleme yok) |

Ölçülecek: PC'de çözülen karenin referansa (çok yüksek bit hızlı kayıt) SSIM/PSNR'ı, aynı SSIM için gereken bit hızı, kaydırmada kare düşmesi, telefon GPU frekansı ve sıcaklık artışı (dakika başına), uçtan uca gecikme.

Karar kuralı: **V1, V2'ye göre SSIM'de belirgin kazanç vermiyorsa** (özellikle metinde) tek pencere VD'ler için yama 0005 yazılmaz; kazanç V0'a göre yalnızca bant genişliğindeyse V2 yeterlidir (çizim de küçülür, ısı da düşer).

## 7. Riskler (yama 0005 yazılırsa)

- Yeniden boyutlandırma ack'i bugün "beklenen = akış boyutu = VD boyutu" varsayar (`_PendingAck`, `rotates_on_resize`); VD ≠ video olunca ack ve donma kapısı (frame gate) yeniden tanımlanmalı.
- Yoğunluk çarpanı k ile 0,7 telafisi **iki ayrı** katman olur; Workspace görevlerinde ikisi birlikte yürümeli (`android_density` bunu tek yerden yapar, k eklenirse yine orada).
- Android'in en küçük görev boyutu dp cinsinden; yoğunluk k kat yükselince px cinsinden en küçük boyut da k kat büyür (bugünkü "kendini büyütme" hatasının aynı sınıfı).
- GL geçişi flex kipteki sıfır-kopya yolu bozar: gecikme + ek GPU/ısı. Isı koruma basamakları (S0-S4) k'yı kısmayı da içermeli (S2'de k = 1).

## 8. Özet karar tablosu

| Soru | Cevap |
|---|---|
| Teknik olarak olur mu? | Evet. Workspace'te bugün ayarla (`max_size`), tek pencere VD'de yama ile. |
| Bant genişliğini düşürür mü? | Hayır. Akış küçüldüyse düşer; bu süper-örneklemeden bağımsız. |
| Kaliteyi artırır mı? | Küçük ve metinde belirsiz; ölçülmeli. |
| Bedeli ne? | Telefon GPU'su k² kat, ısı, ≈ 1 kare gecikme. |
| Şimdi ne yapılmalı? | V0/V1/V2 ölçümü; sonra karar. Yama 0005'e ölçüm olmadan başlanmamalı. |
