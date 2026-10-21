# CDP yenileme (Chrome handoff / reclaim) — plan ve görevler

Kaynak: 2026-10-21 araştırma + telefonda ölçüm (Chrome 155, claude.ai). Kod: `backend/app/windows/cdp_refresher.py`.

## Ölçülen gerçekler (cihazda doğrulandı)

| # | Bulgu | Sonuç |
|---|---|---|
| E5 | claude.ai kaydırması `window`'da değil, iç `div`'de (`window.scrollY = 0`). Düz `Page.reload` sonrası konum %30 → %100 (en alt). Kap oranını yakalayıp yüklemeden sonra uygulamak %30,0'a tam döndü. | Kaydırma koruması **kap bazlı** olmalı (`window.scrollY` yetmez). |
| E1 | Sayfa içi `fetch()` emüle UA'yı ve `Sec-CH-UA-Mobile/Platform`'u taşıyor. | Sayfa içinden A/B yoklaması mümkün. |
| E2 | claude.ai `Vary: User-Agent` gönderiyor ama mobil/masaüstü gövde farkı %0,22 (bot betiği); gürültü %0,02-0,09. | `Vary` tek başına sebep değil; **yapısal fark** ölçülmeli. |
| E3 | `navigator.userAgentData.mobile` canlı değişiyor; sayfanın yükleme anındaki kararları yeniden çalışmıyor. | Yükleme-anı kararı veren sitelerde reload gerekebilir → şüphede reload. |
| E4 | UA değişince `Page.reload` sunucuya `max-age=0` ile gidiyor (`Vary` olmasa da). Aynı adrese `Page.navigate` ise eski sürümü önbellekten veriyor. | Aynı adreste `reload`, farklı (temizlenmiş) adreste `navigate`. |

## Kurallar

1. Doğru görüntü her şeyden önce: **belirsizse bugünkü gibi reload**.
2. Karar site adına değil ölçüme bağlı (site listesi yok).
3. Durum kaybı (kaydırma, video saniyesi) hiç yaşanmamalı; kaydırmanın **tek yazarı** vardır.
4. Kullanıcı sayfada kendisi dokunursa geri yükleme durur.

## Durum (2026-10-21): T1-T8 UYGULANDI

Kod: `backend/app/windows/cdp_refresher.py` (yalnız bu dosya) · testler: `backend/tests/test_cdp_reload_decision.py` (27 yeni) + mevcut CDP/handoff testleri (toplam 132 geçti).

Cihazda doğrulama (gerçek `BrowserTabAutoAttachWatcher`, Chrome 155):

| Senaryo | Sonuç |
|---|---|
| claude.ai, pencere kipi, ölçüm açık | "aynı sayfa" → **reload yok**, kaydırma %81,5 aynen, 0,3 sn |
| claude.ai, ölçüm kapalı (zorla reload) | sayfa yeniden yüklendi, kaydırma **%81,5'e geri geldi** (eskiden %100'e iniyordu) |
| YouTube 3,5 dk video, telefon → pencere → telefon | `m.` ↔ `www` doğru, video saniyesi kesintisiz (62 → 67,5 → 74,4), oynuyor kaldı, kaydırma 260 aynen, `app=desktop` temizlendi |
| Spy oturumu | iki `fetch` gerçekten farklı kimlikle gitti (`?1 Android` / `?0 Linux`) |

Not: ilk ölçümde görülen %0,7 gövde farkı kimlikten değil, sunucunun ikinci istekten sonra bot betiği eklemesindendi (deney sırası); karşılaştırma yapı + metin üzerinden yapılır.

**Kullanıcı için kalan:** gerçek DeX penceresinde bir Chrome handoff/reclaim gözle denenmeli (özellikle uzun sayfa + video). Geri alma: `_SKIP_REDUNDANT_RELOAD = False`.

## Görevler

