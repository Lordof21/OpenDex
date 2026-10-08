"""Universal App State Continuity Engine (Karar: Display Migration Continuity).

DURUM (2026-09-08): Bu dosya aktif handoff/reclaim akışına bağlı DEĞİL.
Gerçek cihazda Stealth DPI ile A/B karşılaştırıldı — masaüstü modundan
telefon moduna büyük ekranlarda ikisi de bir miktar sapıyor, ama Stealth
DPI bir tık daha iyi sonuç verdi; telefon-telefon geçişlerinde ikisi eşit
güçteydi. Bu yüzden aktif sistem artık sadece Stealth DPI kullanıyor (bkz.
handoff_manager.py'nin dosya başındaki Karar notu — App Continuity'yi
çağıran kod orada yorum satırı olarak saklanıyor). Bu dosyanın kendisi
silinmedi/değiştirilmedi — ileride tekrar değerlendirilmek istenirse ek bir
bakış açısı / karşılaştırma noktası olarak burada duruyor.

Tasarım Felsefesi
-----------------
Android'de ``am display move-stack`` bir görevi fiziksel ekrandan sanal
ekrana (veya tersine) taşır. Çoğu native uygulama bu geçişi sorunsuz
atlatar çünkü Activity yeniden oluşturulmaz — sadece taşınır.

Ancak bazı uygulamalar bu geçişi kötü yönetir:
- **Chrome / Chromium**: ``onNewIntent`` ile scroll state'ini sıfırlar.
- **WebView tabanlı uygulamalar**: Benzer Intent sıfırlama davranışı.
- **Bazı native uygulamalar**: ``onConfigurationChanged`` veya ``onDisplayChanged``
  callback'lerinde kendi UI state'lerini sıfırlayanlar.

Bu modül üç katmanlı bir strateji uygular:

  Katman 1 — CDP (Chrome DevTools Protocol)
  ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
  Chrome ve Chromium WebView kullanan uygulamalar için. Kesin piksel
  hassasiyetinde scroll koordinatı ve DOM anchor kaydı/yüklemesi.
  ``adb forward tcp:9223 localabstract:chrome_devtools_remote``

  Katman 2 — UIAutomator Hierarchy Snapshot
  ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
  Native uygulamalardaki RecyclerView, ListView, ScrollView, NestedScrollView
  gibi bileşenler için. ``adb shell uiautomator dump`` ile UI ağacını alır,
  scroll position'u ``scrollX``/``scrollY``/``bounds`` ile tahmin eder,
  sonra aksesibilite event'leri ile geri yükler.

  Katman 3 — Screenshot Memento (Evrensel Fallback)
  ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
  Her durumda çalışır. Taşımadan önce ekran görüntüsü alınır. Taşıma
  sonrası kısa bir yükleme süresi varsa bu görüntü arayüzde "son bilinen
  durum" olarak gösterilebilir. ``app_state_snapshot`` event'i yayınlanır.

Entegrasyon Noktaları
---------------------
- ``capture_app_state(adb, serial, package)`` → taşımadan önce çağır
- ``restore_app_state(adb, serial, package, state)`` → taşımadan sonra çağır
- ``AppState`` dataclass: katman bilgisini ve ham veriyi taşır

Tüm metodlar hata-dayanıklıdır (contextlib.suppress ile sarılı çağrılar).
Herhangi bir katmanın başarısız olması operasyonu engellemez.
"""
from __future__ import annotations

import asyncio
import json
import logging
import re
import xml.etree.ElementTree as ET
from dataclasses import dataclass, field
from enum import Enum
from typing import Any

import urllib.request
import websockets  # type: ignore[import-untyped]

from ..device import android_shell

log = logging.getLogger(__name__)

# ── CDP port (Chrome DevTools Protocol) ──────────────────────────────────────
CDP_FORWARD_PORT = 9223

