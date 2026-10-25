> **Language note:** Turkish (translation is on the [roadmap](../ROADMAP.md)). How an app crosses between a PC window (virtual display) and the phone's own screen, why it is built that way, and the root causes found on the way.

# Telefona aktarma ve geri alma (handoff / reclaim)

Bu sayfa şu soruları yanıtlar: bir uygulama PC penceresinden telefonun kendi ekranına (Display 0) geçerken ne olur, uygulama **neden** bazen yeniden kurulur ya da durur, kenar "geri" hareketi neden bir ara çalışmıyordu, siyah ekran nereden geliyordu. Ölçümlerin ve eski tartışmaların ayrıntısı [../research/](../research/) altındadır; burada yalnızca **bugün geçerli** olan yapı ve kök nedenler var.

Kod: `backend/app/windows/handoff_manager.py` (akış), `density_reconciler.py` (yoğunluk), `playback_continuity.py` (medya), `cdp_refresher.py` (tarayıcı sayfaları — [BROWSER_PAGE_REFRESH.md](BROWSER_PAGE_REFRESH.md)).

## 1. İlke

Android'de **yapılandırma farkı yoksa yeniden kurulma da yoktur.** Samsung DeX de dahil hiçbir sistemde canlı bir görevi "sihirle" taşıyan bir mekanizma yoktur; sorunsuz görünen taşıma üç şeyin toplamıdır: (1) süreç ölmez, (2) yapılandırma değişimi uygulamaya yerinde iletilir (`configChanges`), (3) uygulama buna hazır yazılmıştır. Biz uygulamayı değiştiremeyiz; bu yüzden hedef "hiç yeniden kurulma olmasın" değil, **"en hafif geçerli kademede kal, süreci asla gereksiz öldürme"** ([araştırma](../research/VD_RESIZE_AND_APP_CONTINUITY.md)).

Mühendislik kuralları (bu alandaki her değişiklik için): kök nedeni cihaz günlüğüyle kanıtla, bandaj (bekleme, rastgele yeniden dene) ekleme; **paket adı listesi kullanma** — davranış ölçülür (soket sahibi, medya oturumu, süreç kimliği); aynı cihaza paralel istekler tek kilitten geçer.

## 2. PC → telefon akışı

`HandoffManager._execute_to_phone`:

1. **Hazırlık.** Telefon uyandırılır; uygulamanın çalışma profili okunur (DevTools soketi var mı); tarayıcıysa kaydırma durumu yakalanır.
2. **Ön-iniş (pre-landing).** Görev hâlâ sanal ekrandayken (PC penceresinin perdesi arkasında) VD, telefonun **boyutuna ve yoğunluğuna** tek atomik `OPENDEX_RESIZE` ile çekilir. Taşımanın kendisi böylece yapılandırma-nötr olur. Ardından `DensityReconciler.settle` uygulamanın bu değişime uyum sağlayıp sağlamadığını **olay günlüğünden** doğrular (§3). Sabit bir bekleme (`HANDOFF_PRELANDING_STABILIZE_S`, 0,8 sn) yeni süreçlerin ilk karesi için üst sınırdır.
3. **Taşıma.** `WCT` (WindowContainerTransaction) ile tek adımda: reparent + tam ekran + sınır + yoğunluk sıfırlama + öne alma. Serbest kip bu adımda verilmez (HyperOS yalnız kendi Shell geçişinden tanır).
4. **HyperOS "Home → uygulama" geçişi** (§4) — kenar geri hareketinin açık kalması için.
5. **Kademe seçimi**, uygulamanın türüne göre:
   * DevTools soketi olan tarayıcı → **süreç öldürülmez**; sekme izleyicisi + canlı dürtme ([BROWSER_PAGE_REFRESH.md](BROWSER_PAGE_REFRESH.md)).
   * Ön-inişi yapılmış yerel/hibrit uygulama → **dokunulmaz** ("DURUM KORUNDU").
   * Ön-iniş yapılmadıysa ve aktarımı **biz** başlattıysak → görev etkinliği yeniden başlatılabilir (`restart_task_activity`, §3). Aktarımı Android'in kendisi yaptıysa (kullanıcı telefonda uygulamaya dokundu, `display0`/`watchdog`) **hiç yeniden başlatma yapılmaz**; Android etkinliği zaten kurmuştur.
