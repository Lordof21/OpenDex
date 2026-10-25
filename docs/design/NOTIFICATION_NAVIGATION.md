> **Language note:** Turkish (translation is on the [roadmap](../ROADMAP.md)). How tapping a notification in OpenDeX opens the exact screen the notification points to.

# Bildirime tıklayınca doğru sayfayı açmak (Tier 0)

## Sorun

Masaüstündeki bildirim kartına tıklayınca Instagram, X, WhatsApp, Gmail gibi uygulamaların **bildirimin işaret ettiği içeriğe** (DM, gönderi, sohbet) açılması gerekir; eskiden uygulama ana akışa düşüyordu. Eski yol kabuk tahminiydi: `dumpsys activity intents` çıktısını regex'le ayrıştırmak, bildirim metninde "gönderdi / beğen" gibi kelimelerle sayfayı tahmin etmek, `am start --display X` — kapalı (`exported=false`) iç sayfalarda `SecurityException`, zaman aşımında "sıfırdan başlat" ve ana akışa düşüş. Hem kırılgan hem pahalıydı (`system_server` üzerinde 100–300 ms'lik `dumpsys`, tıklama başına 4–6 süreç).

## Çözüm: daemon'dan `PendingIntent` ateşlemek

```
bildirim kartı tıklandı
  → OpenDexDaemon (opendex-tools.jar)
      · RAM'deki canlı StatusBarNotification'ın orijinal contentIntent'i (NotificationEvents.findNotification)
      · ActivityOptions.setLaunchDisplayId(hedef sanal ekran)
        + setPendingIntentBackgroundActivityStartMode (Android 14/15 BAL izni)
  → contentIntent.send(...)  → uygulama KENDİ kimliğiyle, kapalı iç sayfayı hedef sanal ekranda açar
```

Uygulamanın kendi derlenmiş niyeti çalıştığı için paket adı, metin ya da rota tablosu gerekmez ve tıklama başına tek IPC çağrısı yeter.

**Android 16 tuzağı:** daemon çıplak bir shell sürecidir; `PendingIntent`'i **`ALLOW_ALWAYS`** arka plan başlatma kipiyle göndermelidir. Düz `ALLOWED` kipinde platform "Background activity launch blocked" yazar ve hiçbir şey başlamaz.

| Katman | Dosya |
|---|---|
| Java | `backend/java/src/com/opendex/tools/NotificationEvents.java` (`findNotification`), `NotificationInvoker.java` (`launchToDisplay`, `open`/`launch` komutları) |
| Python | `backend/app/device/notification_invoker.py` (`launch`), `device_daemon_client.py` (`notif_invoke`), `deep_navigator.py` (Tier 0) |

## Durum ve kararlar

* Tier 0 **tek yoldur**; eski `am start` merdiveni bilerek kaldırıldı: gerçek yolun başarısızlığı geri düşüşle **gizlenmesin**, nedeniyle günlüğe yazılıp `False` dönsün (uygulamanın ana akışına inen bir yedek hatayı örter). Tek istisna: bildirim telefonda artık yoksa uygulama normal açılır. OEM Uygulama Kilidi (HyperOS/Knox) pencere açarken kullanılan bekleyiciye devredilir ve kilit açılınca `PendingIntent` bir kez daha ateşlenir. `deep_navigator.py` 633 satırdan ~336'ya indi; uygulamaya özel rota işlevleri (`_route_instagram`, `_route_twitter`, `_route_sms`, `_route_whatsapp` …), `dumpsys activity intents` sorguları ve `intent_utils.py` gitti.
* Başarılı olunca bildirim telefonun kendi bildirim gölgesinden de temizlenir (`notification_invoker.clear`), telefonda dokunulmuş gibi.
* `launch` **canlı daemon'un bildirim dinleyicisini** gerektirir (tek seferlik CLI'nin dinleyicisi yoktur): daemon bağlı değilse tahmin etmek yerine `{"ok": false, "error": "daemon_not_connected"}` döner. Tek seferlik CLI (`app_process … NotificationInvoker`) yalnızca daemon yokken `clear` gibi dinleyicisiz işler içindir.
* Yanıtta `kind` (`activity | broadcast | service`) bildirimin niyet türünü söyler; yayın/servis niyeti etkinliğini telefonda kendisi başlatır.
* Telefon tarafı yeniden derlenmeden etkili olmaz (`python backend/java/build.py`; backend açılışta jar karmasını karşılaştırıp telefondakini günceller).
* Cihazda doğrulama: bir Instagram/X bildirimine DeX'ten tıklayıp ana akışa düşmeden ilgili içeriğin sanal ekranda açıldığını görmek.