# WebView abstract socket naming patterns (package → socket name mapping).
# Chrome ve bilinen tüm Chromium tabanlı tarayıcılar dahil.
# WebView uygulamaları paket adına göre kendi soketi adlandırır.
_CDP_SOCKET_PATTERNS = [
    "chrome_devtools_remote",          # Chrome, Chromium, Edge for Android
    "webview_devtools_remote",         # Generic Android WebView
    "{package}_devtools_remote",       # Some custom Chromium builds
]

# Packages known to use CDP (Chrome DevTools Protocol) for scroll state
_CHROMIUM_PACKAGES = frozenset({
    "com.android.chrome",
    "com.chrome.beta",
    "com.chrome.dev",
    "com.chrome.canary",
    "com.microsoft.emmx",          # Edge for Android
    "org.mozilla.firefox",         # Firefox (partial WebView)
    "com.brave.browser",
    "com.opera.browser",
})

# Packages that embed WebView and may respond to CDP
_WEBVIEW_PACKAGES = frozenset({
    "com.google.android.apps.youtube.music",  # YT Music
    "com.google.android.youtube",
    "com.spotify.music",
    "com.twitter.android",
    "com.instagram.android",
    "com.whatsapp",
    "com.facebook.katana",
    "com.reddit.frontpage",
    "com.linkedin.android",
    "com.netflix.mediaclient",
    "com.amazon.mShop.android.shopping",
    "com.booking",
    "com.airbnb.android",
    "com.ubercab",
    "com.trendyol.app",
    "com.hepsiburada.android",
    "com.ciceksepeti.ciceksepeti",
    "com.migros.migrosone",
    "com.a101.mobileapp",
    "com.bim.bimcelapp",
    "com.sahibinden.android",
    "com.letgo.android",
    "com.gittigidiyor.android",
    "com.zomato.android",
    "com.yemeksepeti",
    "com.getir.android",
})


class ContinuityLayer(str, Enum):
    """Hangi katmanın state'i yakaladığını bildirir."""
    CDP = "cdp"
    UIAUTOMATOR = "uiautomator"
    SCREENSHOT = "screenshot"
    NONE = "none"


@dataclass
class AppState:
    """Taşıma öncesi yakalanan uygulama durumu.

    ``layer``: Hangi katman bu state'i yakaladı.
    ``data``:  Katmana özgü ham veri (CDP için scroll dict,
               UIAutomator için parsed hierarchy, Screenshot için path).
    ``package``: Hangi paket için yakalandı.
    """
    package: str
    layer: ContinuityLayer = ContinuityLayer.NONE
    data: dict[str, Any] = field(default_factory=dict)

    def is_valid(self) -> bool:
        return self.layer != ContinuityLayer.NONE and bool(self.data)


# ─────────────────────────────────────────────────────────────────────────────
# Katman 1: CDP (Chrome DevTools Protocol)
# ─────────────────────────────────────────────────────────────────────────────

async def _get_cdp_socket_name(adb, serial: str, package: str) -> str | None:
    """Pakete ait CDP abstract socket adını cihazda arar."""
    try:
        raw = await adb.shell("grep -a devtools_remote /proc/net/unix", serial=serial, timeout_s=2.0)
        if not raw:
            return None
        # Önce pakete özel soketi dene
        pkg_socket = f"{package}_devtools_remote"
        if pkg_socket in raw:
            return pkg_socket
        # Genel WebView soketi
        if "webview_devtools_remote" in raw:
            # En yeni (en son başlayan) WebView soketini al — birden fazla olabilir
            matches = re.findall(r"(webview_devtools_remote[^\s@]*)", raw)
            if matches:
                return matches[-1]
        # Chrome / Chromium
        if "chrome_devtools_remote" in raw:
            return "chrome_devtools_remote"
        return None
    except Exception as exc:
        log.debug("[CONTINUITY/CDP] Socket arama hatası (%s): %s", package, exc)
        return None


async def _ensure_cdp_forward(adb, serial: str, socket_name: str) -> int | None:
    """Local port'u cihaz CDP soketine yönlendirir."""
    try:
        await adb.forward(CDP_FORWARD_PORT, socket_name, serial=serial)
        return CDP_FORWARD_PORT
    except Exception as exc:
        log.debug("[CONTINUITY/CDP] Forward hatası: %s", exc)
        return None


