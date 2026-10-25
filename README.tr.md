<div align="center">

# OpenDeX

**Android telefonun, Windows'ta çok pencereli bir masaüstü.**
Her uygulama kendi penceresinde — boyutlandırılabilir — kendi sesi, görev çubuğu, dosya yöneticisi ve bildirimleriyle.

[![License: GPL v3](https://img.shields.io/badge/license-GPL--3.0--or--later-blue.svg)](LICENSE)
![Status](https://img.shields.io/badge/status-pre--1.0-orange)
![Desktop](https://img.shields.io/badge/desktop-Windows-lightgrey)
![Android](https://img.shields.io/badge/Android-10%2B-green)

[English](README.md) · [İndir](download/) · [Kurulum](docs/INSTALL.md) · [Dokümantasyon](docs/README.md)

<img alt="OpenDeX: Windows masaüstünde pencerelerde telefon uygulamaları ve görev çubuğu" src="docs/images/live/hero.webp" width="900">

</div>

## Uygulamayı telefona ver, geri al

<!-- YAPILACAK: docs/images/live/handoff.gif ekle (6-10 sn: PC penceresindeki uygulama -> "Telefona aktar" -> telefon ekranı -> geri), sonra yorumu kaldır:
<div align="center">
<img alt="Bir uygulama PC penceresinden telefonun kendi ekranına ve geri geçiyor" src="docs/images/live/handoff.gif" width="760">
</div>
-->

Ekran yansıtma telefonun **tek** ekranını **tek** pencerede gösterir. OpenDeX her uygulamaya **kendi sanal ekranını** ve penceresini verir; uygulamalar yan yana çalışır, çalışan bir uygulamayı tek tıkla
telefonun ekranına verip geri alabilirsiniz. Telefona uygulama kurulmaz, root gerekmez; OpenDeX telefonu `adb` ile sürer ve [scrcpy](https://github.com/Genymobile/scrcpy) üzerine kuruludur.

## Neler var

<table>
<tr>
<td width="50%"><img src="docs/images/live/window-hub.webp" alt="Pencere merkezi: telefona aktar, alanı doldur, pencere içinde pencere, tuş düzeni, yoğunluk"><br><b>Pencere başına tek merkez.</b> Telefona aktar, yerleştir, pencere içinde pencere, tuş düzeni, yoğunluk.</td>
<td width="50%"><img src="docs/images/live/audio.webp" alt="Uygulama başına ses karıştırıcı"><br><b>Uygulama başına ses.</b> Her uygulamanın sesi telefona, PC'ye ya da ikisine; senkron tutulur. <a href="docs/AUDIO.md">Nasıl</a></td>
</tr>
<tr>
<td><img src="docs/images/live/files.webp" alt="Aktarım sürerken telefon ve PC'yi gösteren dosya yöneticisi"><br><b>Dosyalar.</b> Telefon ve PC yan yana, kaldığı yerden süren aktarımlar, önizleme.</td>
<td><img src="docs/images/live/media-center.webp" alt="Çalan parça ve diğer akışlarla medya merkezi"><br><b>Medya Merkezi.</b> Telefonda çalanı yönet, tüm akışları tek tıkla duraklat.</td>
</tr>
<tr>
<td><img src="docs/images/live/notifications.webp" alt="Takvimli bildirim merkezi"><br><b>Bildirimler.</b> Uygulamaya göre gruplanır; masaüstünden aç ya da yanıtla.</td>
<td><img src="docs/images/live/phone-load.webp" alt="Sıcaklık ve işlemci grafikleriyle telefon yükü paneli"><br><b>Telefon Yükü.</b> CPU, sıcaklık ve OpenDeX'in telefondan ne istediği, sade dille.</td>
</tr>
<tr>
<td><img src="docs/images/live/quick-settings.webp" alt="Hızlı kontrol merkezi"><br><b>Hızlı kontroller.</b> Wi-Fi, Bluetooth, el feneri, ses düzeyleri, varsayılan ses çıkışı.</td>
<td><img src="docs/images/live/settings.webp" alt="Hazır profillerle OpenDeX ayarlarına genel bakış"><br><b>Ayarlar.</b> Kalite, pil ya da zayıf ağ için hazır profiller.</td>
</tr>
</table>

## İndir

**Windows (x64)** — [`download/`](download/) klasöründen ya da [Releases sayfasından](https://github.com/Lordof21/OpenDex/releases) (sağlama toplamları `SHA256SUMS.txt` içinde):

* `OpenDeX_0.1.0_x64_tr-TR.msi` — kurulum paketi
* `OpenDeX_0.1.0_windows-x64_portable.zip` — zip'i açıp `opendex.exe`'yi çalıştırın

Sürümler **imzasızdır**; SmartScreen uyarabilir (*Ek bilgi → Yine de çalıştır*).

## Başlangıç

1. Android **platform-tools** (`adb`) kurun, telefonda **USB hata ayıklamayı** açın.
2. OpenDeX'i kurun, telefonu takın, istemi onaylayın.
3. OpenDeX'i açıp bir uygulama seçin. Kablo yok mu? Eşleştirme penceresi Wi-Fi üzerinden QR / kodla eşleştirir.

Ayrıntılar: **[docs/INSTALL.md](docs/INSTALL.md)** (İngilizce). Kaynaktan çalıştırma: **[docs/DEVELOPMENT.md](docs/DEVELOPMENT.md)**.

> **1.0 öncesi.** Tek telefonda (Xiaomi POCO X7 Pro, Android 16) doğrulandı — [neyin doğrulandığı](docs/DEVICE_COMPATIBILITY.md). Arayüz **20 dilde** (makine çevirisi, ana dili konuşanlarca henüz gözden geçirilmedi — [çeviri rehberi](docs/TRANSLATING.md)); kod, API ve dokümanlar İngilizce.

## Diğer

[Sorun giderme](docs/TROUBLESHOOTING.md) · [SSS](docs/FAQ.md) · [Mimari](docs/ARCHITECTURE.md) · [API](docs/API.md) · [Güvenlik modeli](docs/SECURITY_MODEL.md) · [Yol haritası](docs/ROADMAP.md) · [Değişiklik günlüğü](CHANGELOG.md) · [Katkı](CONTRIBUTING.md)

Yalnızca yerel: hesap, bulut, telemetri yok. Backend yerel bir HTTP/WebSocket API'dir; arayüz onun bir istemcisidir ([API](docs/API.md)).

Lisans: [GPL-3.0-or-later](LICENSE); üçüncü taraf bileşenler: [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
