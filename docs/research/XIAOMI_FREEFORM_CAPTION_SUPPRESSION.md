> **Language note:** Turkish (translation on [roadmap](../ROADMAP.md)). Xiaomi HyperOS Freeform window decoration (caption) suppression root cause and solution.

# Xiaomi HyperOS Serbest Pencere Başlıklarının (Miui Caption) Gizlenmesi — Kök Neden ve Çözüm Raporu

**Tarih:** 2026-10-27  
**Hedef Cihaz:** Xiaomi POCO 2412DPC0AG (`rodin_global`), HyperOS / Android 16 (API 36)  
**Hedef Görev:** Freeform (`windowingMode 5`) pencerelerde ekran açıkken Xiaomi sistem başlığını (`Miui Caption`, `Caption container`) tamamen yok etmek.

---

## 1. Özet

Xiaomi HyperOS cihazlarda serbest pencere (`windowingMode 5`) modunda başlatılan uygulamalara varsayılan olarak gri bir tepe başlığı (`Miui Caption of Task=<id>`) ve alt çubuk (`Miui Bottom Caption`) eklenmektedir.

Kullanıcı gözleminde kritik bir ipucu tespit edilmiştir: **Fiziksel ekran kapatıldığında (`input keyevent 223`), bu başlık katmanları SurfaceFlinger'dan tamamen silinmekte; ekran açıldığında (`input keyevent 224`) tekrar oluşturulmaktadır.**

Bu davranışın kök nedeni `/system_ext/priv-app/MiuiSystemUI/MiuiSystemUI.apk` ve SurfaceFlinger kayıtları tersine mühendislik ile çözülmüş; başlıkların standart Android `WindowManager` tarafından değil, **MiuiSystemUI bünyesindeki WM Shell (`com.android.wm.shell.multitasking`)** tarafından üretildiği kanıtlanmıştır.

Doğrudan HyperOS SystemUI iç mantığı çözülerek, ekran açıkken başlıkların SurfaceFlinger'dan tamamen kaldırılmasını sağlayan resmi dahili anahtar bulunmuş ve test edilerek doğrulanmıştır:
```bash
adb shell settings put secure disable_decoration_dot 1
```

Bu komut verildiği anda `Miui Caption` ve `Caption container` katmanları ekran açıkken anında yok olmakta, uygulama saf ve çerçevesiz olarak serbest pencere kipinde çalışmaya devam etmektedir.

---

## 2. Mimari İnceleme: SurfaceFlinger Hiyerarşisi

Bir HyperOS serbest penceresinin SurfaceFlinger üzerindeki katman ağacı şu şekildedir:

```text
Task=<taskId>
 ├── ActivityRecord (Uygulamanın asıl arayüzü)
 ├── StatusBar Container of Task = <taskId> (mStatusBarParent, z=2147483636)
 │    └── Caption container of Task = <taskId> (z=30000)
 │         └── Miui Caption of Task = <taskId>Leash
 │              └── Miui Caption of Task = <taskId> (Başlık görünümü)
 └── NavigationBar Container of Task = <taskId> (mNavBarParent, z=2147483637)
      └── Bottom Caption container of Task = <taskId> (z=30000)
           └── Miui Bottom Caption of Task = <taskId>Leash
                └── Miui Bottom Caption of Task = <taskId>
```

Uygulamanın asıl içeriği (`ActivityRecord`) ile başlık katmanları (`StatusBar Container` ve `NavigationBar Container`) kardeş (sibling) katmanlardır. Dolayısıyla başlık katmanının kaldırılması, uygulamanın çizilmesini veya dokunmatik olaylarını bozmamaktadır.

---

## 3. Ekran Kapanma Olayının Canlı İzi (Trace Log)

Fiziksel ekran kapandığı (`keyevent 223`) andaki log akışı kaydedildiğinde:

```text
17:27:59.352 D MiuiDecorationController: relayout:: taskId=1880, visible=false ...
17:27:59.353 D MiuiDecorationDot: releaseViews_TopCaption: taskId=1880
17:27:59.353 D MiuiDecorationBottom: releaseViews_BottomCaption: taskId=1880
...
17:27:59.553 I SurfaceFlinger: onHandleDestroyed: layerId=9504, name=Miui Caption of Task=1880#9504
17:27:59.554 I SurfaceFlinger: onHandleDestroyed: layerId=9501, name=Caption container of Task=1880#9501
17:27:59.554 I SurfaceFlinger: onHandleDestroyed: layerId=9502, name=Bottom Caption container of Task=1880#9502
```

Ekran açıldığı (`keyevent 224`) anda ise:
```text
17:28:01.924 D MiuiDecorationDot: needTopCaption: isFreeform=true
17:28:01.924 D MiuiDecorationDot: updateViews_TopCaption: taskId=1880 ...
17:28:01.996 I MiuiDecorationSamplingHelper: register mSamplingRect=... stopLayer=Surface(name=Miui Caption of Task=1880)
```

Bu kanıt zinciri, başlığın yok edilip geri getirilmesinin merkez üssünün **`MiuiDecorationDot`** ve **`MulWinSwitchDecorViewModel`** sınıfları olduğunu kesinleştirmiştir.

---

## 4. MiuiSystemUI Tersine Mühendislik Bulguları

Cihazdan temin edilen `MiuiSystemUI.apk` (`classes3.dex`) içerisindeki Dalvik bayt kodları incelendiğinde aşağıdaki kritik yapılar açığa çıkarılmıştır:

