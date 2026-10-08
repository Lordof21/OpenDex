"""Zero-Blink Task Migration, AppLock Coordinator & 2-Stage Stealth DPI Manager.

Split out of window_manager.py's ``_open_window_locked`` — runs as a
fire-and-forget background task right after a freshly opened (non-mirror)
window's virtual display comes up, and:

  1. Waits for the real (non-zero) virtual display id to appear.
  2. Detects an Android OEM AppLock intercept (Xiaomi HyperOS, Samsung Knox
     etc.) and, if present, waits (up to 15s) for the user to unlock on the
     physical phone before continuing.
  3. Migrates the app's existing task from Display 0 onto the new virtual
     display (or lets a cold start settle) — capturing/restoring UI
     continuity state around the move.
  4. Applies phase 2 of Stealth DPI (physical -> target density) once the
     task has landed.
  5. Emits vd_phase="live" so the frontend drops its "optimizing" overlay.

Never raises — any failure is logged and, if Stealth DPI was in flight,
still emits vd_phase="live" so the frontend overlay does not hang forever.
"""
from __future__ import annotations

import asyncio
import contextlib
import logging
from typing import TYPE_CHECKING, Any, Callable

from ..device import android_shell, device_queries
from ..device.adb import Adb
from ..events import EventBus
from .scrcpy_launcher import ScrcpyServer, ScrcpySockets, serialize_start_app
from .display_ids import is_virtual_display_id
from .task_movement import move_task_to_display
from .task_windowing import land_fullscreen

if TYPE_CHECKING:
    from .window_manager import WindowSession

log = logging.getLogger(__name__)


def classify_focus(curr_focus: str, pkg_name: str) -> str:
    """Odaktaki pencereye bakarak kilit durumunu sınıflar.

    * ``"locked"``   — OEM kilit/kimlik doğrulama ekranı odakta (kullanıcı hâlâ kilidi açmaya çalışıyor).
    * ``"unlocked"`` — kilit ekranı YOK **ve hedef uygulama odakta** (gerçekten açıldı).
    * ``"other"``    — kilit ekranı yok AMA hedef uygulama da odakta değil (ana ekran, başka uygulama…).

    Eskiden başarı ölçütü yalnızca "odakta kilit ekranı yok"tu: kilidi jestle İPTAL etmek (ana ekrana
    çıkmak) ya da pencereyi kapatmak da "kilit açıldı" sayılıp yanlış bildirim üretiyordu.
    """
    if android_shell.is_app_lock(curr_focus):
        return "locked"
    if pkg_name and pkg_name in curr_focus:
        return "unlocked"
    return "other"


def applock_alive_probe(sessions: dict[str, "WindowSession"], win_id: str) -> Callable[[], bool]:
    """Bekleyicinin "hâlâ geçerli miyim?" sorusu: pencere kapanmadıysa VE bu bekleyiciden sonra yeni bir
    "Tekrar dene" başlatılmadıysa True. Çağrıldığı andaki ``applock_gen``'i yakalar."""
    session = sessions.get(win_id)
    gen = getattr(session, "applock_gen", 0)

    def _alive() -> bool:
        cur = sessions.get(win_id)
        return cur is not None and cur is session and getattr(cur, "applock_gen", 0) == gen

    return _alive


