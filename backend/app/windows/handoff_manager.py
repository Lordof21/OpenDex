"""PC ⟷ phone continuity: handoff, reclaim, and the background focus watchdog
(Karar: Display Migration Continuity).

Split out of window_manager.py's "continuity, handoff & reclaim" section.
Owns no session lifecycle of its own — it reads/mutates the SAME
``WindowSession`` dict WindowManager owns (passed in by reference, never
copied) and defers back into WindowManager for two things outside its scope:
the currently-bound device serial (``serial_getter`` — WindowManager's own
``self._serial`` can change across a device switch, so this is read fresh on
every call rather than captured once at construction) and unfreezing a
session whose encoder has actually stopped (``unfreeze_locked``).

Callers (WindowManager.handoff_window_to_phone / reclaim_window) are
responsible for holding the device-wide lifecycle lock for the duration of
these calls, same as every other ``_locked``-suffixed WindowManager operation.
"""
from __future__ import annotations

import asyncio
import contextlib
import logging
import time
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any, Awaitable, Callable

from ..config import Settings
from ..device import android_shell, device_queries
from ..device.adb import Adb
from ..events import EventBus, spawn_background
from ..logging_config import window_logger
from ..telemetry import markers as load_markers
from .cdp_refresher import (
    capture_browser_scroll_state,
    refresh_browser_layout_inplace,
    start_browser_auto_attach_watcher,
    start_window_watcher,
    stop_browser_auto_attach_watcher,
)
from .display_ids import is_virtual_display_id, known_display_id
from .mirror_packages import is_internal_package, is_launcher_package, is_mirror_package
from .playback_continuity import PlaybackContinuity
from .density_reconciler import DISABLED, KEPT_PLAYING, NO_PROCESS
from .task_movement import move_task_to_display
from .task_windowing import land_fullscreen, read_task_windowing, settle_task_windowing
from .web_inspector import inspect_app_runtime

if TYPE_CHECKING:
    from .window_manager import WindowSession

log = logging.getLogger(__name__)

# Karar (gerçek cihaz logu, 2026-09-30): telefon ⟷ PC geçişinde yoğunluk artık
# BÖLÜNMEZ. Eski "Reverse/Stealth DPI" sanal ekranı önce telefonun DPI'ına (520) çekip görevi taşıyor, sonra hedefe
# indiriyordu. Taşıma ekran boyutunu da değiştirdiği için Android birçok uygulamayı (YouTube) 520'de yeniden kuruyor,
# ardından gelen 520→200 değişimini uygulama yeniden kurulmadan yaşıyordu: telefondan geri alınan pencere "büyük DPI"
# ile kalıyordu. Şimdi sanal ekran HEP pencerenin yoğunluğunda durur; taşıma boyut + yoğunluk değişimini TEK adımda
# taşır ve uygulama (kendisi ya da Android) bunu tek bir yeniden kurmayla karşılar. Kanıtlanamazsa
# density_reconciler.py bir kez, doğrulanmış olarak yeniler. App Continuity kodu (app_continuity.py) olduğu gibi duruyor.
#
# İSTİSNA — PC'den "Telefona Aktar" (kaynak="pc"): yoğunluk telefona geçerken uygulamanın yaşayacağı bir yeniden kurma
# kaçınılmazdır (YouTube gibi uygulamalar arayüzünü doğum yoğunluğunda dondurur). Bunu telefonda, kullanıcının gözü önünde
# yaşatmak yerine ÖN-İNİŞ yapılır: sanal ekran PC perdesinin arkasında telefonun yoğunluğuna çekilir, uygulama orada
# uzlaştırılır (kendini kurdu / yerinde yeniden kuruldu / doğrulanmış süreç yeniden başlatma) ve görev ANCAK ondan sonra
# taşınır; taşıma yoğunluk-nötr olur. Ters yönde (reclaim) hâlâ tek adım: orada kullanıcı zaten PC penceresine bakıyor.

# İSTİSNA'NIN GENİŞLEMESİ — ön-iniş yalnız yoğunluğu değil, sanal ekranın BOYUTUNU da telefonunkine çeker. Yoğunluk telefona
# oturmuş ama ekran hâlâ DeX boyutunda (ör. 1920×1080 yatay) iken taşınan uygulama, telefonun dikey/dar ekranına ilk karede
# yanlış düzenle (tablet/yatay yerleşim, letterbox) iner ve kendini yeniden kuramayanlar öyle kalır. Telefonun W×H px + DPI'ı
# önce sanal ekranda, PC perdesinin arkasında oturur (tek atomik OPENDEX_RESIZE); görev ANCAK ondan sonra taşınır.
# Pencerenin kendi geometrisi `session.landing` defterinde durur ve geri alınırken (reclaim), görev dönmeden ÖNCE, hâlâ boş
# olan ekrana geri yazılır.


@dataclass(frozen=True, slots=True)
class Geometry:
    """A virtual display's size (Android px) and density."""

    width: int
    height: int
    dpi: int


@dataclass(frozen=True, slots=True)
class Landing:
    """A pre-landing that resized a window's display: ``window`` is what the PC window needs (restored on reclaim),
    ``landed`` what the display was given (the phone's own geometry)."""

    window: Geometry
    landed: Geometry


# Pre-landing outcomes after which the app was NOT rebuilt: no new first frame to wait for.
_NOT_REBUILT = (KEPT_PLAYING, DISABLED, NO_PROCESS)


def _fits_display(bounds: tuple[int, int, int, int], size: tuple[int, int], tolerance: float = 0.06) -> bool:
    """A task box fills a display of ``size`` (orientation aside): a window's insets are not the display's size."""
    bw, bh = sorted((bounds[2] - bounds[0], bounds[3] - bounds[1]))
    dw, dh = sorted(size)
    return abs(bw - dw) <= dw * tolerance and abs(bh - dh) <= dh * tolerance


# Legacy helper for tests / fast-path; actual handoff uses dynamic web_inspector.inspect_app_runtime
def is_web_rendered_app(package: str | None) -> bool:
    """True if the package name indicates a web browser (fallback check)."""
    if not package:
        return False
    pkg = package.lower()
    return any(name in pkg for name in ("chrome", "browser", "firefox", "chromium"))