_CAPTURE_JS = """
(() => {
    const h   = window.innerHeight;
    const w   = window.innerWidth;
    const y   = window.scrollY;
    const x   = window.scrollX;
    const dH  = document.documentElement.scrollHeight;
    const dW  = document.documentElement.scrollWidth;
    // devicePixelRatio: CSS piksel → fiziksel piksel çarpanı.
    // Display değişince DPR değişir; bundan bağımsız (DPR-agnostic)
    // fiziksel piksel cinsinden pozisyonu da saklıyoruz. Restore sırasında
    // hedef DPR'ye göre normalize edilir — touch pipeline'daki gibi.
    const dpr = window.devicePixelRatio || 1;

    // En üstteki görünür öğeye anchor ekle.
    // scrollIntoView layout-bağımsızdır: DPR/reflow sonrası da çalışır.
    const el = document.elementFromPoint(w / 2, Math.min(200, h / 4));
    let anchorId = null;
    if (el && el.tagName !== 'HTML' && el.tagName !== 'BODY') {
        anchorId = '__odx_' + Date.now();
        el.setAttribute('data-odx-anchor', anchorId);
    }

    return {
        url:           window.location.href,
        scrollX:       x,
        scrollY:       y,
        scrollWidth:   dW,
        scrollHeight:  dH,
        innerHeight:   h,
        innerWidth:    w,
        ratioY:        dH > h ? y / (dH - h) : 0,
        ratioX:        dW > w ? x / (dW - w) : 0,
        // DPR-normalized fiziksel piksel pozisyon (display değişiminden bağımsız)
        physicalScrollY: Math.round(y * dpr),
        physicalScrollX: Math.round(x * dpr),
        sourceDPR:     dpr,
        anchorId:      anchorId,
        title:         document.title,
    };
})()
"""


async def _cdp_capture(adb, serial: str, package: str) -> dict | None:
    """CDP ile aktif sekmenin scroll state'ini yakalar."""
    socket_name = await _get_cdp_socket_name(adb, serial, package)
    if not socket_name:
        return None

    port = await _ensure_cdp_forward(adb, serial, socket_name)
    if not port:
        return None

    try:
        loop = asyncio.get_event_loop()
        req = urllib.request.Request(f"http://127.0.0.1:{port}/json/list")
        content = await loop.run_in_executor(
            None, lambda: urllib.request.urlopen(req, timeout=2.0).read().decode()
        )
        tabs = json.loads(content)
        page_tabs = [
            t for t in tabs
            if t.get("type") == "page"
            and not t.get("url", "").startswith(("chrome-extension://", "chrome-native://", "about:"))
        ]
        if not page_tabs:
            return None

        # Görünür sekmeyi önceliklendir
        target_ws = None
        for t in page_tabs:
            raw_ws = t.get("webSocketDebuggerUrl")
            if not raw_ws:
                continue
            ws = re.sub(r"ws://[^/]+/", f"ws://127.0.0.1:{port}/", raw_ws)
            try:
                async with websockets.connect(ws, close_timeout=0.8) as conn:
                    await conn.send(json.dumps({
                        "id": 1, "method": "Runtime.evaluate",
                        "params": {"expression": "document.visibilityState"}
                    }))
                    vis_raw = await asyncio.wait_for(conn.recv(), timeout=1.0)
                    vis = json.loads(vis_raw).get("result", {}).get("result", {}).get("value")
                    if vis == "visible":
                        target_ws = ws
                        break
            except Exception:
                continue

        if not target_ws:
            # Fallback: ilk geçerli sekme
            raw_ws = page_tabs[0].get("webSocketDebuggerUrl")
            if not raw_ws:
                return None
            target_ws = re.sub(r"ws://[^/]+/", f"ws://127.0.0.1:{port}/", raw_ws)

        async with websockets.connect(target_ws, close_timeout=1.5) as ws:
            await ws.send(json.dumps({
                "id": 101, "method": "Runtime.evaluate",
                "params": {"expression": _CAPTURE_JS, "returnByValue": True}
            }))
            raw = await asyncio.wait_for(ws.recv(), timeout=2.5)
            val = json.loads(raw).get("result", {}).get("result", {}).get("value")
            if val and isinstance(val, dict):
                val["ws_url"] = target_ws
                val["socket_name"] = socket_name
                log.info(
                    "📖 [CONTINUITY/CDP] %s → ratioY=%.3f anchorId=%s url=%s",
                    package, val.get("ratioY", 0), val.get("anchorId"), val.get("url", "")[:60]
                )
                return val
    except Exception as exc:
        log.debug("[CONTINUITY/CDP] Capture hatası (%s): %s", package, exc)
    return None


