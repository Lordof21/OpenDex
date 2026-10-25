> **Language note:** Turkish (translation is on the [roadmap](../ROADMAP.md)). How OpenDeX keeps a Chromium browser's pages right (scale, mobile/desktop site, scroll, video) when its app crosses between a PC window and the phone.

# Tarayıcı sayfası yenileme (CDP) — Chrome handoff / reclaim

Kod: `backend/app/windows/cdp_refresher.py`. Testler: `backend/tests/test_cdp_reload_decision.py`, `test_cdp_layout_integration.py`, `test_handoff_manager.py`. Genel akış: [HANDOFF.md](HANDOFF.md).

## 1. Sorun

Chromium tabanlı bir tarayıcı (Chrome, Brave, Edge, Samsung Internet) yapılandırmayı **süreç başına** değerlendirir:

* Geniş (tablet/DeX, ≥600 dp) pencerede sayfa ölçeğine **×1,2** erişilebilirlik yakınlaştırması ve masaüstü sitesi uygular. Telefon yapılandırmasına dönünce bunu **süreç içinde geri almaz**: aynı ekranda `innerWidth 317 / dpr 3,848` kalır (doğrusu 380 / 3,206). Ölçüm: oran 3,848/3,206 = 1,2000.
* Siteler düzenlerini **yükleme anında** seçer (UA, Client Hints, `viewport` meta, JS'in bir kez okuduğu `innerWidth`, önbellekten gelen masaüstü HTML'i). Yoğunluk değişimi yeniden düzen garantisi vermez.
* Süreci öldürmek bunu dolaylı çözer ama tüm sekmeleri ve süreç durumunu götürür; **kabul edilmez** (sayfa kaybı, video, form).

## 2. Kurallar

1. **Doğru görüntü her şeyden önce:** belirsizse sayfa yenilenir.
2. Karar **site adına değil ölçüme** bağlıdır; site/paket listesi yoktur. Tarayıcı kimliği davranıştan bulunur: DevTools soketi (`*_devtools_remote`) + `/json/version` içindeki `Android-Package`; başka uygulamanın soketi "sahiplenilmiyor" diye izole edilir (Samsung Internet'in `Terrace_devtools_remote`'u dahil).
3. **Durum kaybı yok** (kaydırma, video saniyesi); kaydırmanın **tek yazarı** vardır. Kullanıcı sayfaya dokunursa geri yükleme durur.
4. Yıkıcı olmayan: HTTP önbelleği temizlenmez (görseller yeniden indirilmez); eski "önbelleği sil + `Page.reload(ignoreCache)`" yaklaşımı kaldırıldı.
5. Eşzamanlılık: her cihaz için `asyncio.Lock`; her CDP oturumu `async with open_cdp_session` (geçici port `adb forward tcp:0`, koşulsuz temizlik); statik port yok.
6. **Ön sekme `pages[0]` değildir.** `/json/list` açılış sırasıyla gelir; ön sekme `document.visibilityState === 'visible'` ile bulunur (donmuş arka plan sekmeleri yanıt vermez, paralel ve süre sınırlı yoklanır; tarayıcı görev taşımasından biraz geç görünür yaptığı için ikinci yoklama vardır).

## 3. Mekanizmalar

**Sekme izleyicisi (`BrowserTabAutoAttachWatcher`).** Tarayıcı düzeyinde kalıcı bir CDP oturumu; açık ve sonradan açılan her sekmeyi bulunduğu yerin kipinde tutar (`mobile` telefonda, `desktop` bir pencerede; geçiş eşiği 640/560 dp, histerezisli).
* Her sekmeye kipin UA'sı (telefon: tarayıcının kendi mobil UA'sı; masaüstü: Chrome'un "Desktop site" UA'sı) ve **cihaz ölçeği** (`Emulation.setDeviceMetricsOverride`, `width:0,height:0`) verilir; pencerenin kendi gerçek ölçeği (`dpi/160`) uygulanır, ×1,2 çarpanı öğrenilip düzeltilir.
* Yeni sekme açılışta duraklatılır (`waitForDebuggerOnStart`), UA ve ölçek verilir, sonra devam ettirilir: ilk baytından doğru siteyle yüklenir.
* Yanlış siteyle yüklenmiş **ön** sekme için karar (`decide`): kesin sebepler (`m.`/`mobile.`/`touch.` host, adreste `app=desktop`) anında yeniden yükler; diğerlerinde **ölçüm**: sayfa kendi adresini UA değişmeden önce (A) ve sonra (B) çeker, yapı/metin/kaynak listesi/boyut/viewport karşılaştırılır; fark yoksa yeniden yükleme **atlanır** (responsive site). Yanıt gelmezse (2 sn) yeniden yükle. Eşikler 25 gerçek sitede kalibre edildi (etiket ≥%1,5, görünür metin ≥%3, betik/stil listesi ≥%5, boyut ≥%15 → sürüm farkı; github, bbc, cnn, hn, reddit, mdn "aynı sayfa", trendyol, hepsiburada, twitch, linkedin, youtube, wikipedia belirgin sürümlü). Geri alma: `_SKIP_REDUNDANT_RELOAD = False`.
* Aynı hedef iki oturumla (otomatik bağlanma + hedef listesi) işlenmez (`targetId` ile tekilleştirme) — aksi halde iki yeniden yükleme ve iki geri yükleme birbirine girerdi.