class HandoffManager:
    def __init__(
        self,
        adb: Adb,
        settings: Settings,
        events: EventBus,
        sessions: dict[str, "WindowSession"],
        *,
        serial_getter: Callable[[], str | None],
        unfreeze_locked: Callable[[str], Awaitable[None]],
        daemon_client_getter: Callable[[], Any] | None = None,
        on_eco_member_on_phone: Callable[[str], None] | None = None,
        lock: asyncio.Lock | None = None,
        density: Any = None,
        resize_display: Callable[..., Awaitable[bool]] | None = None,
    ) -> None:
        self._adb = adb
        self._settings = settings
        self._events = events
        # density_reconciler.DensityReconciler: decides (and verifies) whether the app's PROCESS has to be reborn after
        # the density it lives under changed. None in tests that don't care.
        self._density = density
        # async (window_id, width, height, dpi, *, in_place_only) -> bool: resizes the window's virtual display (size and
        # density in ONE step) under the lock the caller already holds. False: it could not be done (nothing changed).
        # None in tests that don't care: the pre-landing then settles the density only, as it always did.
        self._resize_display = resize_display
        # SAME dict WindowManager owns — never copied, so a session opened,
        # closed, frozen or unfrozen after construction is seen here too.
        self._sessions = sessions
        self._serial_getter = serial_getter
        self._unfreeze_locked = unfreeze_locked
        self._daemon_client_getter = daemon_client_getter or (lambda: None)
        # A video that was playing when the app crossed displays is resumed where it stopped (playback_continuity.py).
        self._playback = PlaybackContinuity(
            lambda: self._daemon_client_getter() if callable(self._daemon_client_getter) else None,
            enabled=settings.PLAYBACK_CONTINUITY,
            deep_link=settings.PLAYBACK_DEEP_LINK,
        )
        # Eco Workspace üyeleri bu sınıfın handoff↔reclaim döngüsüne GİRMEZ: task'ları
        # paylaşımlı VD'de yaşar, defter kaydı EcoWorkspaceManager'dadır. Telefonda
        # göründüklerinde (Display 0 odak olayı / watchdog) yapılacak tek şey WindowManager'ın
        # kilit altında `TaskTeleporter.workspace_to_phone(already_on_phone=True)` çalıştırmasıdır
        #. Sync, fire-and-forget çağrı.
        self._on_eco_member_on_phone = on_eco_member_on_phone
        # WindowManager's lifecycle lock: work started from events (focus / watchdog) runs under it, like every
        # request-driven operation — never interleaved with a close/resize/reclaim.
        self._lock = lock
        # owner -> monotonic deadline (None: until released). Held by WindowManager while it deliberately moves apps (a
        # transport switch, a link-drop heal): what the watchdog / focus events / pump ends see then is OUR move, not
        # the user handing an app off. Per-owner so one owner letting go never lifts another's hold.
        self._holds: dict[str, float | None] = {}
        # Pencere bazında aktif geçiş kilidi (art arda hızlı geçişlerde race-condition koruması)
        self._active_transitions: set[str] = set()
        self._events.on("device_task_focused", self._on_device_task_focused)

    def hold(self, owner: str, *, lease_s: float | None = None) -> None:
        """Suspends handoff detection for `owner`. A hold that depends on someone else to release it (a link drop, lifted
        by its heal) takes a lease: it lapses by itself, so a heal that never comes cannot leave detection off."""
        self._holds[owner] = None if lease_s is None else time.monotonic() + lease_s

    def release(self, owner: str) -> None:
        self._holds.pop(owner, None)

    @property
    def paused(self) -> bool:
        now = time.monotonic()
        for owner, deadline in list(self._holds.items()):
            if deadline is not None and deadline <= now:
                del self._holds[owner]
        return any(not owner.startswith("pkg_") for owner in self._holds)

    def is_package_held(self, package: str) -> bool:
        """True if handoff detection is paused globally or specifically for `package`."""
        now = time.monotonic()
        for owner, deadline in list(self._holds.items()):
            if deadline is not None and deadline <= now:
                del self._holds[owner]
                continue
            if not owner.startswith("pkg_") or owner == f"pkg_{package}":
                return True
        return False

    def _locked(self):
        return self._lock if self._lock is not None else contextlib.nullcontext()

    @staticmethod
    def _resolve_display_id(session: "WindowSession") -> str | None:
        """The window's virtual display as reported by its own scrcpy server — never guessed (see display_ids.py)."""
        return known_display_id(session)

    async def _set_density(self, disp_id: str | int | None, density: int, serial: str) -> bool:
        """True = the display now carries `density` (callers that must not act on a write that failed read it)."""
        if not is_virtual_display_id(disp_id):
            log.warning("⚠️ [VD DENSITY] Geçersiz disp_id=%s, density=%d uygulanamadı!", disp_id, density)
            return False
        try:
            path = await android_shell.set_display_density(
                self._adb, serial, disp_id, density, daemon=self._daemon_client_getter(),
            )
            log.info("🎯 [VD DENSITY] disp=%s dpi=%d uygulandı (%s)", disp_id, density, path)
            return True
        except Exception as exc:
            log.error("❌ [VD DENSITY HATASI] disp=%s dpi=%d: %s", disp_id, density, exc, exc_info=True)
            return False

    @property
    def playback(self) -> PlaybackContinuity:
        """The playback continuity this manager resumes a crossed app with (shared: the window open uses it too)."""
        return self._playback

    async def _density_bracket_open(
        self, pkg: str, from_dpi: int | None, to_dpi: int | None, *, lookback_s: float = 0.0,
    ) -> tuple[Any, float | None]:
        """(process snapshot, device-clock mark) taken right BEFORE the step that moves the app from ``from_dpi`` to
        ``to_dpi`` — (None, None) when the density provably does not change or there is no reconciler
        (density_reconciler.py). An unknown side (None: the phone's density could not be read) counts as a change: the
        reconciler then verifies whether the app really adapted instead of the bracket assuming it did."""
        if self._density is None or (from_dpi and to_dpi and from_dpi == to_dpi):
            return None, None
        before = await self._density.snapshot(pkg)
        return before, await self._density.mark(lookback_s=lookback_s)

    # Ön-iniş bütçesi: nazik yeniden kurma (~2-4 sn) ya da doğrulanmış süreç yeniden başlatma (~6-8 sn) buraya sığar. Aşılırsa
    # taşıma yine yapılır ve taşıma-sonrası uzlaştırma (aşağıda) işi bitirir. Arayüz perdesinin süresi buna bağlıdır.
    _PRELANDING_BUDGET_S = 9.0
    _PRELANDING_VEIL_MARGIN_S = 4.0
    # Ekranın yeniden boyutlandırılması (sunucu onayı en çok FLEX_RESIZE_TIMEOUT_S) + uygulamanın yeni boyuta yerleşmesi.
    _SIZE_LANDING_BUDGET_S = 5.0
    _GEOMETRY_WAIT_S = 1.5
    _GEOMETRY_POLL_S = 0.12

    @staticmethod
    def _window_geometry(session: "WindowSession") -> Geometry:
        """What the PC window needs of its display: the geometry from BEFORE a pre-landing when one is still in force."""
        current = Geometry(session.target_display_w, session.target_display_h, session.dpi)
        landing = session.landing
        # A display the user resized since is no longer the pre-landing's: what it has now is what the window asked for.
        return landing.window if landing is not None and current == landing.landed else current

    @staticmethod
    def _landing_size_needed(session: "WindowSession", phone_size: tuple[int, int] | None) -> bool:
        return phone_size is not None and (session.target_display_w, session.target_display_h) != tuple(phone_size)

    async def _prelanding_wanted(
        self, session: "WindowSession", pkg: str, disp_id: str | None, task_id: str | int | None,
        window_dpi: int, phys_dpi: int | None, phone_size: tuple[int, int] | None, source: str,
    ) -> bool:
        """Only the PC-initiated handoff of a live app on a real window: elsewhere there is no PC window to hide the
        rebuild behind (the app already stands on the phone) or nothing to reconcile. Wanted when the display differs
        from the phone in Target DP (Smallest Width dp), density, OR size."""
        if source != "pc" or not task_id or not is_virtual_display_id(disp_id):
            return False
        if not phys_dpi:
            return False  # an unread phone density is never guessed: no pre-landing, the post-move settle covers it

        tw = getattr(session, "target_display_w", None)
        th = getattr(session, "target_display_h", None)
        if isinstance(tw, (int, float)) and isinstance(th, (int, float)):
            short_side = min(tw, th)
        elif hasattr(session, "state") and isinstance(getattr(session.state, "width", None), (int, float)):
            short_side = min(session.state.width, session.state.height)
        else:
            short_side = 720

        pw = phone_size[0] if (phone_size and len(phone_size) > 0 and isinstance(phone_size[0], (int, float))) else None
        phone_dp = round(pw * 160 / phys_dpi) if (pw and phys_dpi) else 360
        window_dp = round(short_side * 160 / (window_dpi or 160))

        needs_dpi = self._density is not None and window_dpi > 0 and window_dpi != phys_dpi
        needs_dp = abs(window_dp - phone_dp) > 16
        needs_size = self._resize_display is not None and self._landing_size_needed(session, phone_size)

        log.debug(
            "[HANDOFF:DP_EVAL] pkg=%s window_dp=%ddp vs phone_dp=%ddp (needs_dp=%s, needs_dpi=%s, needs_size=%s)",
            pkg, window_dp, phone_dp, needs_dp, needs_dpi, needs_size,
        )

        if not (needs_dpi or needs_dp or needs_size):
            return False
        state = session.state
        if state.workspace_id is not None or state.frozen or not session.server.is_alive:
            return False
        if is_internal_package(pkg) or is_mirror_package(pkg) or is_launcher_package(pkg):
            return False
        try:
            from app.storage import settings_db

            project = await settings_db.get_project_settings()
            return bool(getattr(project, "handoff_prelanding", True)) and bool(getattr(project, "density_refresh_enabled", True))
        except Exception:  # noqa: BLE001 — an unreadable DB means the defaults: on
            return True

    async def _land_size(
        self, session: "WindowSession", phone_size: tuple[int, int], phys_dpi: int, wlog: logging.Logger,
    ) -> bool:
        """Resizes the window's display to the phone's size AND density in one step and notes what the window itself needs
        (`session.landing`). False: it could not be done in place — nothing changed, the caller falls back to density only."""
        window = self._window_geometry(session)
        target = Geometry(int(phone_size[0]), int(phone_size[1]), int(phys_dpi))
        try:
            ok = await self._resize_display(session.state.window_id, target.width, target.height, target.dpi, in_place_only=True)
        except Exception as exc:  # noqa: BLE001 — the density-only pre-landing is the fallback
            wlog.warning("⚠️ [HANDOFF: ÖN-İNİŞ] sanal ekran %dx%d'e çekilemedi: %s", target.width, target.height, exc)
            return False
        if not ok:
            return False
        session.landing = Landing(window=window, landed=Geometry(session.target_display_w, session.target_display_h, session.dpi))
        wlog.info(
            "🛬 [HANDOFF: ÖN-İNİŞ] sanal ekran %dx%d @ %d → %dx%d @ %d DPI (telefonun kendi boyutu ve yoğunluğu)",
            window.width, window.height, window.dpi, target.width, target.height, target.dpi,
        )
        return True

    async def _await_task_geometry(
        self, task_id: str | int, size: tuple[int, int], serial: str, before: tuple[int, int, int, int] | None = None,
    ) -> bool:
        """Waits briefly until the task's window has taken the display's new size: Android lays the app out asynchronously
        after a display change. Unreadable geometry returns at once (nothing to wait for); the move never depends on it.

        Done when the box fills the display — or when it has MOVED from ``before`` and holds still for two readings: an app
        with a maximum aspect ratio (YouTube) is letterboxed and never fills a 1220x2712 phone screen, and waiting for it to
        do so spent the whole budget on every handoff (field log 2026-10-25: 1.55 s of each 3.8 s "Telefona aktar")."""
        loop = asyncio.get_running_loop()
        started = loop.time()
        deadline = started + self._GEOMETRY_WAIT_S
        previous: tuple[int, int, int, int] | None = None
        while True:
            state = await read_task_windowing(self._adb, serial, str(task_id))
            if not state.found or state.bounds is None:
                return False
            bounds = tuple(state.bounds)
            if _fits_display(bounds, size):
                verdict = "fills"
            elif previous is not None and bounds == previous and before is not None and bounds != tuple(before):
                verdict = "settled"
            elif loop.time() >= deadline:
                verdict = "timeout"
            else:
                previous = bounds
                await asyncio.sleep(self._GEOMETRY_POLL_S)
                continue
            log.info(
                "🛬 [HANDOFF: ÖN-İNİŞ] task=%s geometri %s: %s (önce=%s, ekran=%s) %d ms",
                task_id, verdict, bounds, before, size, int((loop.time() - started) * 1000),
            )
            return verdict != "timeout"

    async def _prelanding(
        self, session: "WindowSession", pkg: str, disp_id: str, window_dpi: int, phys_dpi: int,
        phone_size: tuple[int, int] | None, task_id: str | int | None, serial: str,
    ) -> tuple[bool, Any, float | None, bool]:
        """Settles the app under the PHONE's size and density while it is still on its virtual display (behind the PC
        window's veil), so the move onto display 0 changes neither.

        Returns (done, snapshot, changed_at, rebuilt). ``rebuilt``: the app was (or may have been) rebuilt under the new
        density — its first frame needs a moment before the move; False when it provably was not (size only, media kept). ``done``: nothing is left for the move to answer — the display now has the
        phone's geometry and, where the density changed, the app was proven to rebuild under it (it did by itself,
        Android did, or a verified relaunch/restart). Not done (the reconciler could not prove it, or the budget ran out):
        the snapshot/mark are handed back so the settle that runs after the move finishes the job, exactly as before.
        (False, None, None) when nothing was written."""
        wid = session.state.window_id
        wlog = window_logger(__name__, wid)
        needs_dpi = self._density is not None and window_dpi != phys_dpi
        needs_size = self._resize_display is not None and self._landing_size_needed(session, phone_size)
        veil_s = self._PRELANDING_BUDGET_S + self._PRELANDING_VEIL_MARGIN_S + (self._SIZE_LANDING_BUDGET_S if needs_size else 0.0)
        await self._events.emit("vd_phase", window_id=wid, package=pkg, phase="stealth", deadline_ms=int(veil_s * 1000))

        before, changed_at = await self._density_bracket_open(pkg, window_dpi, phys_dpi) if needs_dpi else (None, None)

        # The task's box BEFORE the resize: "it moved and holds still" ends the wait below. Unreadable now = unreadable then:
        # nothing to wait for.
        readable, box_before = False, None
        if needs_size and task_id:
            with contextlib.suppress(Exception):
                state_before = await read_task_windowing(self._adb, serial, str(task_id))
                readable, box_before = state_before.found and state_before.bounds is not None, state_before.bounds
        landed = needs_size and await self._land_size(session, phone_size, phys_dpi, wlog)
        if landed and readable:
            await self._await_task_geometry(task_id, phone_size, serial, before=box_before)
        if needs_dpi and not (landed and session.dpi == phys_dpi):  # the resize carried the density when it could
            if not await self._set_density(disp_id, phys_dpi, serial):
                return False, None, None, False
            log.info("🛬 [HANDOFF: ÖN-İNİŞ] %s: sanal ekran %d → %d DPI (telefon); taşıma öncesi uzlaştırılıyor", pkg, window_dpi, phys_dpi)

        if not needs_dpi:
            return landed, None, None, False  # size only: the app has nothing to rebuild for a density it does not change
        if before is None:
            return landed, None, None, True
        try:
            outcome = await asyncio.wait_for(
                self._density.settle(pkg, before=before, display=disp_id, reason="pre_landing", changed_at=changed_at),
                timeout=self._PRELANDING_BUDGET_S,
            )
        except asyncio.TimeoutError:
            log.warning("⚠️ [HANDOFF: ÖN-İNİŞ] %s: %.0f sn bütçesi doldu — taşıma sonrası uzlaştırmaya bırakıldı",
                        pkg, self._PRELANDING_BUDGET_S)
            return False, before, changed_at, True
        if not outcome.ok:
            log.warning("⚠️ [HANDOFF: ÖN-İNİŞ] %s: uzlaştırma doğrulanamadı (%s) — taşıma sonrası yeniden denenecek",
                        pkg, outcome.action)
        return outcome.ok, before, changed_at, outcome.action not in _NOT_REBUILT

    async def _restore_window_geometry(
        self, session: "WindowSession", wlog: logging.Logger, requested: "Geometry | None" = None,
    ) -> bool:
        """The display goes back to what the PC window needs — BEFORE the app returns to it (it is empty now: nothing is
        rebuilt by the change). True: restored by an actual resize. A window the user resized in the meantime keeps the
        geometry it asked for (no-op, False). Never raises.

        ``requested``: the exact pixels the window asked for while the app was on the phone (the frontend sends them with the
        reclaim). They win over the landing book, which is then dropped."""
        landing, session.landing = session.landing, None
        if requested is not None:
            window = requested
            if self._resize_display is None or (session.target_display_w, session.target_display_h, session.dpi) == (
                window.width, window.height, window.dpi,
            ):
                return False
            try:
                ok = await self._resize_display(session.state.window_id, window.width, window.height, window.dpi, in_place_only=False)
            except Exception as exc:  # noqa: BLE001 — the move still carries the app to whatever the display is
                wlog.warning("⚠️ [HANDOFF: GERİ ALMA] istenen %dx%d @ %d DPI uygulanamadı: %s", window.width, window.height, window.dpi, exc)
                return False
            if ok:
                wlog.info("↩️ [HANDOFF: GERİ ALMA] pencerenin telefondayken istediği boyut: %dx%d @ %d DPI", window.width, window.height, window.dpi)
            return ok
        if landing is None:
            return False
        window = self._geometry_to_restore(session, landing)
        if window is None:
            wlog.info("[HANDOFF: GERİ ALMA] pencere telefondayken yeniden boyutlandırılmış — geometrisi olduğu gibi bırakıldı")
            return False
        if self._resize_display is None:
            return False
        try:
            ok = await self._resize_display(session.state.window_id, window.width, window.height, window.dpi, in_place_only=False)
        except Exception as exc:  # noqa: BLE001 — the move still carries the app to whatever the display is
            wlog.warning("⚠️ [HANDOFF: GERİ ALMA] sanal ekran %dx%d'e döndürülemedi: %s", window.width, window.height, exc)
            return False
        if ok:
            wlog.info("↩️ [HANDOFF: GERİ ALMA] sanal ekran pencere geometrisine döndü: %dx%d @ %d DPI", window.width, window.height, window.dpi)
        return ok

    @staticmethod
    def _geometry_to_restore(session: "WindowSession", landing: "Landing") -> Geometry | None:
        """What the display must be before the app returns to it. None: leave it as it is.

        A window the user resized while its app was on the phone keeps the SIZE it asked for — but a plain drag carries no density,
        so the display still has the phone's (the pre-landing's): that density goes back to the window's, or the app would come
        back drawn at the phone's scale inside a window-sized display. A density the user chose themselves (the DP setting) stays."""
        current = Geometry(session.target_display_w, session.target_display_h, session.dpi)
        if current == landing.landed:
            return landing.window
        if current.dpi == landing.landed.dpi and landing.window.dpi != current.dpi:
            return Geometry(current.width, current.height, landing.window.dpi)
        return None

    @staticmethod
    def _adopt_window_geometry(session: "WindowSession") -> None:
        """No live display to resize (frozen / its server gone): the window's geometry goes back into the session, so the
        display the unfreeze builds is the window's, not the phone's."""
        landing, session.landing = session.landing, None
        if landing is None:
            return
        window = HandoffManager._geometry_to_restore(session, landing)
        if window is None:
            return  # resized in the meantime: that is what the window asked for
        session.target_display_w, session.target_display_h, session.dpi = window.width, window.height, window.dpi
        session.state.width, session.state.height = window.width, window.height

    # `am start --windowingMode 5` görevi HyperOS'un küçük varsayılan kutusuna (588×1220 → sw183dp) koyar; uygulama o kutuda
    # telefonun düzeniyle DEĞİL, sıkışık çizilir. Kullanıcı bu geçici hâli görür: bu yüzden doğru kutu, görev serbest kipe
    # girer girmez verilir (cihazda ölçüldü: ~0,25 sn'de verilen kutu kalıcıdır) ve sonra doğrulanır (settle_task_windowing).
    # Bunun arkasında CDP yenilemesi / yeniden kurma gibi saniyelerce süren işler BEKLEMEZ.
    _FREEFORM_ENTRY_TIMEOUT_S = 1.5
    _FREEFORM_ENTRY_POLL_S = 0.04

    async def _await_freeform_entered(self, task_id: str | int, serial: str) -> bool:
        """Waits until the task reads as freeform (the system's entry has begun and the box can be given). False: it did not
        within the budget or could not be read — the caller goes on (settle_task_windowing verifies and corrects)."""
        loop = asyncio.get_running_loop()
        deadline = loop.time() + self._FREEFORM_ENTRY_TIMEOUT_S
        while loop.time() < deadline:
            state = await read_task_windowing(self._adb, serial, str(task_id))
            if not state.found:
                return False
            if state.windowing_mode == 5:
                return True
            await asyncio.sleep(self._FREEFORM_ENTRY_POLL_S)
        return False

    async def _enter_freeform_via_shell(self, pkg: str, task_id: str | int, serial: str) -> None:
        """Tam ekrandaki görevi serbest kipe HyperOS'un KENDİ geçişiyle alır: `am start --windowingMode 5` Shell'de
        FULLSCREEN_TO_FREEFORM geçişini (MiuiFreeformModeAnimation) çalıştırır ve SystemUI görevi kaydeder.
        WCT ile (geçişsiz) freeform'a almak çerçeve çizdirir ama miuiFreeformTaskInfo oluşmaz: sürükleme/boyutlandırma ölü,
        içerik beyaz kalır (ekran kapat-aç düzeltir). Görev zaten serbestse hiçbir şey gönderilmez."""
        with contextlib.suppress(Exception):
            current = await read_task_windowing(self._adb, serial, str(task_id))
            if current.found and current.windowing_mode == 5:
                return
        top_component = None
        daemon = self._daemon_client_getter() if callable(self._daemon_client_getter) else None
        if daemon is not None:
            with contextlib.suppress(Exception):
                import inspect
                t_call = daemon.task_info(task_id) if hasattr(daemon, "task_info") else None
                t_info = await t_call if inspect.isawaitable(t_call) else t_call
                if isinstance(t_info, dict) and isinstance(t_info.get("top"), str):
                    top_component = t_info["top"]
        try:
            await android_shell.bring_to_front(
                self._adb, serial, pkg, "0", reorder_only=True, component=top_component, windowing_mode=5,
            )
            if not await self._await_freeform_entered(task_id, serial):
                log.debug("[HANDOFF] %s serbest kipe girdiği okunamadı — kutu yine de verilip doğrulanacak", pkg)
        except Exception as exc:  # noqa: BLE001 — WCT yedeği (settle_task_windowing) devralır
            log.warning("⚠️ [HANDOFF] %s serbest kip geçişi (am start --windowingMode 5) başarısız: %s", pkg, exc)

    async def _settle_phone_windowing(
        self, pkg: str, task_id: str | int | None, serial: str, *, phone_size: tuple[int, int] | None = None,
        windowing: str | None = None,
    ) -> None:
        """Telefona aktarılan görevin pencereleme kipini seçilen ayara göre doğrular/oturtur. Görev zaten
        hedefteyse HİÇBİR komut gitmez (`skip_if_ok`); uygulama ASLA yeniden başlatılmaz (Workspace'ten farklı olarak
        bu görev hiç freeform olmadı). Geçiş raporu (`[TRANSFER]`) logda."""
        try:
            target = windowing or "fullscreen"
            if windowing is None:  # no choice made for THIS handoff: the user's setting
                with contextlib.suppress(Exception):
                    from app.storage import settings_db
                    target = (await settings_db.get_project_settings()).phone_handoff_windowing
            from app.device.deep_navigator import find_task_id_for_package
            tid = task_id or await find_task_id_for_package(self._adb, pkg, display_id="0", serial=serial)
            if not tid:
                return
            if target == "freeform":
                await self._enter_freeform_via_shell(pkg, tid, serial)
            await settle_task_windowing(
                self._adb, serial, str(tid), pkg, target=target, display_id="0",
                daemon=self._daemon_client_getter(), wlog=log, skip_if_ok=True,
            )
        except Exception as exc:  # noqa: BLE001 — doğrulama geçişi asla bozmaz
            log.warning("⚠️ [TRANSFER] %s pencereleme doğrulaması başarısız: %s", pkg, exc)

    # The app was already moved by Android (focus event / watchdog) when we noticed: its own rebuild on the phone may
    # predate our mark by this much.
    _ALREADY_MOVED_LOOKBACK_S = 3.0

    async def _phone_foreground_task(self, pkg: str, task_id: str | int | None) -> int | None:
        """Telefonun (Display 0) şu an ön planda gördüğü kullanıcı görevi — aktarımdan ÖNCE okunur. Aktarım bu görevi Home'a
        itmek yerine hedefin arkasında tutar (bkz. `android_shell.unlock_display0_gesture_navigation`). None: okunamadı, en üstteki
        görünür görev Home/başlatıcı, kendi/OpenDeX görevi ya da hedefin kendisi → Home ara görevi olarak kalır."""
        daemon = self._daemon_client_getter() if callable(self._daemon_client_getter) else None
        if daemon is None:
            return None
        try:
            tasks = await daemon.tasks()
        except Exception:  # noqa: BLE001 — okunamazsa Home ara görevi (eski davranış)
            return None
        for item in tasks or []:
            if not isinstance(item, dict) or item.get("display") != 0 or not item.get("visible"):
                continue
            package = item.get("package")
            if str(item.get("id")) == str(task_id) or package == pkg:
                continue
            # Görünür görevlerin en üstteki ilki ön plandır; o bir başlatıcı/dahili pencere ya da paketsiz ise Home yeterli.
            if not package or is_launcher_package(package) or is_internal_package(package):
                return None
            with contextlib.suppress(TypeError, ValueError):
                return int(item["id"])
            return None
        return None

    async def _execute_to_phone(
        self,
        session: "WindowSession",
        pkg: str,
        disp_id: str | None,
        serial: str,
        task_id: str | int | None = None,
        source: str = "pc",
        windowing: str | None = None,
    ) -> None:
        """PC ➔ telefon (Display 0) — PC'deki "Telefona Aktar" ya da uygulamanın telefonda açılması (focus olayı /
        watchdog):

        0. (yalnız kaynak="pc") ÖN-İNİŞ: sanal ekran telefonun boyutuna VE yoğunluğuna çekilir ve uygulama orada, PC
           perdesinin arkasında uzlaştırılır (bkz. `_prelanding`); ardından taşıma boyut- ve yoğunluk-nötr olur.
        1. Görev Display 0'a taşınır (ya da telefonda başlatılır). Ön-iniş yoksa (uygulamayı Android taşıdı, ayar kapalı…)
           sanal ekranın geometrisine DOKUNULMAZ: taşıma boyut + yoğunluk değişimini tek adımda taşır.
        2. Tam ekran yığınına oturtulur, pencereleme kipi doğrulanır, telefon uyandırılır.
        3. density_reconciler: uygulama kendini yeniden kurduysa hiçbir şey yapılmaz; kurmadıysa bir kez, doğrulanmış
           olarak yenilenir (arka planda — küresel kilit tutulmaz).

        Pencereleme kipi önceliği (özel > genel): bu aktarım için seçilen kip (`windowing`, başlık menüsü) > Ayarlar'daki
        varsayılan (`phone_handoff_windowing`, YALNIZ kaynak="pc": kullanıcının "Telefona aktar" düğmesi) > tam ekran.
        Uygulama telefonda Android'in ya da kullanıcının eliyle açıldıysa (display0 / watchdog) HER ZAMAN tam ekrandır:
        serbest pencere ayarı kendi başına açılan uygulamaya uygulanmaz."""
        if windowing is None and source != "pc":
            windowing = "fullscreen"
        veiled = False  # PC penceresinin üstündeki "Görünüm Optimize Ediliyor" perdesi açıldı mı (ön-iniş)
        try:
            from app.device.deep_navigator import find_task_id_for_package

            log.info("📱 [HANDOFF] Başlatılıyor (kaynak=%s, pkg=%s, disp=%s)...", source, pkg, disp_id)
            if not task_id:
                if disp_id:
                    task_id = await find_task_id_for_package(self._adb, pkg, display_id=str(disp_id), serial=serial)
                if not task_id:
                    task_id = await find_task_id_for_package(self._adb, pkg, serial=serial)

            window_dpi = session.dpi or self._settings.VIRTUAL_DISPLAY_DPI
            # The phone's CURRENT density (the user's smallest width included) and size, read live through the daemon: the
            # app is landed on exactly these. Unreadable → no pre-landing of that part (never a guessed value), the move
            # settles. The size is only read when a pre-landing could use it.
            phys_dpi = await android_shell.phone_density(self._adb, serial)
            phone_size = (
                await android_shell.phone_size(self._adb, serial)
                if source == "pc" and self._resize_display is not None else None
            )
            moved_by_android = source in ("display0", "watchdog")
            log.info(
                "📱 [HANDOFF] Parametreler: kaynak=%s, pkg=%s, task=%s, disp=%s, pencere=%dx%d @ %d DPI → telefon=%s @ %s DPI",
                source, pkg, task_id, disp_id, session.target_display_w, session.target_display_h, window_dpi,
                "x".join(map(str, phone_size)) if phone_size else "boyut okunamadı", phys_dpi if phys_dpi else "okunamadı",
            )

            # Telefon ekranını aktarımın başında erkenden uyandır (panel açılış gecikmesini ve siyah ekranı önle) — uygulamanın
            # çalışma profili okunurken: ikisi birbirine bağlı değil, sırayla yapmak (özellikle `dumpsys meminfo` ~0,4 sn) boşa bekletiyordu.
            async def wake() -> None:
                with contextlib.suppress(Exception):
                    await android_shell.wake_and_unlock(self._adb, serial)

            # Geçiş öncesi runtime profili ve tarayıcı scroll çıpası (0,0) tespiti
            saved_scroll = None
            _, runtime_profile = await asyncio.gather(wake(), inspect_app_runtime(self._adb, serial, pkg))
            if runtime_profile.is_browser_cdp and runtime_profile.cdp_socket:
                saved_scroll = await capture_browser_scroll_state(
                    self._adb, serial, runtime_profile.cdp_socket,
                )

            # ÖN-İNİŞ (yalnız PC'den aktarım): yoğunluk değişimi perdenin arkasında, sanal ekranda yaşanır; taşıma nötr olur.
            prelanded = False
            density_before, changed_at = None, None
            if await self._prelanding_wanted(session, pkg, disp_id, task_id, window_dpi, phys_dpi, phone_size, source):
                veiled = True
                prelanded, density_before, changed_at, rebuilt = await self._prelanding(
                    session, pkg, disp_id, window_dpi, phys_dpi, phone_size, task_id, serial,
                )
                # Yeniden kurulan uygulama (Chrome: yeni render süreci) ilk karesini yeni yoğunlukta çizmeden görev
                # taşınırsa telefon siyah kalır ve yazılar eski yoğunluğa göre dizilir. 13 Eylül akışı 0,3 sn bekliyordu;
                # uzlaştırıcının "adapted" kanıtı ~0,1 sn'de gelip taşımayı erkene çekiyordu. Perde hâlâ açık. Yeniden
                # KURULMAYAN uygulama (yalnız boyut, medya oturumu korunan) yalnız yerleşimini yeniler: kısa bekleme yeter —
                # 0,8 sn her aktarımda (oynayan YouTube dahil) boşa gidiyordu.
                await asyncio.sleep(
                    self._settings.HANDOFF_PRELANDING_STABILIZE_S if rebuilt
                    else self._settings.HANDOFF_PRELANDING_QUIET_STABILIZE_S
                )
                if prelanded:
                    density_before, changed_at = None, None  # nothing left for the move to answer
            if not prelanded and density_before is None:
                # Süreç kimliği + cihaz saati, yoğunluğu değiştiren adımdan (taşıma) HEMEN önce (density_reconciler.py).
                density_before, changed_at = await self._density_bracket_open(
                    pkg, window_dpi, phys_dpi, lookback_s=self._ALREADY_MOVED_LOOKBACK_S if moved_by_android else 0.0,
                )

            # 1. Görevi telefon ekranına (Display 0) TAM EKRAN taşı. Serbest kip burada (WCT ile) verilmez: HyperOS
            # SystemUI'ı kipi yalnız kendi Shell geçişinden (FULLSCREEN_TO_FREEFORM) tanır; geçişsiz WCT ile freeform'a
            # alınan görevde çerçeve çizilir ama miuiFreeformTaskInfo oluşmaz (sürükleme ölü, içerik beyaz).
            # Telefonun şu an ön planındaki uygulama (taşıma onu örter): hedefin arkasında görünür kalsın diye ŞİMDİ okunur.
            behind_task = await self._phone_foreground_task(pkg, task_id) if task_id else None
            if task_id:
                log.info("🚚 [HANDOFF: GÖREV TAŞIMA] Task %s Display %s'den Display 0'a taşınıyor", task_id, disp_id)
                try:
                    await move_task_to_display(
                        self._adb, task_id, "0", serial=serial, timeout_s=2.0, daemon=self._daemon_client_getter(),
                        mode=1, clear_bounds=True,
                    )
                except Exception as exc:
                    log.warning("⚠️ [HANDOFF] move_task_to_display uyarısı: %s", exc)
            else:
                log.info("🚀 [HANDOFF: TELEFONDA BAŞLATMA] %s Display 0'da başlatılıyor", pkg)
                with contextlib.suppress(Exception):
                    await self._adb.shell(
                        f"monkey -p {pkg} -c android.intent.category.LAUNCHER 1",
                        serial=serial,
                        timeout_s=2.0,
                    )
            session.state.handoff_to_phone = True

            # 2. Android'in tam ekran yığınına oturmasını sağla & HyperOS Jest Kilidini Çöz
            launch_mode = None
            try:
                top_component = None
                daemon = self._daemon_client_getter() if callable(self._daemon_client_getter) else None
                if daemon and task_id:
                    with contextlib.suppress(Exception):
                        import inspect
                        t_call = daemon.task_info(task_id) if hasattr(daemon, "task_info") else None
                        t_info = await t_call if inspect.isawaitable(t_call) else t_call
                        if isinstance(t_info, dict) and isinstance(t_info.get("top"), str):
                            top_component = t_info["top"]

                target_windowing = windowing or "fullscreen"
                if windowing is None:
                    with contextlib.suppress(Exception):
                        from app.storage import settings_db
                        target_windowing = (await settings_db.get_project_settings()).phone_handoff_windowing
                launch_mode = 5 if target_windowing == "freeform" else None

                out_start = ""
                # HyperOS/MIUI: görev WCT ile taşındıysa Home'a gerçek bir ön-plan geçişi verilmeli, yoksa kenar geri jesti
                # (GestureStub) dokunuşa kapalı kalır — Home → uygulama (kök neden: docs/design/HANDOFF.md §4).
                # Başlatma komutu hata verirse (çözülemeyen intent) kullanıcı Home'da kalmasın: düz öne getirmeye düşülür.
                if task_id and await android_shell.is_miui_or_hyperos(self._adb, serial):
                    try:
                        out_start = await android_shell.unlock_display0_gesture_navigation(
                            self._adb, serial, pkg, windowing_mode=launch_mode,
                            behind_task_id=behind_task, daemon=daemon,
                        )
                    except Exception as exc:  # noqa: BLE001 — düz öne getirmeye düşülür
                        log.warning("⚠️ [HANDOFF: HYPEROS JEST KİLİDİ] Home → %s geçişi başarısız: %s", pkg, exc)
                    if "error" in (out_start or "").lower():
                        out_start = ""
                    elif out_start:
                        log.info("🧭 [HANDOFF: HYPEROS JEST KİLİDİ] Home → %s geçişi yapıldı (onForegroundChanged → GestureStub)", pkg)
                if not out_start:
                    try:
                        out_start = await android_shell.bring_to_front(
                            self._adb, serial, pkg, "0", reorder_only=bool(task_id), component=top_component,
                            windowing_mode=launch_mode,
                        )
                    except Exception as exc:
                        # A task whose top activity is not exported (Udemy's course player) cannot be named by the shell
                        # (SecurityException): the daemon raises it by id instead, so it does not stay behind the launcher.
                        if not (task_id and daemon and await daemon.reorder_task(task_id, front=True)):
                            raise
                        out_start = f"görev {task_id} kimliğiyle öne alındı ({exc.__class__.__name__})"
                log.info("🎯 [HANDOFF] am start --display 0 tamamlandı (comp=%s mode=%s): '%s'", top_component or "auto", launch_mode, out_start.strip() if out_start else "OK")
            except Exception as exc:
                log.warning("⚠️ [HANDOFF] am start --display 0 uyarısı: %s", exc)

            # 2a. Serbest kip: doğru pencere kutusu HEMEN verilir — aşağıdaki saniyelerce süren işler (CDP yenilemesi, yeniden
            # kurma) bitene kadar kullanıcı sıkışık varsayılan kutuyu görmesin. Tam ekranda bu adım 4'te kalır.
            if launch_mode == 5 and task_id:
                await self._await_freeform_entered(task_id, serial)
                await self._settle_phone_windowing(pkg, task_id, serial, phone_size=phone_size, windowing=windowing)

            # 2b. Display 0 Odak Senkronizasyonu (zararlı dokunuş/yayınlar kaldırıldı)
            focus_coords = (phone_size[0] // 2, phone_size[1] // 2) if phone_size and len(phone_size) == 2 else None
            try:
                await android_shell.sync_display0_focus(self._adb, serial, coords=focus_coords, package=pkg)
            except Exception as exc:
                log.debug("Display 0 focus sync atlandı: %s", exc)

            # 3. View Ağacı Re-Inflate / Canlı Web Layout Yenileme (Evrensel Sıfır State Kaybı)
            restarted = False

            if runtime_profile.is_browser_cdp and runtime_profile.cdp_socket:
                # ── KADEME 1: CDP Destekli Tarayıcı (Chrome, Chromium, Brave, Edge vb.) ──
                # Süreci ÖLDÜRME! Önce sekme izleyicisi: tüm sekmeler (açık olanlar ve sonradan açılacaklar) telefonun yerel ölçeğine
                # oturur — Chrome'un tablet kipi sürece bağlı, telefonda ×1,2 ölçek ve masaüstü sitesi taşır (cdp_refresher.py). Sonra
                # web sayfasına canlı layout re-evaluation ve (0,0) scroll çıpalama dürtmesi: ölçek zaten yerinde olduğundan çıpa tutar.
                with contextlib.suppress(Exception):
                    watcher = start_browser_auto_attach_watcher(
                        self._adb, serial, runtime_profile.cdp_socket, pkg, phys_dpi / 160 if phys_dpi else None,
                        resume=saved_scroll,
                    )
                    await watcher.wait_ready()
                    await watcher.wait_settled()   # the tab in front is reloaded as the other site first; the scroll anchor comes after
                if saved_scroll is not None:
                    cdp_ok = await refresh_browser_layout_inplace(
                        self._adb, serial, runtime_profile.cdp_socket, saved_scroll=saved_scroll,
                    )
                else:
                    cdp_ok = await refresh_browser_layout_inplace(
                        self._adb, serial, runtime_profile.cdp_socket,
                    )
                if cdp_ok:
                    log.info(
                        "✨ [HANDOFF: CANLI DÜRTME] %s web sitesi layout'u CDP ile canlı tazelendi — süreç ve sekmeler korundu",
                        pkg,
                    )
                if not cdp_ok:
                    # CDP dürtmesi yanıt vermezse ve ön-iniş yapılmadıysa güvenli geri çekilme (restart fallback)
                    if not prelanded and task_id and self._daemon_client_getter:
                        restarted = await self._reinflate(pkg, task_id)

            elif prelanded and not is_web_rendered_app(pkg):
                # ── KADEME 2: Ön-İnişli Yerel ve Hibrit Uygulamalar (Sıfır Durum Kaybı) ──
                # (Gallery, Dosya Yöneticisi, X/Twitter, Google Analytics, WhatsApp, Instagram vb.)
                # Ön-iniş zaten yapıldı, arayüz telefon DPI'ına kusursuz oturdu.
                # İster 0 ister 10 WebView içersin, süreç ve aktivite ASLA öldürülmez!
                # Scroll, açık fotoğraf, klasör konumu, form verisi %100 KORUNUR!
                log.info(
                    "🛡️ [HANDOFF: DURUM KORUNDU] %s yerel/hibrit uygulama — konum ve durum kaybını önlemek için restart atlandı",
                    pkg,
                )

            else:
                # ── KADEME 3: Ön-İnişsiz Geçişler veya CDP'siz Web Tarayıcıları ──
                # Android MOVED the task itself (the user tapped the app's icon on the phone, or a watchdog saw it there): the
                # system already re-applied the phone display's configuration and recreated the activity (the reconciler's
                # "adapted [system: ...]" evidence), so a forced process kill is not needed — and it is what left the app with
                # no process and a BLACK screen (field report 2026-10-17). The evidence-based settle at the end of this
                # method decides, and restarts only an app that provably did not adapt.
                should_reinflate = (not prelanded or is_web_rendered_app(pkg)) and not moved_by_android
                if should_reinflate and task_id and self._daemon_client_getter:
                    try:
                        restarted = await self._reinflate(pkg, task_id)
                        if restarted:
                            log.info(
                                "🎯 [HANDOFF: REINFLATE] %s View ağacı Display 0 üzerinde telefon düzenine göre yeniden oluşturuldu",
                                pkg,
                            )
                    except Exception as exc:
                        log.debug("restart_task_activity atlandı/uyarı: %s", exc)

            # 4. Pencereleme kipi: seçilen aktarma kipine (tam ekran | serbest) göre doğrula/oturt.
            await self._settle_phone_windowing(pkg, task_id, serial, phone_size=phone_size, windowing=windowing)

            # 5. Re-inflate başarılı olduysa redundant settle yapılmaz; olmadıysa reconciler'a bırak
            if restarted:
                density_before = None
            elif self._density is not None and density_before is not None:
                self._density.schedule_settle(
                    session.state.window_id, pkg, density_before, display="0", reason=f"to_phone:{source}",
                    quiet_s=0.3, changed_at=changed_at,
                )

            log.info("✨ [HANDOFF BAŞARILI] %s Display 0'a aktarıldı", pkg)
        except Exception as exc:
            log.error("❌ [HANDOFF KRİTİK HATA] %s için geçiş hatası: %s", pkg, exc, exc_info=True)
        finally:
            if veiled:  # perde ne olursa olsun kalkar (başarısız aktarımda pencere donuk kalmasın)
                with contextlib.suppress(Exception):
                    await self._events.emit("vd_phase", window_id=session.state.window_id, package=pkg, phase="live")

    async def handoff_to_phone(self, window_id: str, windowing: str | None = None) -> bool:
        """PC ➔ Telefon Handoff (bkz. _execute_to_phone). Sanal ekran pencerenin yoğunluğunda kalır: geri alındığında
        (reclaim) görev aynı ekrana, aynı yoğunluğa döner."""
        serial = self._serial_getter()
        session = self._sessions.get(window_id)
        if not session or not serial:
            return False

        if window_id in self._active_transitions:
            log.warning("⏳ [HANDOFF] window_id=%s için geçiş zaten devam ediyor (race-condition engellendi)", window_id)
            return False

        pkg = session.state.package
        self.hold(f"pkg_{pkg}", lease_s=5.0)
        self._active_transitions.add(window_id)
        try:
            disp_id = self._resolve_display_id(session)
            wlog = window_logger(__name__, window_id)
            wlog.info("📱 [HANDOFF TO PHONE] %s telefona aktarılıyor (disp_id=%s)...", pkg, disp_id)

            playing, paused_page = await self._capture_continuity(pkg)
            await self._execute_to_phone(session, pkg, disp_id, serial, source="pc", windowing=windowing)
            session.state.handoff_to_phone = True
            load_markers.record("handoff", package=pkg)
            self._resume_continuity(playing, paused_page, "0")

            await self._events.emit(
                "app_handoff_to_phone",
                window_id=window_id,
                package=pkg,
                display_id="0",
                message=f"{pkg} telefonunuza aktarıldı.",
            )
            return True
        finally:
            self._active_transitions.discard(window_id)

    async def _land_on_vd(self, session: "WindowSession", serial: str, task_id: str | int | None, wlog: logging.Logger) -> None:
        """The window's app is on its VD again: fullscreen there (task_windowing.land_fullscreen). Workspace members are
        freeform by design and never come through here."""
        if session.state.workspace_id is not None:
            return
        disp_id = self._resolve_display_id(session)
        if not disp_id:
            return
        await land_fullscreen(
            self._adb, serial, session.state.package, disp_id, task_id=task_id, daemon=self._daemon_client_getter(), wlog=wlog,
        )

    async def _back_on_vd(self, session: "WindowSession", serial: str, task_id: str | int | None) -> None:
        """Android brought the app back onto its virtual display (not our reclaim): the display returns to the window's
        geometry and the app lands fullscreen there — under the lifecycle lock, like every other display change."""
        async with self._locked():
            if self._sessions.get(session.state.window_id) is not session:
                return
            if session.state.handoff_to_phone or session.state.window_id in self._active_transitions or self.is_package_held(session.state.package):
                return
            await self._restore_window_geometry(session, log)
            await self._land_on_vd(session, serial, task_id, log)

    async def reclaim(self, window_id: str, requested: "Geometry | None" = None) -> bool:
        """
        Telefon ➔ PC Reclaim: sanal ekran pencerenin yoğunluğunda (değişmedi — handoff ona dokunmaz); görev oraya
        TEK adımda taşınır, uygulama boyut + yoğunluk değişimini tek bir yeniden kurmayla karşılar. Kendini yeniden
        kurmadıysa density_reconciler bir kez, doğrulanmış olarak yeniler.

        Eskiden sanal ekran önce telefonun DPI'ına çekilip görev taşınıyor, sonra hedefe indiriliyordu: taşıma
        uygulamayı 520'de yeniden kurduruyor, ardından gelen 520→hedef değişimini uygulama yeniden kurulmadan yaşıyordu
        ("telefondan geri alınca DPI büyük geliyor, tek seferde düzelmiyor").

        Sunucu durmuş/donmuşsa (session.state.frozen): sadece unfreeze ile taze bir oturum başlatılır.

        'app_handoff_resolved' yayınlayarak arayüzdeki bilgilendirme kartını kaldırır.
        """
        serial = self._serial_getter()
        session = self._sessions.get(window_id)
        if not session or not serial:
            return False

        if window_id in self._active_transitions:
            log.warning("⏳ [RECLAIM] window_id=%s için geçiş zaten devam ediyor (race-condition engellendi)", window_id)
            return False

        pkg = session.state.package
        self.hold(f"pkg_{pkg}", lease_s=5.0)
        self._active_transitions.add(window_id)
        try:
            disp_id = self._resolve_display_id(session)
            wlog = window_logger(__name__, window_id)
            wlog.info("📲 [RECLAIM WINDOW] %s PC penceresine geri alınıyor (disp_id=%s)...", pkg, disp_id)

            started = time.monotonic()
            playing, paused_page = await self._capture_continuity(pkg)
            from app.device.deep_navigator import find_task_id_for_package
            task_id = await find_task_id_for_package(self._adb, pkg, display_id="0", serial=serial)
            task_source = "display0"
            if not task_id:
                task_id = await find_task_id_for_package(self._adb, pkg, serial=serial)
                task_source = "genel" if task_id else "yok"
            wlog.info(
                "🔎 [RECLAIM: ADAY] %s task_id=%s (kaynak=%s) frozen=%s sunucu_canlı=%s disp_id=%s handoff_to_phone=%s",
                pkg, task_id, task_source, session.state.frozen, session.server.is_alive, disp_id,
                session.state.handoff_to_phone,
            )

            # Sonuç: "moved" = telefondaki CANLI görev sanal ekrana getirildi (kaldığı yerden devam);
            # "relaunched" = görev yoktu / taşınamadı (kullanıcı Son Kullanılanlar'dan silmiş olabilir) →
            # uygulama sanal ekranda SIFIRDAN başlatıldı (onDestroy kullanıcı eliyle yapıldı, bu doğal).
            outcome = "relaunched"
            if session.state.frozen or not session.server.is_alive or not disp_id:
                wlog.info("❄️ [RECLAIM: UNFREEZE] Sunucu durmuş veya donmuş, yeniden başlatılıyor...")
                # Telefona verilmiş bir uygulama telefonun yoğunluğunda yaşıyor; yeni sanal ekrana START_APP ile geri
                # taşınınca pencerenin yoğunluğuna geçer (density_reconciler.py).
                density_before, changed_at = None, None
                # No live display to resize: the window's own size/density go back into the session, so the display the unfreeze
                # builds is the window's — not the phone-shaped one a pre-landing left in it.
                self._adopt_window_geometry(session)
                if session.state.handoff_to_phone:
                    phys_dpi = await android_shell.phone_density(self._adb, serial)
                    density_before, changed_at = await self._density_bracket_open(
                        pkg, phys_dpi, session.dpi or self._settings.VIRTUAL_DISPLAY_DPI,
                    )
                await self._unfreeze_locked(window_id)
                await self._land_on_vd(session, serial, None, wlog)
                if density_before is not None:
                    self._density.schedule_settle(
                        window_id, pkg, density_before,
                        display=lambda: self._resolve_display_id(session) or session.state.display_id or None,
                        reason="reclaim_unfreeze", quiet_s=0.3, changed_at=changed_at,
                    )
            else:
                phys_dpi = await android_shell.phone_density(self._adb, serial)
                is_workspace = session.state.workspace_id is not None

                # Sanal ekran pencerenin geometrisinde (boyut + yoğunluk) olmalı: ön-iniş yapılmış bir aktarımdan sonra
                # telefonunkindedir. Boş olduğundan geri yazım hiçbir uygulamayı etkilemez; sonra taşıma, değişimin TAMAMINI
                # tek adımda taşır. Yapılmadıysa ekran zaten pencerenin değerindedir (yapılandırma değişikliği doğurmaz).
                restored = await self._restore_window_geometry(session, wlog, requested=requested)
                target_dpi = session.dpi or self._settings.VIRTUAL_DISPLAY_DPI
                if not restored:
                    await self._set_density(disp_id, target_dpi, serial)

                density_before, changed_at = (None, None) if is_workspace else await self._density_bracket_open(
                    pkg, phys_dpi, target_dpi,
                )

                # Geçiş öncesi runtime profili ve tarayıcı scroll çıpası (0,0) tespiti
                saved_scroll = None
                runtime_profile = await inspect_app_runtime(self._adb, serial, pkg)
                if runtime_profile.is_browser_cdp and runtime_profile.cdp_socket:
                    saved_scroll = await capture_browser_scroll_state(
                        self._adb, serial, runtime_profile.cdp_socket,
                    )

                if task_id:
                    wlog.info("🚚 [RECLAIM: GÖREV TAŞIMA] Task %s Display 0'dan Display %s'ye taşınıyor", task_id, disp_id)
                    # Merdiven: taşıma başarısız olabilir (Son Kullanılanlar'dan silinen görevin bayat kaydı, id değişmiş
                    # olabilir). İstisna YUKARI ÇIKMAZ — aksi halde "yeniden başlat" dalı hiç çalışmaz, `handoff_to_phone`
                    # True kalır ve kullanıcı "geri al" dediğinde hiçbir şey olmazdı.
                    try:
                        await move_task_to_display(
                            self._adb, task_id, disp_id, serial=serial, timeout_s=2.0, daemon=self._daemon_client_getter(),
                            mode=1, clear_bounds=True,
                        )
                        outcome = "moved"
                        # The task kept the mode it requested on the phone: a freeform handoff ("serbest pencere") must come
                        # back FULLSCREEN into the VD window, not as a small frame inside the stream.
                        await self._land_on_vd(session, serial, task_id, wlog)
                    except Exception as exc:
                        wlog.warning(
                            "⚠️ [RECLAIM: TAŞIMA BAŞARISIZ] task=%s taşınamadı (%s) — görev yok edilmiş/bayat; "
                            "%s sanal ekranda SIFIRDAN başlatılacak", task_id, exc, pkg,
                        )
                else:
                    wlog.info("🆕 [RECLAIM: GÖREV YOK] %s için canlı görev bulunamadı (Son Kullanılanlar'dan silinmiş) — sıfırdan başlatılacak", pkg)

                # Ekrandaki aktiviteyi ön plana çıkar ve canlandır (reorder_only: aktivite yığınını ve scroll durumunu sıfırlamaz)
                wlog.info("✨ [RECLAIM: SANAL EKRANDA ÖNE ÇIKARMA] %s Display %s üzerinde öne çıkarılıyor", pkg, disp_id)
                with contextlib.suppress(Exception):
                    await android_shell.bring_to_front(self._adb, serial, pkg, disp_id, reorder_only=bool(task_id))

                # Telefon tarafındaki sekme izleyicisini durdur (telefon kipi biter)
                with contextlib.suppress(Exception):
                    stop_browser_auto_attach_watcher(pkg)

                # Tarayıcı layout'u ve (0,0) çıpasını PC penceresinde canlı olarak tazele
                if runtime_profile.is_browser_cdp and runtime_profile.cdp_socket:
                    # Pencere kipi: telefonda MOBİL siteyle yüklenmiş sekmeler pencerede MASAÜSTÜ siteye geçer (video ve kaydırma korunur),
                    # sonradan açılanlar da masaüstü kimliğiyle başlar; pencere yaşadıkça kalır (cdp_refresher.BrowserTabAutoAttachWatcher).
                    with contextlib.suppress(Exception):
                        window_dpi = session.dpi or self._settings.VIRTUAL_DISPLAY_DPI
                        desktop_watcher = start_window_watcher(
                            self._adb, serial, runtime_profile.cdp_socket, pkg,
                            session.target_display_w, session.target_display_h, window_dpi, resume=saved_scroll,
                        )
                        await desktop_watcher.wait_ready()
                        await desktop_watcher.wait_settled()
                    if saved_scroll is not None:
                        cdp_ok = await refresh_browser_layout_inplace(
                            self._adb, serial, runtime_profile.cdp_socket, saved_scroll=saved_scroll,
                        )
                    else:
                        cdp_ok = await refresh_browser_layout_inplace(
                            self._adb, serial, runtime_profile.cdp_socket,
                        )
                    if cdp_ok:
                        wlog.info("✨ [RECLAIM: CANLI DÜRTME] %s web sitesi layout'u ve (0,0) çıpası CDP ile tazelendi", pkg)

                # Uygulama süreci telefonun yoğunluğunda yaşıyordu ve pencerenin yoğunluğuna geçti: kendini yeniden kurmadıysa
                # bir kez, doğrulanmış yenileme. Görev kimliği burada TAŞIMADAN ÖNCEKİ kimlik (bayat olabilir) — uzlaştırıcı
                # görevi hedef ekranda taze çözer. Arka planda: kilit altında saniyelerce beklenmez.
                if self._density is not None and density_before is not None:
                    self._density.schedule_settle(
                        window_id, pkg, density_before, display=lambda: self._resolve_display_id(session) or disp_id,
                        reason="reclaim", quiet_s=0.3, changed_at=changed_at,
                    )

            session.state.handoff_to_phone = False
            load_markers.record("reclaim", package=pkg, detail=outcome)
            await self._events.emit("app_handoff_resolved", window_id=window_id, package=pkg)
            await self._events.emit("app_reclaim_result", window_id=window_id, package=pkg, outcome=outcome)
            wlog.info("✅ [RECLAIM: TAMAM] %s -> %s (süre=%dms)", pkg, outcome, (time.monotonic() - started) * 1000)
            self._resume_continuity(playing, paused_page, disp_id)
            return True
        finally:
            self._active_transitions.discard(window_id)

    async def _capture_continuity(self, pkg: str) -> tuple[Any, Any]:
        """(playing snapshot, paused page) before a user's move. A PAUSED watch page is lost by the move like a playing one (device
        test 2026-10-27: a paused YouTube video handed to the phone fell to the home feed, the video shrunk into a black mini player),
        so its page is kept too — only when nothing plays (a playing one is `capture`'s, and restore reopens its page itself)."""
        playing = await self._playback.capture(pkg)
        return playing, (await self._playback.capture_page(pkg) if playing is None else None)

    def _resume_continuity(self, playing, paused_page, display_id=None) -> None:
        """After the move: the playing video goes on (restore), the paused page is reopened paused at its second if it was lost."""
        self._resume_playback(playing, display_id)
        if paused_page is not None:
            spawn_background(self._playback.repair_page(paused_page, display_id), f"repair-page-{paused_page.package}")

    def _resume_playback(self, snapshot, display_id=None) -> None:
        """The move is done: a video that was playing and is now stopped by the activity rebuild goes on from where it stopped.
        In the background — the caller's HTTP reply and the lifecycle lock are not held up by it."""
        if snapshot is not None:
            spawn_background(self._playback.restore(snapshot, display_id), f"resume-playback-{snapshot.package}")

    async def _reinflate(self, pkg: str, task_id: str | int) -> bool:
        """Rebuilds the app's view tree on the phone display: a state-preserving PROCESS restart (daemon) — except for an app
        that holds a media session (playing or paused), whose process must not die (the music or video would go with it,
        density_reconciler "Media is never cut"): that one is left as it is. True: the app was rebuilt."""
        if self._density is not None and await self._density.holds_media(pkg):
            log.info("🎵 [HANDOFF: REINFLATE] %s medya oturumu var — süreç yeniden başlatılmadı", pkg)
            return False
        daemon = self._daemon_client_getter() if callable(self._daemon_client_getter) else None
        if daemon and hasattr(daemon, "restart_task_activity"):
            before = await self._density.snapshot(pkg) if self._density is not None else None
            restarted = bool(await daemon.restart_task_activity(task_id))
            if restarted and before is not None:
                await self._ensure_relaunched(pkg, task_id, before, daemon)
            return restarted
        return False

    # How long a killed app gets to come back by itself before the task is relaunched by hand.
    _REBIRTH_WAIT_S = 3.0
    _REBIRTH_POLL_S = 0.3

    async def _ensure_relaunched(self, pkg: str, task_id: str | int, before: Any, daemon: Any) -> None:
        """`restart_task_activity` kills the app's process and only relaunches its activity when the task is VISIBLE at that
        moment. Right after a Home -> app transition (the HyperOS gesture unlock, or Android's own move of the task onto the
        phone) it is not yet: the process is killed and nothing relaunches it — the task stays on the phone screen with no
        process (`app=null`, visibleRequested=false) and the user sees a BLACK screen (field report 2026-10-17: YouTube tapped on
        the phone while open in a DeX window). So the rebirth is checked, and a task that did not come back is started again
        on the phone's screen. Never raises."""
        serial = self._serial_getter()
        if not serial:
            return
        try:
            loop = asyncio.get_running_loop()
            deadline = loop.time() + self._REBIRTH_WAIT_S
            while True:
                now = await self._density.snapshot(pkg)
                if now.identity is not None and now.identity != before.identity:
                    return                                   # a new process: it relaunched itself
                if loop.time() >= deadline:
                    break
                await asyncio.sleep(self._REBIRTH_POLL_S)
            if before.identity is not None and now.identity == before.identity:
                return                                       # the same process is still there: nothing was killed
            component = None
            with contextlib.suppress(Exception):
                info = await daemon.task_info(task_id) if hasattr(daemon, "task_info") else None
                if isinstance(info, dict) and isinstance(info.get("top"), str):
                    component = info["top"]
            log.warning("⚠️ [HANDOFF: REINFLATE] %s süreci öldürüldü ama geri gelmedi (siyah ekran riski) — telefonda yeniden başlatılıyor", pkg)
            await android_shell.bring_to_front(self._adb, serial, pkg, "0", reorder_only=False, component=component)
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001 — a handoff must not fail over its safety net
            log.warning("[HANDOFF: REINFLATE] %s yeniden başlatılamadı: %s", pkg, exc)

    def _watched_sessions(self) -> list["WindowSession"]:
        """Windows whose app can wander to the phone: real apps (not our pseudo-windows, not a launcher), streaming.
        A frozen window (minimized, or waiting to be rebuilt after a link drop) has no display, so its app being on the
        phone is not a handoff."""
        return [
            s for s in list(self._sessions.values())
            if not (is_internal_package(s.state.package) or is_launcher_package(s.state.package))
            and not s.state.minimized and not s.state.frozen
        ]

    async def _observe(
        self,
        s: "WindowSession",
        *,
        on_phone: bool,
        on_vd: bool,
        serial: str | None,
        source: str,
        task_id: str | int | None = None,
    ) -> None:
        """ONE observation of where `s`'s app is showing — from a focus event (`source="display0"`) or the dumpsys
        watchdog (`source="watchdog"`). Both paths used to carry their own copy of this decision."""
        pkg = s.state.package
        if s.state.workspace_id == "eco":
            if on_phone and not on_vd and not s.state.handoff_to_phone and self._on_eco_member_on_phone is not None:
                self._on_eco_member_on_phone(s.state.window_id)
            return

        if on_phone and not on_vd:
            if self.is_package_held(pkg) or s.state.window_id in self._active_transitions:
                log.debug("🛡️ [HANDOFF IGNORED] %s için handoff koruması aktif (kaynak=%s)", pkg, source)
                return
            if s.state.handoff_to_phone:
                return
            s.state.handoff_to_phone = True
            load_markers.record("handoff", package=pkg, detail=source)
            log.info("🎯 [HANDOFF / %s] %s telefonda açıldı — görüntü telefona devrediliyor", source.upper(), pkg)
            if serial:
                spawn_background(self._to_phone_locked(s, serial, task_id, source), f"to-phone-{pkg}")
            await self._events.emit(
                "app_handoff_to_phone",
                window_id=s.state.window_id,
                package=pkg,
                display_id="0",
                message=f"{pkg} telefonunuzda açıldı. Görüntü telefon ekranınıza devredildi.",
            )
        elif on_vd and s.state.handoff_to_phone:
            if self.is_package_held(pkg) or s.state.window_id in self._active_transitions:
                log.debug("🛡️ [CONTINUITY IGNORED] %s için handoff koruması aktif (kaynak=%s)", pkg, source)
                return
            s.state.handoff_to_phone = False
            log.info("💻 [CONTINUITY / GERİ ALINDI (%s)] %s PC sanal ekranına geri döndü!", source, pkg)
            if serial:
                spawn_background(self._back_on_vd(s, serial, task_id), f"land-vd-{pkg}")
            await self._events.emit("app_handoff_resolved", window_id=s.state.window_id, package=pkg)

    async def _to_phone_locked(self, s: "WindowSession", serial: str, task_id: str | int | None, source: str) -> None:
        """The event-driven handoff's display work, under the lifecycle lock: skipped when the window was closed or
        reclaimed (handoff_to_phone cleared) while it waited."""
        async with self._locked():
            if self._sessions.get(s.state.window_id) is not s or not s.state.handoff_to_phone:
                return
            if s.state.window_id in self._active_transitions or self.is_package_held(s.state.package):
                log.debug("🛡️ [_to_phone_locked IGNORED] %s için geçiş aktif veya paket kilitli", s.state.package)
                return
            # The user's own launch (or Android's) already started moving the app, but it still plays at this instant: what the
            # rebuild on the phone then stops goes on from where it stopped, exactly as for a handoff from the PC.
            playing = await self._playback.capture(s.state.package)
            await self._execute_to_phone(
                s, s.state.package, self._resolve_display_id(s), serial, task_id=task_id, source=source,
            )
            self._resume_playback(playing, "0")

    async def on_pump_ended(self, s: "WindowSession") -> None:
        """A dedicated window's video pump ended (SessionReconfigurer reports it). Pumps also end on every
        resize/reconfigure, so only a task of the app actually standing on the phone's display counts as a handoff.
        No display work here: the focus event / watchdog that sees the same move runs it.

        A pump that ended while its server is still ALIVE was closed by us (reclaim, resize, reconfigure): the virtual
        display still exists, so nothing can have pushed the app to the phone. Only a dead server — its display
        destroyed, Android evacuating the task to display 0 — is a handoff. (Without this, a reclaim that finished
        before the old pump's end was reported marked the window "on the phone" again right after bringing it back.)"""
        serial = self._serial_getter()
        if (
            self.paused
            or self.is_package_held(s.state.package)
            or s.state.window_id in self._active_transitions
            or not serial
            or s.state.frozen
            or s.state.minimized
            or s.state.workspace_id == "eco"
            or s.state.handoff_to_phone
        ):
            return
        if s.server.is_alive:
            return
        from app.device.deep_navigator import find_task_id_for_package
        if not await find_task_id_for_package(self._adb, s.state.package, display_id="0", serial=serial):
            return
        if s.state.handoff_to_phone:  # a focus event got there during the lookup
            return
        s.state.handoff_to_phone = True
        window_logger(__name__, s.state.window_id).info(
            "📱 [VIDEO PUMP CLOSED -> HANDOFF] %s telefon ekranında (Display 0) tespit edildi!", s.state.package,
        )
        await self._events.emit(
            "app_handoff_to_phone",
            window_id=s.state.window_id,
            package=s.state.package,
            display_id="0",
            message="Uygulama telefonunuzda açıldı. Görüntü telefona aktarıldı.",
        )

    async def _on_device_task_focused(self, display_id: int = 0, package: str = "", **kwargs: Any) -> None:
        """Instant event-driven handoff detection (< 1ms latency, 0 CPU)."""
        if self.paused or not package or not self._sessions:
            return
        if self.is_package_held(package):
            log.debug("🛡️ [HANDOFF IGNORED] %s için handoff koruması aktif (display_id=%s)", package, display_id)
            return
        serial = self._serial_getter()
        for s in self._watched_sessions():
            if s.state.package != package:
                continue
            if s.state.window_id in self._active_transitions:
                log.debug("🛡️ [HANDOFF IGNORED] %s penceresi için aktif geçiş var (display_id=%s)", s.state.window_id, display_id)
                continue
            await self._observe(
                s,
                on_phone=display_id == 0,
                on_vd=str(display_id) == str(s.server.display_id or ""),
                serial=serial,
                source="display0",
                task_id=kwargs.get("task_id"),
            )

    WATCHDOG_INTERVAL_S = 10.0
    WATCHDOG_INTERVAL_PUSH_S = 30.0

    def _watchdog_interval(self) -> float:
        """With the daemon's TaskStackListener live, focus changes are pushed within ~100 ms and this poll is only a
        safety net. It asks the daemon's task list; `dumpsys window` only without the daemon."""
        daemon = self._daemon_client_getter()
        return self.WATCHDOG_INTERVAL_PUSH_S if getattr(daemon, "task_push", False) else self.WATCHDOG_INTERVAL_S

    async def run_monitor_loop(self) -> None:
        """
        KESİNTİSİZ CİHAZLARARASI GEÇİŞ (Continuity & Handoff Fallback Watchdog)
        Primary path is event-driven via _on_device_task_focused (focus_update pushed by the daemon).
        This loop is a secondary fail-safe: every 10 s, every 30 s while task events are pushed.
        """
        while True:
            try:
                await asyncio.sleep(self._watchdog_interval())
                serial = self._serial_getter()
                if self.paused or not serial or not self._sessions:
                    continue

                visible = await device_queries.visible_packages_by_display(self._adb, serial, timeout_s=1.2)
                if not visible:
                    continue
                for s in self._watched_sessions():
                    pkg = s.state.package
                    if self.is_package_held(pkg) or s.state.window_id in self._active_transitions:
                        continue
                    await self._observe(
                        s,
                        on_phone=pkg in visible.get("0", ()),
                        on_vd=pkg in visible.get(str(s.server.display_id or ""), ()),
                        serial=serial,
                        source="watchdog",
                    )
            except asyncio.CancelledError:
                break
            except Exception as exc:
                log.debug("handoff monitor loop error: %s", exc)
                await asyncio.sleep(5.0)