_RESTORE_JS_TEMPLATE = """
(() => {{
    // ── Strateji 1: Anchor (en güvenli, DPR/layout bağımsız) ──────────────
    const anchorId = {anchor_json};
    if (anchorId) {{
        const el = document.querySelector(`[data-odx-anchor="${{anchorId}}"]`);
        if (el) {{
            el.scrollIntoView({{ block: 'start', behavior: 'instant' }});
            el.removeAttribute('data-odx-anchor');
            return {{ restored: true, method: 'anchor' }};
        }}
    }}

    // ── Strateji 2: DPR-normalized fiziksel piksel ─────────────────────────
    // Kayıt anındaki fiziksel piksel pozisyonunu (physicalScrollY/X) mevcut
    // display'in devicePixelRatio değeriyle CSS piksele çeviriyoruz.
    // Bu, touch pipeline normalizasyonuyla aynı prensibi kullanır:
    //   targetCSS = physicalPx / currentDPR
    const physicalY = {physical_y};
    const physicalX = {physical_x};
    if (physicalY > 0 || physicalX > 0) {{
        const currentDPR = window.devicePixelRatio || 1;
        const targetY = physicalY / currentDPR;
        const targetX = physicalX / currentDPR;
        // Scroll sınırına kısıt uygula
        const maxY = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
        const maxX = Math.max(0, document.documentElement.scrollWidth  - window.innerWidth);
        window.scrollTo(
            Math.min(targetX, maxX),
            Math.min(targetY, maxY)
        );
        return {{ restored: true, method: 'dpr_normalized', dpr: currentDPR, targetY: targetY }};
    }}

    // ── Strateji 3: CSS-ratio (son çare, az güvenilir) ─────────────────────
    const dH = document.documentElement.scrollHeight;
    const dW = document.documentElement.scrollWidth;
    const h  = window.innerHeight;
    const w  = window.innerWidth;
    window.scrollTo(
        {ratio_x} * Math.max(0, dW - w),
        {ratio_y} * Math.max(0, dH - h)
    );
    return {{ restored: true, method: 'css_ratio' }};
}})()
"""


async def _cdp_restore(ws_url: str, state: dict) -> bool:
    """CDP ile scroll state'ini geri yükler (DPR-normalize edilmiş)."""
    anchor      = state.get("anchorId")
    physical_y  = state.get("physicalScrollY", 0)
    physical_x  = state.get("physicalScrollX", 0)
    ratio_y     = state.get("ratioY", 0)
    ratio_x     = state.get("ratioX", 0)
    js = _RESTORE_JS_TEMPLATE.format(
        anchor_json=json.dumps(anchor),
        physical_y=physical_y,
        physical_x=physical_x,
        ratio_y=ratio_y,
        ratio_x=ratio_x,
    )
    try:
        async with websockets.connect(ws_url, close_timeout=1.5) as ws:
            await ws.send(json.dumps({
                "id": 202, "method": "Runtime.evaluate",
                "params": {"expression": js, "returnByValue": True}
            }))
            raw = await asyncio.wait_for(ws.recv(), timeout=2.5)
            result = json.loads(raw).get("result", {}).get("result", {})
            val = result.get("value", {})
            method = val.get("method", "?") if isinstance(val, dict) else "?"
            restored = val.get("restored", False) if isinstance(val, dict) else bool(val)
            log.info(
                "📖 [CONTINUITY/CDP] Geri yükleme: %s (yöntem=%s physY=%d→CSS=%.1f)",
                restored, method, physical_y, physical_y  # target CSS logged separately
            )
            return bool(restored)
    except Exception as exc:
        log.debug("[CONTINUITY/CDP] Restore hatası: %s", exc)
    return False