6. Pencereleme kipi doğrulanır (tam ekran | serbest); gerekirse `schedule_settle` ile arka planda yoğunluk kanıtı tamamlanır.

**Geri alma (reclaim)** aynı mantığın tersidir: görev PC ekranına taşınmadan önce VD pencerenin boyutuna döner (kullanıcı telefondayken pencereyi yeniden boyutlandırdıysa onun istediği boyut kazanır), sonra taşınır, sonra tarayıcı izleyicisi masaüstü kipine alınır.

## 3. Süreç ölümü ve yoğunluk (`DensityReconciler`)

**Sorun.** Yoğunluk değişimi uygulamaya yapılandırma değişimi olarak gider. Chrome `density`'yi kendi karşılar ve etkinliğini kendisi yeniden kurar; YouTube karşılamaz, süreç doğduğu yoğunlukta hesapladığı piksel ölçülerini tutar (alt çubuk yanlış boyutta kalır). `configChanges & CONFIG_DENSITY` ikisi için de doğrudur, yani manifestten ayırt edilemez. Bu yüzden karar **paket adına değil, kanıta** bağlıdır.

**Kademeler.** Her yoğunluk değiştiren dizi `snapshot()` / `settle()` ile sarılır (süreç kimliği = pid + `/proc` başlangıç zamanı):

* süreç yok → dokunma (sonraki başlatma zaten doğru yoğunlukta doğar);
* kimlik değişmiş → zaten taze;
* **uygulama yeniden kurulduysa** (aynı etkinlik jetonu `destroy → create`, ya da Android `wm_relaunch*` yazdıysa) → `adapted`, hiçbir şey yapılmaz;
* aynı süreç değişimi yaşadıysa → durum korumalı **süreç yeniden başlatma** (`restart_task_activity` = SizeCompat "Restart" = süreci öldürür; Android 12+, Android 11'de desteklenmediği bildirilir) ve kimliğin gerçekten değiştiği doğrulanır.

Etkinlik `density` bildirmiyorsa Android kendisi yeniden kurar, süreç yenilenmez. İsteğe bağlı sertleştirme (`DENSITY_SELF_RECREATE_ESCALATE`): kendi etkinliğini yeniden kuran ama süreç düzeyinde durum taşıyan uygulama (Chrome sayfa ölçeğini ×1,2 tutar) için sert kademe.

**Medya asla kesilmez.** Medya oturumu olan (oynuyor *ya da duraklatılmış*) uygulamanın süreci otomatik yeniden başlatılmaz (`kept_playing`): yerleşim bayat kalabilir ("Uygulamayı yeniden başlat" ile yenilenir), kaybolan video/müzik geri gelmez. `PLAYBACK_GUARD_EXEMPT` boştur.

**Eski hata (kapandı).** `restart_task_activity` bir zamanlar her aktarımda koşulsuz çağrılıyordu; docstring'i "süreci öldürmeden" diyordu ama **öldürüyordu** (günlükte her aktarımdan sonra pid değişiyordu). Artık yalnız yukarıdaki koşullarda ve kanıt zincirine bağlı çalışır.

## 4. Kök neden: aktarımdan sonra kenar "geri" hareketi çalışmıyor (HyperOS)

**Belirti.** Chrome telefona geçtikten sonra ekranın kenarından geri kaydırmak sistem "geri"sini değil, Chrome'un kendi yatay sayfa sürüklemesini tetikliyordu. Ana ekrana gidip uygulamayı yeniden açmak düzeltiyordu.

**Kök neden.** Telefonun kenar geri hareketini HyperOS Home'un (`com.miui.home` / `com.mi.android.globallauncher`) `GestureStubLeft/Right` pencereleri işler. Home bu stub'ları, yalnızca **bir uygulama Display 0'da ön plana geldiğinde** (`RecentsImpl onForegroundChanged → GestureStubView setBackTouchable false→true`) dokunuşa açar. Uygulama sanal ekranda zaten `RESUMED` idi; WCT ile Display 0'a taşıma `RESUMED → RESUMED` bir yeniden-parentleme olduğundan ön-plan olayı üretilmedi, stub'lar `view_touch_disabled` kaldı ve her kenar dokunuşu uygulamaya yönlendirildi. (Home'un kapalı kaynağı okunamadığı için "neden olay yok" kısmı çıkarımdır; stub durumu ve olayın yokluğu günlükle kanıtlıdır.)