### 4.1. `MiuiDecorationDot` ve Karar Mantığı
* `needCaption()` metodu tepe başlığının gerekip gerekmediğini denetler.
* İçerisinde şu kontroller yer alır:
  1. `MulWinSwitchUtils.shouldSuppressDot(packageName)`
  2. `isExcludeDisplay(displayId)` (`com.xiaomi.mirror`, `com.miui.carlink` projeksiyon ekranları)
  3. `miui.window.DOT_ENABLED` AndroidManifest özellik bayrağı
  4. `MulWinSwitchSettingsObserver.mDisableDecorationDot`

### 4.2. `MulWinSwitchUtils.shouldSuppressDot` Bayt Kodu
```text
=== Method: shouldSuppressDot (insns=49) ===
  [0000] invoke Lcom/android/wm/shell/multitasking/miuimultiwinswitch/MulWinSwitchSettingsObserver;->getInstance
  [0008] invoke Lcom/android/wm/shell/multitasking/miuimultiwinswitch/MulWinSwitchSettingsObserver;->isMiuiOptimizationEnabled
  [0016] const-string "Disable DecorationDot when MIUI optimization is turned off"
  [0026] sget Lcom/android/wm/shell/multitasking/miuimultiwinswitch/MulWinSwitchUtils;->DOT_SUPPRESSED_PACKAGES:Ljava/util/Set;
  [002a] invoke Ljava/util/Set;->contains
  [003e] const-string "Disable DecorationDot for : "
```

### 4.3. `MulWinSwitchSettingsObserver` Kayıtları
Sistem açılışında SystemUI şu `ContentObserver` dinleyicilerini kaydetmektedir:
```java
ContentResolver cr = context.getContentResolver();
cr.registerContentObserver(Settings.Secure.getUriFor("disable_decoration_dot"), false, observer);
cr.registerContentObserver(Settings.Global.getUriFor("decoration_bottom_width"), false, observer);
```

`disable_decoration_dot` değeri değiştiğinde:
```java
onDecorationDotEnableChanged, mMiuiOptimizationEnabled: true, mDisableDecorationDot: true
```
tetiklenmekte ve `MulWinSwitchDecorViewModel` üzerindeki tüm aktif pencereler için `releaseDotView` çalıştırılarak başlıklar bellekten ve SurfaceFlinger'dan atılmaktadır.

---

## 5. Canlı Test ve Doğrulama Kanıtı

Açık serbest pencere (Play Store, `Task=1880`) üzerinde test gerçekleştirilmiştir.

### Öncesi:
```text
RequestedLayerState{Miui Caption of Task=1880#9504 parentId=9503}
RequestedLayerState{Caption container of Task=1880#9501 parentId=8971 z=30000}
RequestedLayerState{Miui Bottom Caption of Task=1880#9506 parentId=9505}
RequestedLayerState{Bottom Caption container of Task=1880#9502 parentId=8970 z=30000}
```

### Komut Uygulaması:
```bash
adb shell settings put secure disable_decoration_dot 1
```

### Sonrası (`dumpsys SurfaceFlinger --list`):
```text
RequestedLayerState{StatusBar Container of Task = 1880#8971 parentId=8967 z=2147483636}
RequestedLayerState{NavigationBar Container of Task = 1880#8970 parentId=8967 z=2147483637}
RequestedLayerState{Task=1880#8967 parentId=8951 z=7}
RequestedLayerState{ActivityRecord{65349369 u0 com.android.vending/.AssetBrowserActivity t1880}#8933 parentId=8967}
RequestedLayerState{Surface(name=Task=1880#8967)/@0x38bda4d_transition-leash#9538 z=4}
RequestedLayerState{MaskIcon_1880#9579}
RequestedLayerState{MaskDark_1880#9578}
RequestedLayerState{MaskSnapshotLayer_1880#9577}
```

**Sonuç:**
* `Miui Caption of Task=1880` katmanı **yok edilmiştir**.
* `Caption container of Task=1880` katmanı **yok edilmiştir**.
* `Bottom Caption container` katmanı **yok edilmiştir**.
* Uygulama penceresi ekran açıkken başlık olmadan tam görünürlükte ve dokunmatik desteğiyle çalışmaya devam etmiştir.

---

## 6. Kalıcı Entegrasyon Planı

OpenDex mimarisinde HyperOS cihazlar için bu özelliğin kalıcılaştırılması:

1. **Daemon / Cihaz Başlatma (Init) Aşaması:**
   Xiaomi cihaz tespiti yapıldığında (`ro.miui.ui.version.name` veya HyperOS build özellikleri):
   ```bash
   settings put secure disable_decoration_dot 1
   ```
   komutu bir kez otomatik olarak çalıştırılır.

2. **Geri Alma (Teardown) Güvenliği:**
   Kullanıcı masaüstü oturumunu sonlandırdığında veya isteğe bağlı olarak ayar eski haline getirilebilir:
   ```bash
   settings delete secure disable_decoration_dot
   ```

3. **Görsel Başlık Yönetimi (OpenDex Custom Titlebar):**
   Xiaomi'nin sistem başlığı kaldırıldığı için, pencerenin taşınması, kapatılması veya boyutlandırılması OpenDex'in kendi web/desktop arayüzü (`custom-titlebar`) üzerinden pürüzsüz ve yerel olarak kontrol edilebilir hale gelmiştir.