# ─────────────────────────────────────────────────────────────────────────────
# Katman 2: UIAutomator — Native uygulamalar için
# ─────────────────────────────────────────────────────────────────────────────

_DUMP_PATH = "/sdcard/odx_ui_dump.xml"


async def _uiautomator_capture(adb, serial: str, package: str) -> dict | None:
    """UIAutomator dump ile scroll state'i yakalar (native uygulamalar).

    Kaynak display (Display 0) boyutu ve DPI'sini da kaydeder; restore
    aşamasında hedef sanal display boyutuna göre koordinatlar normalize
    edilir — touch pipeline'daki ölçekleme mantığıyla aynı prensip.
    """
    try:
        # Kaynak display (telefonun kendi ekranı) — normalizasyon için gerekli. Okunamazsa yakalama yapılmaz: uydurma bir
        # boyut/yoğunluk, geri yüklemede kaydırma konumunu yanlış yere taşırdı.
        phone = await android_shell.read_phone_display(adb, serial)
        if phone is None:
            return None
        source_w, source_h, source_dpi = phone.width, phone.height, phone.density

        # UI dump al
        await adb.shell(f"uiautomator dump {_DUMP_PATH}", serial=serial, timeout_s=5.0)
        raw_xml = await adb.shell(f"cat {_DUMP_PATH}", serial=serial, timeout_s=3.0)
        if not raw_xml or "<hierarchy" not in raw_xml:
            return None

        root = ET.fromstring(raw_xml)
        scrollable_nodes: list[dict] = []

        def _parse_bounds(bounds_str: str) -> tuple[int, int, int, int] | None:
            """'[x1,y1][x2,y2]' formatını parse eder."""
            m = re.findall(r"\[(\d+),(\d+)\]", bounds_str)
            if len(m) == 2:
                return int(m[0][0]), int(m[0][1]), int(m[1][0]), int(m[1][1])
            return None

        def _walk(node: ET.Element, depth: int = 0) -> None:
            pkg = node.get("package", "")
            if pkg and package not in pkg:
                return
            scrollable = node.get("scrollable", "false") == "true"
            cls = node.get("class", "")
            rid = node.get("resource-id", "")
            bounds_str = node.get("bounds", "")
            bounds = _parse_bounds(bounds_str) if bounds_str else None

            if scrollable and bounds:
                scrollable_nodes.append({
                    "class":       cls,
                    "resource_id": rid,
                    "bounds":      bounds,   # fiziksel piksel — Display 0 koordinat uzayı
                    "scroll_x":    int(node.get("scrollX", 0) or 0),
                    "scroll_y":    int(node.get("scrollY", 0) or 0),
                    "bounds_str":  bounds_str,
                })
            for child in node:
                _walk(child, depth + 1)

        _walk(root)

        if not scrollable_nodes:
            return None

        primary = max(
            scrollable_nodes,
            key=lambda n: (n["bounds"][2] - n["bounds"][0]) * (n["bounds"][3] - n["bounds"][1])
        )

        log.info(
            "📖 [CONTINUITY/UIAutomator] %s → class=%s res_id=%s bounds=%s source=%dx%d@%ddpi",
            package, primary["class"], primary["resource_id"],
            primary["bounds_str"], source_w, source_h, source_dpi
        )
        return {
            "nodes":      scrollable_nodes,
            "primary":    primary,
            "dump_path":  _DUMP_PATH,
            # Normalizasyon metadata — kaynak display koordinat uzayı
            "source_w":   source_w,
            "source_h":   source_h,
            "source_dpi": source_dpi,
        }
    except Exception as exc:
        log.debug("[CONTINUITY/UIAutomator] Capture hatası (%s): %s", package, exc)
    return None


