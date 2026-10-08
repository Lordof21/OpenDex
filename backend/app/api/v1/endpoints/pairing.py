"""Wireless pairing, QR generation, and mDNS discovery endpoints."""
from __future__ import annotations

import logging
import time

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from app.api.deps import AppContextDep
from app.device.network_utils import get_windows_gateway_ip
from app.schemas import DeviceInfo, DeviceState, HostName
from app.wireless.qr_pairing import QrPayload, generate_pairing_qr

log = logging.getLogger(__name__)
router = APIRouter()


class ManualPairRequest(BaseModel):
    ip: HostName
    port: int = Field(ge=1, le=65535)


class ManualPairCodeRequest(BaseModel):
    ip: HostName
    port: int = Field(ge=1, le=65535)
    pairing_code: str = Field(min_length=6, max_length=6, pattern=r"^\d{6}$")


@router.post("/pairing/qr", response_model=QrPayload)
async def create_pairing_qr(ctx: AppContextDep):
    """Generates a secure QR payload and spawns an mDNS TLS pairing listener."""
    payload = generate_pairing_qr()
    ctx.pairing_listener_task = ctx.spawn_pairing_listener(payload)
    return payload


@router.post("/pairing/manual", response_model=DeviceInfo)
async def pair_manual(body: ManualPairRequest, ctx: AppContextDep):
    """mDNS güvenlik ağı — hotspot multicast'i güvenilmez olduğunda elle IP:port."""
    try:
        return await ctx.connect_and_activate(body.ip, body.port)
    except Exception as exc:
        log.warning(
            "manual pairing to %s:%d failed: %s "
            "(eşleştirme portu mu girildi? cihaz daha önce QR ile eşleştirildi mi?)",
            body.ip, body.port, exc,
        )
        raise HTTPException(status_code=502, detail=f"Bağlantı başarısız: {exc}") from exc


@router.get("/pairing/detected-ip")
async def get_detected_ip(ctx: AppContextDep):
    """Detects the phone's IP directly from an attached device or Windows gateway."""
    if ctx.serial:
        try:
            dev_ip = await ctx.device_manager.get_device_wifi_ip(ctx.serial)
            if dev_ip:
                return {"ip": dev_ip}
        except Exception:
            pass
    try:
        devs = await ctx.device_manager.list_devices()
        for d in devs:
            if d.state == DeviceState.DEVICE:
                dev_ip = await ctx.device_manager.get_device_wifi_ip(d.serial)
                if dev_ip:
                    return {"ip": dev_ip}
    except Exception:
        pass
    gw = await get_windows_gateway_ip()
    return {"ip": gw}


@router.post("/pairing/pair-code")
async def pair_with_code(body: ManualPairCodeRequest, ctx: AppContextDep):
    """mDNS bağımsız eşleştirme — QR akışı `_adb-tls-pairing._tcp` yayınını hiç
    almadığında (güvenlik duvarı/VPN/hotspot multicast engeli) kullanılan yedek."""
    try:
        await ctx.pairing.pair_with_code(body.ip, body.port, body.pairing_code)
        # adb pair succeeding IS the TLS wireless-debugging handshake — link it
        # to whatever connects to this ip next (pair_manual, seconds later in
        # the UI flow) so _remember_device can mark wireless_debugging_paired.
        ctx._last_wireless_pairing = (body.ip, time.time())
    except Exception as exc:
        log.warning(
            "manual pair-code eşleştirme %s:%d için başarısız: %s",
            body.ip, body.port, exc,
        )
        raise HTTPException(status_code=502, detail=f"Eşleştirme başarısız: {exc}") from exc
    return {"ok": True}