async def wait_for_app_lock_unlock(
    *,
    adb: Adb,
    events: EventBus,
    serial: str,
    sockets: ScrcpySockets | None,
    wlog: logging.LoggerAdapter,
    pkg_name: str,
    win_id: str,
    disp_id: str,
    p1_dpi: int,
    daemon: Any = None,
    timeout_s: float = 15.0,
    is_alive: Callable[[], bool] | None = None,
    fresh: bool = False,
) -> bool:
    """Wakes the phone, launches the app on Display 0 so AppLock owns the screen, then watches
    (up to ``timeout_s``) what the user does on the physical phone. Sonuç bir DURUM MAKİNESİdir:

    ==========  ===============================================  ==========================
    Odak        Anlamı                                           Sonuç
    ==========  ===============================================  ==========================
    kilit ekranı  kullanıcı hâlâ kilidi açmaya çalışıyor           beklemeye devam
    hedef uygulama kilit açıldı                                    ``app_lock_resolved``
    başka (ana ekran…) kilit iptal edildi (jest / geri)            ``app_lock_cancelled``
    —           pencere kapandı / yeni "Tekrar dene" başladı       SESSİZ çıkış (bildirim YOK)
    —           süre doldu                                         ``app_lock_timeout``
    ==========  ===============================================  ==========================

    ``fresh=True`` ("Tekrar dene"): uygulama önce ZORLA DURDURULUR. Kilidi jestle iptal ettiyseniz görev
    telefonda arka planda yaşar; yeniden başlatma niyeti onu OEM kilidi TETİKLEMEDEN öne alabilir. Taze
    (soğuk) başlatma kilit sorusunu garanti eder — "pencereyi kapat-aç"ın işe yaramasının nedeni bu.

    ``is_alive``: pencere kapanınca / yeni deneme başlayınca False döner; bekleyici hiçbir bildirim
    yayınlamadan çıkar (kapanmış pencere için "kilit açıldı" denmesin).

    Returns True yalnızca kilit gerçekten açıldıysa. Shared by the initial AppLock detection AND by
    ``WindowManager.retry_app_lock()`` (AppLockOverlay "Tekrar Dene").
    """
    from app.device.deep_navigator import find_task_id_for_package

    alive = is_alive or (lambda: True)
    loop = asyncio.get_event_loop()

    with contextlib.suppress(Exception):
        await adb.shell("input keyevent KEYCODE_WAKEUP", serial=serial, timeout_s=1.0)

    if fresh:
        wlog.info("🔁 [KİLİT: YENİDEN İSTE] %s zorla durduruluyor; taze başlatma kilit sorusunu yeniden tetikler", pkg_name)
        with contextlib.suppress(Exception):
            await adb.shell(f"am force-stop {pkg_name}", serial=serial, timeout_s=2.0)
        await asyncio.sleep(0.4)
        if not alive():
            return False

    await events.emit(
        "app_lock_pending",
        package=pkg_name,
        window_id=win_id,
        display_id=str(disp_id),
        message="Uygulama Kilitli: Lütfen telefonunuzdan parmak izinizi okutun veya şifrenizi girin.",
    )

    # (Re)launch on Display 0 so AppLock definitely owns Display 0
    with contextlib.suppress(Exception):
        await adb.shell(f"monkey -p {pkg_name} -c android.intent.category.LAUNCHER 1", serial=serial, timeout_s=2.0)

    outcome = "timeout"
    seen_locked = False
    other_streak = 0
    last_state: str | None = None
    start_time = loop.time()
    while (loop.time() - start_time) < timeout_s:
        if not alive():
            wlog.info("ℹ️ [KİLİT: DURDURULDU] %s penceresi kapandı ya da yeni deneme başladı — bildirim yok", pkg_name)
            return False

        # Hızlı yol YALNIZCA uyandırma ipucu: karar her zaman odak denetiminden çıkar (olay tek başına
        # "açıldı" DEMEZ — uygulama kilitten ÖNCE kısa süre odak alabilir).
        with contextlib.suppress(asyncio.TimeoutError):
            await events.wait_for(
                "device_task_focused",
                predicate=lambda d: d.get("package") == pkg_name,
                timeout=0.5,
            )
        if not alive():
            return False

        curr_focus = await device_queries.focus_text(adb, serial, timeout_s=1.5)
        if not (curr_focus or "").strip():
            continue  # okuma başarısız/boş: karar verme
        state = classify_focus(curr_focus, pkg_name)
        wlog.debug("[KİLİT: YOKLAMA] %s odak=%s durum=%s", pkg_name, curr_focus.strip()[:120], state)
        if state != last_state:
            wlog.info(
                "[KİLİT: DURUM] %s %s → %s (%.1f sn, odak=%s)",
                pkg_name, last_state or "başlangıç", state, loop.time() - start_time, curr_focus.strip()[:100],
            )
            last_state = state

        if state == "locked":
            seen_locked = True
            other_streak = 0
            continue
        if state == "unlocked":
            outcome = "unlocked"
            break
        # "other": kilit ekranı gitti ama uygulama da yok. Geçici geçişleri (biyometrik sonrası) elemek için
        # art arda 3 yoklama ve (kilit görüldüyse VEYA 4 sn geçtiyse) iptal say.
        other_streak += 1
        if other_streak >= 3 and (seen_locked or (loop.time() - start_time) > 4.0):
            outcome = "cancelled"
            break

    if not alive():
        return False

    if outcome == "unlocked":
        target_task_id = await find_task_id_for_package(adb, pkg_name, display_id="0", serial=serial)
        if not target_task_id:
            target_task_id = await find_task_id_for_package(adb, pkg_name, serial=serial)
        if target_task_id:
            wlog.info("🔓 [KİLİT AÇILDI!] %s için Task %s Display 0'dan Display %s'ye taşınıyor (@ %d DPI)", pkg_name, target_task_id, disp_id, p1_dpi)
            with contextlib.suppress(Exception):
                await move_task_to_display(adb, target_task_id, disp_id, serial=serial, daemon=daemon)
            # It may arrive with the mode it requested on the phone (freeform): fullscreen on a VD window's display.
            await land_fullscreen(adb, serial, pkg_name, disp_id, task_id=target_task_id, daemon=daemon, wlog=wlog)
            with contextlib.suppress(Exception):
                await android_shell.bring_to_front(adb, serial, pkg_name, disp_id)
        else:
            wlog.info("🔓 [KİLİT AÇILDI!] %s kilit ekranı aşıldı, Display %s üzerinde öne çıkarılıyor", pkg_name, disp_id)
            with contextlib.suppress(Exception):
                await android_shell.bring_to_front(adb, serial, pkg_name, disp_id)

        if sockets and sockets.control:
            with contextlib.suppress(Exception):
                await sockets.control.send(serialize_start_app(pkg_name))

        if not alive():
            return False
        await events.emit("app_lock_resolved", package=pkg_name, window_id=win_id, display_id=str(disp_id))
        await asyncio.sleep(0.3)
        return True

    if outcome == "cancelled":
        wlog.info("🚫 [KİLİT İPTAL EDİLDİ] %s için kilit ekranı kapatıldı ama uygulama açılmadı (jest/ana ekran)", pkg_name)
        await events.emit(
            "app_lock_cancelled", package=pkg_name, window_id=win_id, display_id=str(disp_id),
            message='Kilit iptal edildi. Uygulamayı açmak için "Tekrar Dene"ye basın — kilit yeniden sorulacak.',
        )
        return False

    wlog.info("⏳ [KİLİT ZAMAN AŞIMI] %s için kilit açılmadı.", pkg_name)
    await events.emit("app_lock_timeout", package=pkg_name, window_id=win_id, display_id=str(disp_id), message="Kilit açma zaman aşımına uğradı.")
    return False