**Kaydırma modeli.** `window.scrollY` yetmez: claude.ai gibi sayfalar iç `div`'i kaydırır (`window.scrollY=0`; düz yeniden yüklemede konum %30 → %100 olmuştu). Ortak JS pencere + en büyük 3 iç kaydırıcının **oran/yol/ölçüsünü** yakalar ve yüklemeden sonra uygular.

**Geri yükleme (`_restore_script`).** Video varsa saniyesi ve oynatma durumu (YouTube yüklenince otomatik başlatır → ~4 sn tutulur, 12 sn izlenir, geri sıçrarsa yeniden konumlanır), kaydırma. Adreste `t=`/`start=`/`time_continue=` varsa yeniden yüklemeden **önce** yakalanan saniyeye yazılır (`_retime_url`); aksi halde YouTube oynatıcı yüklenince eski saniyeye atlıyordu. İşaret: `window.__odxRestored`.

**Dürtme (`refresh_browser_layout_inplace`).** 4 aşamalı (0/80/250/600 ms) yerleşim zinciri: `resize` + `orientationchange`, `overflow-anchor: none`, kaydırmayı (0,0) ya da tam alt-piksel konuma kilitleme. Yeni yüklenmiş sayfada (`performance.now() < 8000`) kaydırmaya dokunmaz ama `resize` yine gider (Android boyutu birkaç yüz ms geç oturttuğu için sayfa eski genişlikte kalıp "sola yaslı, sağda boşluk" oluyordu).

**Kullanıcının "Sayfayı yenile"si** (`soft_reload_active_tab`): yakala → yeniden yükle → yüklenince geri yükle; normal yenileme (HTTP önbelleği geçerli).

## 4. Uygulamanın kendisi sayfayı yeniden yüklerse (Samsung Internet, 2026-10-24)

Samsung Internet yoğunluk/boyut değişiminde **etkinliğini yeniden kurar ve her sayfayı sıfırdan yükler** (`SBrowserMainActivity` yeniden kurulur; Chrome bunu yerinde karşılar). Ölçüm: 4000 px kaydırılmış Vikipedi aktarımdan sonra en başta; günlükte bizim "site kipi" satırı yok. Dürtme "taze sayfayı kendi geri yüklemesine bırakıyordu" ama o geri yükleme hiç koşmuyordu. Çözüm: aktarımdan **önce** okunan durum (kaydırma, kaplar, video saniyesi + oynuyor mu, adres) saklanır ve

* sayfa yeniden yüklendi ve henüz kimse geri yüklemediyse (`__odxRestored` yok, taze) dürtme bunu geri koyar;
* izleyici, uygulamanın yeniden kurduğu sekmeyi (yeni hedef, eski adres, ilk 25 sn) açılırken yakalar ve **yüklenince** geri koyar (DeX'e alırken sayfa o an listede olmadığı için dürtme "aktif sayfa bulunamadı" diyordu);
* izleyicinin kendi yeniden yüklemesi, sayfanın "taze sıfır" durumunu değil aktarım öncesi durumu kullanır; oynayan videonun saniyesi geçen süre kadar ilerletilir.

Sınır: Samsung'un yeniden yüklemesi engellenemez; sayfa kısa süre baştan yüklenip sonra kaldığı yere atlar. m.youtube.com Samsung'da otomatik oynatmayı engelliyorsa (`readyState 0`) video öğesi olmadığı için saniye geri konamaz; gerekirse adrese `t=` eklemek ayrı bir iştir. Cihazda yeniden doğrulanmalı.

## 5. Ölçülen gerçekler (Chrome 155, cihazda)

| Bulgu | Sonuç |
|---|---|
| Sayfa içi `fetch()` emüle UA'yı ve `Sec-CH-UA-*`'yı taşır | A/B yoklaması sayfa içinden yapılabilir |
| `Vary: User-Agent` tek başına sebep değil (claude.ai: gövde farkı %0,22, bot betiği) | **yapısal fark** ölçülür |
| `navigator.userAgentData.mobile` canlı değişir; yükleme-anı kararları yeniden çalışmaz | şüphede yeniden yükle |
| UA değişince `Page.reload` sunucuya `max-age=0` ile gider; aynı adrese `Page.navigate` eski sürümü önbellekten verir | aynı adreste `reload`, farklı (temizlenmiş) adreste `navigate` |
| Pencerelerde sayfa %20 büyüktü (`iw=1600 dpr=1,2`, doğrusu 1920 / 1,0) | izleyici pencerenin gerçek ölçeğini override eder; pencere değişince `set_scale` |
| Tüm boyut geçişlerinde (DeX 1920×1080@160, tablet 1280×800@160, telefon 1220×2712@513) kaydırma 0,40'ta korundu, belge yeniden yüklenmedi | — |

Kapsam dışı: `userTypedURL` ile asıl adrese dönüş, form kirli denetimi, POST sayfaları.