**Elenen hipotezler (kanıtla):** InputDispatcher/odaklı ekranın sanal ekranda kalması (`FocusedDisplayId=0`, `mTopFocusedDisplayId=0`), klavye/IME katmanı, kenar jest pencerelerinin yok/yanlış yerde olması, Chrome'un geri geri-çağrımının kayıtsız olması.

**Çözüm.** `android_shell.unlock_display0_gesture_navigation`: Display 0'da temiz bir **Home → hedef uygulama** ön-plan geçişi (`am start --display 0 … HOME`, ardından `-p <paket> -f 0x10000000`). Bu ATMS'ye gerçek bir ön-plan olayı ürettirir, jest ~200 ms içinde geri gelir; süreç, DOM ya da kaydırma etkilenmez. Yalnızca HyperOS/MIUI'de uygulanır; başarısız olursa düz öne getirmeye düşülür.

**Kaldırılan zararlı "çözümler"** (hata düzeltmiyor, yan etki üretiyordu, aktarıma 1–2 sn ekliyordu): ekran ortasına `input motionevent DOWN/CANCEL` enjeksiyonu (gerçek dokunuş: Chrome'a DOWN+CANCEL, çoklu parmak yöneticisi iptali, kenar çubuğu tepkisi), `CLOSE_SYSTEM_DIALOGS` yayını, yinelenen `am start … LAUNCHER`, CDP sonrası ek odak çağrıları.

**Sınır.** Kanıt HyperOS Home içindir. Pixel/Samsung'ta kenar jesti SystemUI'nin `EdgeBackGestureHandler`'ındadır; orada aynı sorun ölçülmedi.

## 5. Siyah ekran / ölü süreç

Android'in kendi taşıdığı aktarım (kullanıcı YouTube'a telefonda dokundu) sırasında `restart_task_activity` görev **henüz görünür değilken** koşarsa süreç öldürülür ve hiçbir şey onu yeniden başlatmaz: telefonda `app=null`, `visibleRequested=false` ile siyah ekran. Önlemler: Android'in kendi taşıdığı aktarımlarda `_reinflate` hiç çağrılmaz (§2-5); `HandoffManager._ensure_relaunched` (yeniden başlatmadan sonra süreç kimliğini ≤3 sn izler, doğmadıysa `bring_to_front`) ve `DensityReconciler._relaunch_if_dead` (görevin ekranında `am start`) ölü süreci geri getirir.

## 6. Medya sürekliliği (`PlaybackContinuity`)

**Belirti.** YouTube ekranlar arası taşınınca durur; ayrıca tam sayfa izleme sayfası mini oynatıcıya iner.

**Neden.** Süreç ölmez ama Android etkinliği **yeniden kurar** (`wm_relaunch_resume_activity`, maske `0x2804008`: `touchscreen` ve `colorMode` bitleri YouTube'un `configChanges`'inde yok; Chrome'un `0x40005ffb`'si karşılar, o yüzden kesintisizdir). Sanal ve fiziksel ekran bu değerlerde farklı olduğundan her ekranlar arası taşımada relaunch kaçınılmazdır. Önce duraklatmak ya da PiP'siz park etmek yeniden kurmayı önlemez (PiP yalnız siyah/yarım çerçeve bozukluğuna katkı verir).