async def coordinate_window_lifecycle(
    *,
    adb: Adb,
    events: EventBus,
    sessions: dict[str, "WindowSession"],
    serial: str,
    sockets: ScrcpySockets,
    wlog: logging.LoggerAdapter,
    pkg_name: str,
    target_server: ScrcpyServer,
    win_id: str,
    p1_dpi: int,
    p2_dpi: int,
    stealth_active: bool,
    auto_start: bool,
    daemon: Any = None,
    lock: asyncio.Lock | None = None,
    density: Any = None,
    density_before: Any = None,
) -> None:
    try:
        # The server reports its display id in its own log ("New display: …(id=N)"); the daemon's display_added event
        # is the second source for a late line (single candidate only). Never a guess from `dumpsys display`.
        disp_id = await target_server.wait_for_display_id()

        sess = sessions.get(win_id)
        if sess and disp_id:
            sess.state.display_id = str(disp_id)

        if not is_virtual_display_id(disp_id):
            wlog.error("❌ [STEALTH DPI HATA] display_id 3.75s içinde tespit edilemedi! Faz 2 (DPI %d) uygulanamıyor.", p2_dpi)
            if stealth_active:
                await events.emit("vd_phase", window_id=win_id, package=pkg_name, phase="live", target_dpi=p2_dpi)
            return

        wlog.info("🎯 [STEALTH DPI] display_id=%s tespit edildi (Faz 1 DPI=%d, Hedef Faz 2 DPI=%d)", disp_id, p1_dpi, p2_dpi)

        from app.device.deep_navigator import find_task_id_for_package

        # Yoğunluk uzlaştırma için: yoğunluğu değiştiren SON adımdan hemen önceki cihaz saati (density_reconciler.mark).
        # Uygulamanın bundan sonra kendini yeniden kurması "uyum sağladı" kanıtıdır.
        warm = density is not None and getattr(density_before, "identity", None) is not None
        changed_at: float | None = None

        task_id: str | None = None
        # 1. Check if Android OEM AppLock intercepted the launch
        if auto_start:
            is_app_lock = False
            for _ in range(3):
                focus_raw = await device_queries.focus_text(adb, serial, timeout_s=1.5)
                if android_shell.is_app_lock(focus_raw):
                    is_app_lock = True
                    break
                await asyncio.sleep(0.15)

            if is_app_lock:
                wlog.info("🔒 [UYGULAMA KİLİDİ DEVREDE] %s için AppLock algılandı. PC ekranı ve telefon uyarılıyor...", pkg_name)
                if warm:
                    changed_at = await density.mark()  # the move onto the window happens inside, after the unlock
                await wait_for_app_lock_unlock(
                    adb=adb,
                    events=events,
                    serial=serial,
                    sockets=sockets,
                    wlog=wlog,
                    pkg_name=pkg_name,
                    win_id=win_id,
                    disp_id=str(disp_id),
                    p1_dpi=p1_dpi,
                    daemon=daemon,
                    is_alive=applock_alive_probe(sessions, win_id),
                )
            else:
                task_id = await find_task_id_for_package(adb, pkg_name, display_id="0", serial=serial)
                if task_id:
                    wlog.info("🚚 [PENCERE GÖREV IŞINLAMA] %s için Task %s Display 0'dan Display %s'ye taşınıyor (@ %d DPI)", pkg_name, task_id, disp_id, p1_dpi)
                    if warm:
                        changed_at = await density.mark()
                    with contextlib.suppress(Exception):
                        await move_task_to_display(adb, task_id, disp_id, serial=serial, daemon=daemon)
                    # Telefonda serbest pencere olarak açılmış görev aynı kipi taşır: VD penceresinde tam ekran olmalı.
                    await land_fullscreen(adb, serial, pkg_name, disp_id, task_id=task_id, daemon=daemon, wlog=wlog)
                    # Sanal display üzerinde görevi öne çıkar ve resume ettir
                    with contextlib.suppress(Exception):
                        await android_shell.bring_to_front(adb, serial, pkg_name, disp_id)
                    # Display 0 ve sanal display aynı DPI'da (520 DPI) olduğundan Chrome reflow ve scroll kaybı yaşamaz
                    await asyncio.sleep(0.4)
                else:
                    # Cold start: uygulamanın ayağa kalkması için kısa bir süre
                    await asyncio.sleep(0.3)
        else:
            await asyncio.sleep(0.3)

        # 2. Phase 2: Stealth DPI Geçişi (fiziksel DPI -> hedef DPI) — pencere yaşam döngüsü kilidi altında. Arada bir
        # resize (açılışın hemen ardından gelen otomatik resize) yoğunluğu devraldıysa — canlı DPI yazdı ya da VD'yi
        # yeniden kurdu — açılış anındaki hedefle ÜSTÜNE YAZILMAZ.
        if stealth_active and p1_dpi != p2_dpi:
            async with lock or contextlib.nullcontext():
                sess = sessions.get(win_id)
                if sess is not None and sess.server is target_server and sess.dpi == p2_dpi:
                    wlog.info("🎯 [STEALTH DPI PHASE 2] Display %s geçişi uygulanıyor: %d DPI -> %d DPI", disp_id, p1_dpi, p2_dpi)
                    if warm:
                        # The move above happened at the phone's density (a size-only change a relaunch may already have
                        # answered under 520): the density change the app must adapt to is THIS write.
                        changed_at = await density.mark()
                    try:
                        path = await android_shell.set_display_density(adb, serial, disp_id, p2_dpi, daemon=daemon)
                        wlog.info("🎯 [STEALTH DPI PHASE 2] Display %s -> %d DPI uygulandı (%s)", disp_id, p2_dpi, path)
                    except Exception as exc:
                        wlog.error("❌ [STEALTH DPI PHASE 2] density uygulanamadı: %s", exc, exc_info=True)
                elif sess is not None:
                    wlog.info("🎯 [STEALTH DPI PHASE 2] atlandı: yoğunluğu arada bir resize devraldı (dpi=%d)", sess.dpi)
                if sess is not None:
                    sess.state.stealth_phase = False
            await asyncio.sleep(0.3)

        # 3. Yoğunluk uzlaştırma (density_reconciler.py). Açılıştan ÖNCE canlı bir uygulama süreci vardıysa o süreç telefonun
        #    yoğunluğunda doğmuştur ve az önce pencerenin yoğunluğuna taşındı. Chrome bunu kendisi karşılar, YouTube gibi
        #    uygulamalar arayüzünü doğum yoğunluğunda dondurur; ikisi manifest'ten ayırt edilemez. Süreç kimliği aynıysa
        #    (arada yeniden doğmadıysa) durum korunarak yeniden başlatılır ve kimliğin gerçekten değiştiği DOĞRULANIR.
        #    Kaplama (vd_phase) bu süre boyunca açık kalır: kullanıcı yarım yenilenmiş bir uygulama görmez.
        if warm:
            try:
                process_dpi = p1_dpi if stealth_active else await android_shell.phone_density(adb, serial)
                if process_dpi != p2_dpi:  # unread (None) counts as a change: the reconciler verifies the adaptation
                    outcome = await density.settle(
                        pkg_name, before=density_before, display=str(disp_id), reason="open", changed_at=changed_at,
                    )
                    wlog.info("🔄 [DENSITY] %s: %s → %d DPI uzlaştırma sonucu = %s%s", pkg_name, process_dpi or "?", p2_dpi,
                              outcome.action, f" ({outcome.detail})" if outcome.detail else "")
            except Exception as exc:  # noqa: BLE001 — uzlaştırma hatası pencere açılışını asla bozmaz
                wlog.warning("⚠️ [DENSITY] %s uzlaştırma hatası: %s", pkg_name, exc)

        # 4. Live fazına geçiş bildirimi
        if stealth_active:
            wlog.info("✨ [STEALTH DPI TAMAMLANDI] %s penceresi 'live' fazına geçirildi (DPI=%d)", pkg_name, p2_dpi)
            await events.emit(
                "vd_phase",
                window_id=win_id,
                package=pkg_name,
                phase="live",
                final_dpi=p2_dpi,
                physical_dpi=p1_dpi,
            )
    except Exception as exc:
        wlog.error("❌ [STEALTH COORDINATION KRİTİK HATA] %s: %s", pkg_name, exc, exc_info=True)
        if stealth_active:
            with contextlib.suppress(Exception):
                await events.emit("vd_phase", window_id=win_id, package=pkg_name, phase="live", target_dpi=p2_dpi)