async def _uiautomator_restore(
    adb, serial: str, package: str, state: dict,
    target_w: int = 0, target_h: int = 0,
) -> bool:
    """UIAutomator state'e bakarak native uygulamada scroll'u geri yükler.

    Koordinat Normalizasyonu (touch pipeline ile aynı prensip)
    ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
    Capture sırasında bounds Display 0 fiziksel piksel uzayındaydı.
    Restore sanal display üzerinde gerçekleşir; dolayısıyla center_x/y
    ve view_h değerleri ``target_w / source_w`` oranıyla ölçeklenmeli —
    aksi takdirde ekrana dışında ya da yanlış konumda swipe enjekte edilir.
    """
    try:
        primary = state.get("primary")
        if not primary:
            return False

        scroll_y = primary.get("scroll_y", 0)
        if scroll_y <= 0:
            return True  # Zaten en üstte

        source_w = state.get("source_w", 0)
        source_h = state.get("source_h", 0)
        bounds   = primary["bounds"]

        # ── Koordinat normalizasyon faktörü ───────────────────────────────
        # Kaynak veya hedef boyut bilinmiyorsa 1.0 kullan (scale-neutral)
        scale_x = (target_w / source_w) if (target_w > 0 and source_w > 0) else 1.0
        scale_y = (target_h / source_h) if (target_h > 0 and source_h > 0) else 1.0

        # Bounds → hedef display koordinat uzayına çevir
        t_x1 = round(bounds[0] * scale_x)
        t_y1 = round(bounds[1] * scale_y)
        t_x2 = round(bounds[2] * scale_x)
        t_y2 = round(bounds[3] * scale_y)

        center_x = (t_x1 + t_x2) // 2
        center_y = (t_y1 + t_y2) // 2
        view_h   = t_y2 - t_y1

        # scroll_y de kaynak piksel — scale_y ile normalize et
        scaled_scroll_y = scroll_y * scale_y
        swipes_needed = max(1, round(scaled_scroll_y / max(view_h, 1)))
        swipes_needed = min(swipes_needed, 10)  # Güvenlik limiti

        log.info(
            "[CONTINUITY/UIAutomator] %s → scale=(%.2f,%.2f) center=(%d,%d) swipes=%d",
            package, scale_x, scale_y, center_x, center_y, swipes_needed
        )

        for _ in range(swipes_needed):
            from_y = center_y - view_h // 3
            to_y   = center_y + view_h // 3
            await adb.shell(
                f"input swipe {center_x} {from_y} {center_x} {to_y} 200",
                serial=serial, timeout_s=1.0
            )
            await asyncio.sleep(0.1)

        log.info("[CONTINUITY/UIAutomator] %s → %d swipe tamamlandı", package, swipes_needed)
        return True
    except Exception as exc:
        log.debug("[CONTINUITY/UIAutomator] Restore hatası (%s): %s", package, exc)
    return False


# ─────────────────────────────────────────────────────────────────────────────
# Katman 3: Screenshot Memento (Evrensel Fallback)
# ─────────────────────────────────────────────────────────────────────────────

async def _screenshot_capture(adb, serial: str, package: str) -> dict | None:
    """Ekran görüntüsü alır ve base64 olarak döndürür (evrensel fallback)."""
    try:
        remote_path = f"/sdcard/odx_continuity_{package.replace('.', '_')}.png"
        await adb.shell(f"screencap -p {remote_path}", serial=serial, timeout_s=3.0)
        log.info("📷 [CONTINUITY/Screenshot] %s → %s", package, remote_path)
        return {"remote_path": remote_path, "package": package}
    except Exception as exc:
        log.debug("[CONTINUITY/Screenshot] Capture hatası (%s): %s", package, exc)
    return None


# ─────────────────────────────────────────────────────────────────────────────
# Evrensel API — window_manager.py tarafından kullanılır
# ─────────────────────────────────────────────────────────────────────────────