- [x] **T1 Kap bazlı kaydırma modeli.** Ortak JS: pencere + en büyük 3 iç kaydırıcının oranı/yolu/ölçüleri. `capture_browser_scroll_state` (`containers`), izleyici durumu (`c`), `_restore_script`, `_build_nudge_script` bunu kullanır. Eski şema/anahtarlar korunur.
- [x] **T2 Geri yükleme tek yazar ve dayanıklı.** Video yoksa 14 sn beklemez; kaydırıcı bulunana ve içerik oturana kadar dener (≤6 sn); kullanıcı dokunursa durur.
- [x] **T3 Dürtme reload'a duyarlı.** Sayfa yeni yüklendiyse (`performance.now() < 8000`) tek `resize`, kaydırmaya dokunmaz; yoksa bugünkü 4 aşamalı zincir + kap kilidi.
- [x] **T4 Ön sekme yarışı.** Gizli görünen sekmede sayfanın görünürlüğü beklemesiyle ikinci sorgu (≤350 ms); ön sekme bulununca bekleyenler bırakılır. `_find_active_page_target` ilk turda görünür bulunamazsa kısa aralıkla yeniden yoklar.
- [x] **T5 Gereksiz reload'u atla (ölçüme dayalı).** Ön ve UA'sı yanlış sekmede: kesin sebepler (m./mobile./touch. host, `app=desktop`) anında reload; diğerlerinde yoklama: UA değişmeden önce A parmak izi (durum yanıtında), UA'dan sonra B + yerleşim ölçümü. Yapısal fark / yönlendirme / viewport farkı / yatay taşma / ölçüm yok → reload; aksi halde atla. 2,5 sn içinde yanıt yoksa reload.
- [x] **T6 Kullanıcının "Sayfayı yenile"si kaydırmayı korur** (`soft_reload_active_tab`: yakala → reload → yüklenince geri yükle).
- [x] **T7 Karar günlüğü.** Her sekme için tek satır: `karar=reload|atla`, `sebep`, fark ölçüleri.
- [x] **T8 Testler.** Saf fonksiyonlar (`_variants_differ`, kap betikleri, nudge fresh dalı), izleyici akışları (yoklama atla/reload/zaman aşımı, ikinci sorgu), soft reload kaydırma. Mevcut testler bozulmadan geçmeli (durum yanıtı `id 4`, nudge sabit metinleri, `refresh` çağrı imzası).

## Kapsam dışı

`userTypedURL` ile asıl adrese dönüş (YouTube `app=desktop` zaten ele alınıyor), form kirli kontrolü, POST sayfaları.

## Geri alma

`_SKIP_REDUNDANT_RELOAD = False` yoklamayı kapatır (her yanlış-site sekmesi eskisi gibi reload olur).

## Ek düzeltmeler (aynı gün, backend yeniden başlatıldıktan sonra gelen geri bildirim)

- **DeX'te telefon boyutunda sola yaslı / sağda boşluk ve YouTube oynatıcı şeridi:** yeni yüklenmiş sayfada dürtme tek `resize` gönderiyordu; Android boyut geçişini birkaç yüz ms geç oturttuğu için sayfa eski genişlikte kalıyordu. Artık taze sayfada da 4 aşamanın hepsinde `resize` + `orientationchange` gidiyor, yalnız kaydırmaya dokunulmuyor.
- **Video "ilk başta doğru, sonra 21-22. saniyeye atlıyor":** YouTube, adresindeki `t=21s`'i oynatıcı yüklenince (bizim geri yüklemeden sonra) yeniden uyguluyordu. Çözüm: reload'dan önce adresteki `t=`/`start=`/`time_continue=` yakalanan saniyeye yazılıyor (`_retime_url`), geri yükleme videoyu 12 sn izleyip geri sıçrarsa yeniden konumlandırıyor. Cihazda doğrulandı (101 → 116 → 131, sıçrama yok).
- Video geri yüklemesi artık yalnızca **önceden video yoksa** 3 sn'de vazgeçiyor.
- Açık soru (kullanıcı fikri): display 0 ⇄ VD yerine tablet/mobil/DeX boyutlu VD'ler arasında geçiş. Chrome'un tablet kipi süreç başına olduğundan tek başına yetmeyebilir; cihaz deneyi gerekir (telefon boyutlu VD'ye taşıyıp `navigator.userAgentData.mobile` okumak).

## Boyut matrisi (gerçek backend, 2026-10-21 18:33) ve çıkan düzeltmeler

Ölçüm düzeneği: backend API (`/windows/open|resize|handoff|reclaim`) + CDP ile test sekmesi; DeX 1920×1080@160, tablet 1280×800@160, telefon 1220×2712@513 boyutları arasında geçiş, her başlangıç boyutundan telefona aktarma ve geri alma.

| Bulgu | Ölçüm | Düzeltme |
|---|---|---|
| Pencerelerde sayfa %20 büyük | VD@160'ta `iw=1600 dpr=1.2` (olması gereken 1920 / 1.0); tablet `1067` (1280); telefon boyutu `317 / 3.848` (380 / 3.206) | Pencere kipi izleyicisi artık pencerenin gerçek ölçeğini (`dpi/160`) override ediyor; pencere boyutu/yoğunluğu değişince `update_window_scale` ile güncelleniyor |
| Telefon kipinde ölçek | aktarma sonrası `iw=380 dpr=3.206` doğru | değişiklik yok |
| Küçük sürüm farkları kaçabilir | 1 kelimelik fark "aynı sayfa" | 25 gerçek sitede kalibre edildi: etiket ≥ %1,5, görünür metin ≥ %3, yüklenen betik/stil listesi ≥ %5, boyut ≥ %15 → sürüm farkı; script/style/yorum görünür metinden çıkarıldı |
| Kaydırma | tüm geçişlerde 0,40 korundu, belge hiç yeniden yüklenmedi | — |

Kalibrasyon özeti: github, bbc, cnn, hn, reddit, mdn iki kimlikte birebir aynı sayfa (reload atlamak doğru); trendyol, hepsiburada, twitch, linkedin, youtube, wikipedia belirgin sürümlü.