**Ne yapılır.** Taşımadan önce oturum OYNUYORSA anlık görüntü (konum, parça adı, uygulama bildirdiyse tam sayfa adresi); taşıma bitince oturum durmuşsa `play` + durma konumuna `seek` (~0,5 sn kesinti). Uygulama kendi oynatıcısının tam sayfa olduğunu bildirirse (`AssistContent`: `@isPlayerVisible`) o sayfa derin bağlantıyla yeniden açılır. Kullanıcının kendi duraklattığına ve kesintisiz oynayana dokunulmaz.

**Ses rotası sökülürken (2026-10-24 bulgusu).** "İkisi/DeX" rotasında uygulamanın sesi telefonda yakalanır (`AudioPolicy`); telefona dönerken yakalama kalkınca uygulamanın `AudioTrack`'i geçersiz olur ve uygulama yenisini kurar. Şarkı geçişinin ortasındaki bir oynatıcı bunda kendini durdurabilir ve medya oturumu Android'in **etkin oturum listesinden düşer**; eski kod 8 sn "oturum" bekleyip vazgeçiyordu. Çözüm iki katmanlı: (1) `AppAudioRouter` yakalamayı sökmeden önce `PlaybackContinuity.wait_stable` ile oynatıcının kararlı noktasını bekler (parça ≥4 sn oynamış, bitimine ≥3 sn, en çok 4 sn); (2) oturum ≥1,5 sn kayıpsa, Android medya tuşlarını hâlâ o pakete yönlendiriyorsa (`dumpsys media_session`) `KEYCODE_MEDIA_PLAY` basılır ve aynı parçada kaybedilen saniyeye sarılır (parça değişmişse sarılmaz). **Cihazda doğrulanmadı**: PLAY tuşunun tamamen durmuş oynatıcıyı canlandırıp canlandırmadığı bilinmiyor.

## 7. "Pıt pıt": resize'da Display 0'a sızan geçiş karesi

VD yeniden boyutlandırılırken WM/Shell'in geçiş animasyonu VD içeriğinin anlık görüntüsünü telefonun fiziksel ekranına (sol üst, ~100 ms) sızdırıyordu. `transition_animation_scale=0` ile 0/8, varsayılanda 3–5/8 (cihazda kontrollü deney). Çözüm: `transition_gate.py` yalnız resize'ın etrafında bu ayarı 0'a çeker ve kullanıcının değerini geri yükler (asıl değer cihazdaki işaret dosyasında durur; backend ölürse sonraki `hold()` geri yükler). Kapatma: `OPENDEX_RESIZE_SUPPRESS_TRANSITION=false`. Ayrıntı ve ölçümler: [VD_RESIZE_AND_APP_CONTINUITY.md](../research/VD_RESIZE_AND_APP_CONTINUITY.md).

## 8. Açık noktalar

* Sabit 0,8 sn ön-iniş beklemesi olay tabanlı (`wm_on_resume_called`) yapılabilir; cihazda ölçmeden değer seçilmemeli.
* "Süreklilik kipi" (VD'yi telefonun boyutunda tutan pencere türü) aktarımı saf reparent yapar ama PC'de masaüstü düzeni vermez; ürün kararı bekliyor.
* Geçiş karesi kapısı (çözücüde "hazır olana kadar eski kareyi tut"): [TRANSITION_FRAME_GATE.md](../research/TRANSITION_FRAME_GATE.md).
* Tek telefonda doğrulandı (POCO X7 Pro, HyperOS, Android 16): [DEVICE_COMPATIBILITY.md](../DEVICE_COMPATIBILITY.md).
