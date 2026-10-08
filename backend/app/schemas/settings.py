"""Global project settings domain models."""
from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field, field_validator


class ProjectSettings(BaseModel):
    dynamic_resolution_enabled: bool = False
    resolution_mode: Literal[
        "dynamic", "dynamic_fit", "dynamic_fix", "phone_scale",
        "1080p", "tablet", "2k", "2.5k",
        "fixed_1080p", "fixed_1200p", "fixed_1440p", "fixed_1600p"
    ] = "dynamic"
    video_fit_mode: Literal["contain", "fill", "cover"] = "contain"
    screen_off_while_mirroring: bool = False
    enable_audio: bool = True
    # Bounds: these numbers become scrcpy server options and `wm density`; an absurd value used to be accepted and
    # then fail on the phone, or make a virtual display unusable.
    max_fps: int = Field(60, ge=1, le=240)
    video_bit_rate: int = Field(8_000_000, ge=1, le=500_000_000)
    max_size: int = Field(1280, ge=0, le=8192)          # 0 = dynamic (no cap)
    custom_dpi: int = Field(0, ge=0, le=1200)           # 0 = auto
    target_dp: int = Field(0, ge=0, le=4000)            # 0 = auto
    ambient_backdrop: bool = True
    enable_hybrid_dom: bool = False
    audio_codec: Literal["raw", "opus"] = "raw"
    custom_encoder_limit: int = Field(0, ge=0, le=64)   # 0 = probed value
    header_hover_mode: bool = False
    dp_lock_enabled: bool = False
    # Ses çıkışı = uygulamaların varsayılan rotası: "phone" Telefon, "pc" DeX, "both" İkisi (uygulama başına rotayla aynı
    # sözlük). Eski kayıtlardaki "laptop"/"dual" okunurken çevrilir.
    audio_output_mode: Literal["pc", "phone", "both"] = "pc"
    # "İkisi" rotasında telefon ve DeX aynı anda duyulur (ortak zaman çizgisi, bkz. streams/app_audio.py). Bu, kulakla yapılan
    # İNCE AYARdır: + telefonu geciktirir, − öne alır (ms).
    audio_sync_offset_ms: int = Field(0, ge=-300, le=500)
    enable_flex_display: bool = False
    video_codec: Literal["auto", "h265", "h264", "av1"] = "auto"
    pixel_perfect_dpr: bool = True
    # "Anında Boyutlandır": bırakıldığı an pencere yeni kutusuna geçer, yeni
    # çözünürlükteki ilk kare gelene kadar eski kare yeni kutuda mevcut sığdırma kipiyle görünür. Kapalı (varsayılan):
    # pencere ilk yeni kare gelene kadar başlangıç kutusunda tutulur, hedef kesikli önizlemeyle gösterilir.
    resize_instant_apply: bool = False
    sharpening_mode: Literal["off", "adaptive", "ultra"] = "adaptive"
    stealth_dpi_enabled: bool = True
    # Bir uygulamanın SÜRECİ yoğunluk (DPI) değişimini yaşadıysa (telefondan sanal ekrana taşıma, canlı DPI, telefona
    # dönüş) uygulama arayüzünü yeni yoğunlukta yeniden kurmaya zorlanır — YouTube gibi arayüzünü doğum yoğunluğunda
    # dondurabilen uygulamalar için. Kapatılırsa hiçbir şey yenilenmez/öldürülmez (bkz. windows/density_reconciler.py).
    density_refresh_enabled: bool = True
    # Yenileme yöntemi. Kapalı (varsayılan, nazik): etkinlikler AYNI süreçte yeniden kurulur (`am update-appinfo`; süreç,
    # arka plan servisleri ve bellekteki durum korunur) ve sistem olay günlüğünde kanıtlanır; kanıtlanamazsa süreç
    # yeniden başlatılır. Açık: doğrudan süreç yeniden başlatılır — etkinlik yeniden kurma yetmeyen (yoğunluğu süreç
    # düzeyinde tutan) bir uygulama için.
    density_refresh_hard: bool = False
    # PC'den "Telefona Aktar": yoğunluk değişimi telefonda değil, PC penceresinin perdesi arkasında sanal ekranda yaşanır
    # (ön-iniş: sanal ekran telefonun yoğunluğuna çekilir, uygulama orada uzlaştırılır, görev ondan sonra taşınır). Kapalı
    # ise taşıma boyut + yoğunluk değişimini tek adımda taşır, uzlaştırma telefonda çalışır. `density_refresh_enabled`
    # kapalıysa ön-iniş de yapılmaz (uzlaştıracak bir şey yok).
    handoff_prelanding: bool = True
    # Kullanıcının Control Center'dan seçtiği varsayılan pencereleme
    # davranışı (Karar: Hibrit Pencereleme Faz 1). Pencere başına manuel
    # tomurcuklama/dock (TitleBar eylemi) bunu HER ZAMAN geçersiz kılabilir;
    # bu sadece "yeni bir pencere nereye doğsun" varsayılanıdır.
    windowing_mode: Literal["eco", "independent", "hybrid_auto"] = "hybrid_auto"
    # Cihaz Bağlantı Planı §3.3: bu bilgisayarda başarıyla bağlanan cihazlar
    # known_devices tablosuna kaydedilsin mi (tek tık yeniden bağlanma için)?
    # Kapatmak SADECE bu listeyi etkiler — telefon tarafındaki Kablosuz Hata
    # Ayıklama güvenini SİLMEZ (paylaşılan bilgisayar senaryosu).
    remember_devices: bool = True
    # Uygulamayı telefona aktarırken görevin pencereleme kipi. "fullscreen" (varsayılan, önerilen):
    # telefonun ekranını tamamen kaplar. "freeform" (deneysel): ekranın ~%80'inde ortalı serbest pencere; üretici
    # freeform ölçeği telefonda da uygulanabildiğinden görev küçük görünebilir.
    phone_handoff_windowing: Literal["fullscreen", "freeform"] = "fullscreen"
    # Bir pencerenin uygulaması TELEFONDA kapatılınca (Son Kullanılanlar'dan kaydırma, zorla durdurma):
    # "close" pencereyi kapatır, "badge" pencereyi bırakır ve üstünde "Yeniden aç / Kapat" gösterir.
    app_closed_behavior: Literal["close", "badge"] = "close"

    @field_validator("audio_output_mode", mode="before")
    @classmethod
    def _legacy_audio_output_mode(cls, value: object) -> object:
        """Kayıtlı eski adlar (ses çıkışı "Laptop"/"Çift") yeni sözlüğe çevrilir; bilinmeyen değer doğrulamada reddedilir."""
        return {"laptop": "pc", "dual": "both"}.get(value, value) if isinstance(value, str) else value