def _classify_package(package: str) -> str:
    """Paketi CDP, WebView veya native olarak sınıflandırır."""
    if package in _CHROMIUM_PACKAGES:
        return "cdp"
    if package in _WEBVIEW_PACKAGES:
        return "webview"
    return "native"


async def capture_app_state(adb, serial: str, package: str) -> AppState:
    """
    Uygulamanın mevcut UI state'ini yakalar.

    Katman önceliği (package tipine göre uyarlanır):
      1. CDP (Chrome & Chromium WebView)
      2. UIAutomator (native & tüm uygulamalar)
      3. Screenshot (her zaman çalışan evrensel fallback)

    Hiçbir zaman exception fırlatmaz — en kötü ihtimalle
    ``AppState(layer=NONE)`` döndürür.
    """
    pkg_type = _classify_package(package)
    state = AppState(package=package)

    # ── Katman 1: CDP ────────────────────────────────────────────────────────
    if pkg_type in ("cdp", "webview"):
        try:
            data = await _cdp_capture(adb, serial, package)
            if data:
                state.layer = ContinuityLayer.CDP
                state.data = data
                log.info("✅ [CONTINUITY] %s → CDP katmanı başarılı", package)
                return state
        except Exception as exc:
            log.debug("[CONTINUITY] CDP layer exception (%s): %s", package, exc)

    # ── Katman 2: UIAutomator ────────────────────────────────────────────────
    try:
        data = await _uiautomator_capture(adb, serial, package)
        if data:
            state.layer = ContinuityLayer.UIAUTOMATOR
            state.data = data
            log.info("✅ [CONTINUITY] %s → UIAutomator katmanı başarılı", package)
            return state
    except Exception as exc:
        log.debug("[CONTINUITY] UIAutomator layer exception (%s): %s", package, exc)

    # ── Katman 3: Screenshot ─────────────────────────────────────────────────
    try:
        data = await _screenshot_capture(adb, serial, package)
        if data:
            state.layer = ContinuityLayer.SCREENSHOT
            state.data = data
            log.info("✅ [CONTINUITY] %s → Screenshot katmanı başarılı", package)
            return state
    except Exception as exc:
        log.debug("[CONTINUITY] Screenshot layer exception (%s): %s", package, exc)

    log.debug("[CONTINUITY] %s → Hiçbir katman state yakalayamadı", package)
    return state


async def restore_app_state(
    adb,
    serial: str,
    package: str,
    state: AppState,
    *,
    target_display_w: int = 0,
    target_display_h: int = 0,
) -> bool:
    """
    Daha önce yakalanmış UI state'i geri yükler.

    Parametreler
    ------------
    target_display_w / target_display_h:
        Hedef sanal display'in genişlik/yüksekliği (fiziksel piksel).
        UIAutomator katmanında swipe koordinatlarını normalize etmek için
        kullanılır — touch pipeline'daki gibi kaynak → hedef ölçekleme.
        CDP katmanında bu değerlere gerek yoktur: JS kendi ``devicePixelRatio``
        değerini okuyarak normalize eder.

    Katman uyumu: state hangi katmanla yakalandıysa o katmanla geri yüklenir.
    Screenshot katmanı UI restore yapamaz; yalnızca görsel memanyo olarak
    event sistemi üzerinden frontend'e iletilebilir.
    """
    if not state or not state.is_valid():
        return False

    if state.layer == ContinuityLayer.CDP:
        ws_url = state.data.get("ws_url")
        if ws_url:
            return await _cdp_restore(ws_url, state.data)

    elif state.layer == ContinuityLayer.UIAUTOMATOR:
        return await _uiautomator_restore(
            adb, serial, package, state.data,
            target_w=target_display_w,
            target_h=target_display_h,
        )

    elif state.layer == ContinuityLayer.SCREENSHOT:
        log.debug("[CONTINUITY/Screenshot] %s → Restore edilemez, yalnızca görsel bellek", package)

    return False
