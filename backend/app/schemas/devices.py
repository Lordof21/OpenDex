"""Device domain models and schemas."""
from __future__ import annotations

from enum import StrEnum
from typing import Literal

from pydantic import BaseModel


class DeviceState(StrEnum):
    DEVICE = "device"
    UNAUTHORIZED = "unauthorized"
    OFFLINE = "offline"
    UNKNOWN = "unknown"


class DeviceInfo(BaseModel):
    serial: str
    state: DeviceState
    model: str | None = None
    transport: Literal["usb", "wireless"] = "usb"
    is_active: bool = False
    # adb's id of THIS connection (`adb devices -l`): a new one every time the link is (re)established, so it tells a
    # drop that was over before anyone polled (ConnectionSupervisor). None: an adb that does not print it.
    transport_id: int | None = None


class DeviceProfile(BaseModel):
    """Per-device knowledge, keyed by ANDROID_ID, cached in SQLite."""

    android_id: str
    encoder_limit: int
    decoder_limit: int | None = None
    android_api: int
    keyboard_layout_configured: bool = False
    flex_display_supported: bool | None = None
    encoder_limit_verified: bool = False
    # Eco Workspace freeform launch sırasında `--activity-launch-bounds` CLI
    # flag'inin bu cihazda fiilen işe yarayıp yaramadığı (Karar: Hibrit
    # Pencereleme Faz 3). None = henüz probe edilmedi, bkz.
    # eco_workspace.py._probe_launch_bounds_support.
    supports_launch_bounds: bool | None = None
    # Cihazın serbest pencere görsel ölçeği (Xiaomi HyperOS / MIUI = 0.70x, AOSP / varsayılan = 1.0x).
    # None = henüz probe edilmedi, bkz. eco_workspace.py._get_freeform_scale.
    freeform_scale: float | None = None
    # Telefonun kendi paneli (uygulamaların gördüğü boyut/yoğunluk; `wm size`/`wm density` override'ı dahil). "Telefon
    # ölçeği" kipi bunlarla hesaplar; her bağlanmada tazelenir. None = henüz okunamadı.
    phone_width: int | None = None      # kısa kenar (px)
    phone_height: int | None = None     # uzun kenar (px)
    phone_density: int | None = None
    # `am update-appinfo` bu cihazda etkinlikleri yerinde yeniden kuruyor mu (density_reconciler.py, öğrenilir)?
    # False: yoğunluk uzlaştırması doğrudan durum korumalı süreç yeniden başlatmaya gider. None = henüz denenmedi.
    density_inplace_relaunch: bool | None = None


class KnownDevice(BaseModel):
    """A device this backend has successfully connected to before, persisted
    so Device Center can offer one-click reconnection (Cihaz Geçiş Planı §3.4).

    ``last_transport`` reflects only the coarse usb/wireless split of the most
    recent connection (always derivable from the serial). Whether a wireless
    connection can be passively rediscovered via mDNS is a separate fact —
    ``wireless_debugging_paired`` — set only by the QR/pairing-code success
    handlers, since a 5555 (plain TCP/IP) connection never implies TLS pairing.
    """

    android_id: str
    model: str | None = None
    last_seen_at: float
    last_transport: Literal["usb", "wireless"] = "usb"
    last_known_ip: str | None = None
    last_known_port: int | None = None
    wireless_debugging_paired: bool = False


class KnownDeviceInfo(KnownDevice):
    """API response shape: KnownDevice plus runtime-only discovery state that
    is never persisted (computed fresh from the live mDNS listener on every
    request — see mdns_discovery.MdnsDiscovery.get_live_connect_endpoints)."""

    discovered: bool = False
    discovered_ip: str | None = None
    discovered_port: int | None = None


class EncoderStressTestResult(BaseModel):
    """WindowManager.run_encoder_stress_test() result."""

    measured_encoder_limit: int
    previous_encoder_limit: int
    capped_by_safety_limit: bool
    failure_reason: str | None = None
    profile: DeviceProfile
