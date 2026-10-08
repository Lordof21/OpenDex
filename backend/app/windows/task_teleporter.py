"""Task Teleportation — Eco Workspace ⟷ bağımsız (dedicated) VirtualDisplay
arası "Tomurcuklanma / Dock" (Karar: Hibrit Pencereleme Faz 2/3, bkz.
HIBRIT_WINDOWING_VE_TOMURCUK_MIMARISI_PLANI.md §5).

`handoff_manager.py`'nin Display 0 ⟷ VD arası kullandığı AYNI kanıtlanmış
`move_task_to_display` primitifi burada VD ⟷ VD arasında çalışır.
StealthPhaseOverlay'in frontend tarafı geçişi görsel olarak zaten
maskeliyor; bu modül sadece backend orkestrasyonunu yapar.
"""
from __future__ import annotations

import asyncio
import contextlib
import logging
import re
from typing import TYPE_CHECKING, Any, Callable

from ..config import Settings
from ..device import android_shell
from ..device.adb import Adb
from ..device.device_manager import DeviceNotBoundError
from ..events import EventBus, cancel_and_wait
from ..logging_config import window_logger
from .eco_workspace import EcoWorkspaceManager, TaskBounds
from .scrcpy_launcher import ScrcpyServer
from .spawn_profile import bring_up_server
from .task_movement import move_task_to_display
from .task_windowing import cold_relaunch, settle_task_windowing

if TYPE_CHECKING:
    from .window_manager import WindowSession

log = logging.getLogger(__name__)


class TaskTeleporter:
    def __init__(
        self,
        adb: Adb,
        settings: Settings,
        events: EventBus,
        sessions: dict[str, "WindowSession"],
        workspace: EcoWorkspaceManager,
        *,
        serial_getter: Callable[[], str | None],
        start_video_pump: Callable[["WindowSession"], None],
        daemon_client_getter: Callable[[], Any] | None = None,
        density: Any = None,
    ) -> None:
        self._adb = adb
        self._settings = settings
        self._events = events
        # density_reconciler.DensityReconciler (None in tests that don't care): decides and verifies whether the app's
        # PROCESS must be reborn after a phone<->Workspace move changed the density it lives under.
        self._density = density
        self._sessions = sessions
        self._workspace = workspace
        self._serial_getter = serial_getter
        self._start_video_pump = start_video_pump
        self._daemon_client_getter = daemon_client_getter or (lambda: None)

    async def popout_to_desktop(self, window_id: str) -> "WindowSession":
        """Eco Workspace üyesini bağımsız bir masaüstü penceresine çıkarır:
        yeni bir dedicated VD açar, task'ı oraya taşır, workspace
        defterinden düşürür. WindowManager, dönen session'ı NORMAL (bağımsız)
        bir pencere gibi `self._sessions[window_id]`'e geri yazar.

        Bu session paylaşımlı VD'deyken HİÇBİR ZAMAN kendi pump_task'ı
        olmadı (video pump'ı paylaşımlı VD'nin anchor'ına bağlıydı, bkz.
        eco_workspace.py) — yeni dedicated server'ı için burada KENDİ ilk
        pump'ını alması gerekiyor."""
        serial = self._serial_getter()
        session = self._sessions.get(window_id)
        if not serial:
            raise DeviceNotBoundError()
        if session is None:
            raise RuntimeError(f"{window_id} açık bir pencere değil; taşınamıyor.")
        task = self._workspace.get_task(window_id)
        if not task:
            raise RuntimeError(f"{window_id} Eco Workspace üyesi değil.")
        if task.parked:
            # Park halinde task Display 0'da, üstünde telefon DPI'ı override'ı var: sessizce
            # yeni VD'ye taşımak yanlış yoğunlukla açardı. Önce Workspace'e dönülür.
            raise RuntimeError("Görev şu an telefonda — önce Workspace'e geri alın.")
        wlog = window_logger(__name__, window_id)
        wlog.info("🌸 [TOMURCUK] %s bağımsız ekrana taşınıyor...", task.package)

        server = ScrcpyServer(self._adb, self._settings, serial, daemon=self._daemon_client_getter())
        left, top, right, bottom = task.bounds
        vd_w, vd_h, dpi = max(480, right - left), max(480, bottom - top), self._settings.VIRTUAL_DISPLAY_DPI
        # The task lived under its Workspace density (a per-task override once the user/auto mode set one, else the
        # shared display's base); the dedicated display carries `dpi`. When they differ the app's process lives through a
        # density change — decided and verified by the reconciler like every other density-affecting sequence.
        pinned_dpi = getattr(task, "density", None)
        workspace_dpi = pinned_dpi or self._settings.ECO_WORKSPACE_DPI
        density_before = await self._density.snapshot(task.package) if self._density is not None and workspace_dpi != dpi else None
        changed_at = None
        sockets = await bring_up_server(server, lambda: server.spawn(
            new_display=f"{vd_w}x{vd_h}",
            dpi=dpi,
            max_size=0,
            video_bit_rate=self._settings.DEFAULT_VIDEO_BIT_RATE,
            max_fps=self._settings.DEFAULT_MAX_FPS,
            control=True,
            send_frame_meta=True,
            flex_display=self._settings.ENABLE_FLEX_DISPLAY,
            video_codec="auto",
        ))
        new_disp_id = str(server.display_id or "")
        if density_before is not None and not pinned_dpi:
            changed_at = await self._density.mark()  # no override: the MOVE is what changes the density
        try:
            await move_task_to_display(self._adb, task.task_id, new_disp_id, serial=serial)
        except Exception:
            with contextlib.suppress(Exception):
                await server.stop()  # görev Workspace'te kaldı: yeni VD + encoder sızmasın
            raise
        # Workspace'ten kalan freeform/override bounds temizlenir ve DOĞRULANIR: yeni VD'de görev ekranın
        # bir bölümünde kalıp gerisi siyah olmasın. Geçiş raporu logda.
        await settle_task_windowing(
            self._adb, serial, task.task_id, task.package, target="fullscreen", display_id=new_disp_id,
            daemon=self._daemon_client_getter(), wlog=wlog,
        )
        # The per-task density override is a Workspace-only device (many tasks share one display, each with its own
        # density). Left on the task it would keep pinning the app at its Workspace density on the new display and mask
        # every later density write to that display (live DPI on resize) — "the DPI never settles". With an override the
        # lift IS the density change (the move kept the pinned value).
        if density_before is not None and pinned_dpi:
            changed_at = await self._density.mark()
        await self._release_task_density(task.task_id, wlog, why="popout", display=new_disp_id)
        await self._workspace.take_task_out(window_id)

        # Artık bağımsız pencere: freeze/unfreeze ve resize bu VD'nin boyut/DPI'ını yeniden kurar — Workspace
        # üyeliğinden kalan değerlerle (1920x1080 @ Workspace DPI) değil.
        session.target_display_w, session.target_display_h, session.dpi = vd_w, vd_h, dpi
        session.max_size, session.max_fps = 0, self._settings.DEFAULT_MAX_FPS
        session.video_bit_rate = self._settings.DEFAULT_VIDEO_BIT_RATE
        session.server = server
        session.state.workspace_id = None
        session.state.task_bounds = None
        session.state.display_id = new_disp_id
        session.state.ws_url = f"/ws/video/{window_id}"
        if sockets.video_meta:
            session.stream_w = sockets.video_meta.width
            session.stream_h = sockets.video_meta.height
        self._start_video_pump(session)
        if density_before is not None:
            self._density.schedule_settle(
                window_id, task.package, density_before, display=new_disp_id, reason="popout", quiet_s=0.3,
                changed_at=changed_at,
            )

        await self._events.emit(
            "task_popout_result",
            window_id=window_id, package=task.package, success=True,
            ws_url=session.state.ws_url, display_w=session.stream_w, display_h=session.stream_h,
        )
        wlog.info("🌸 [TOMURCUK] %s bağımsız ekranda (disp_id=%s)", task.package, new_disp_id)
        return session

    async def dock_to_workspace(self, window_id: str, bounds: TaskBounds | None = None) -> None:
        """Bağımsız bir pencereyi Eco Workspace'e geri gönderir (Dock). Task,
        dedicated VD'sinden paylaşımlı VD'ye taşınır; dedicated VD (artık
        boş) imha edilir, encoder sisteme iade edilir.

        Bu session'ın ESKİ dedicated server'a ait KENDİ pump_task'ı vardı
        (normal `_open_window_locked` akışından) — paylaşımlı server'a
        geçerken bu iptal edilir; paylaşımlı server'ın pump'ı zaten (ilk
        dock ise `_ensure_shared_display` içinde, değilse önceden) ayrı
        çalışıyor, bu session için YENİDEN başlatılmaz."""
        serial = self._serial_getter()
        session = self._sessions.get(window_id)
        if not serial:
            raise DeviceNotBoundError()
        if session is None:
            raise RuntimeError(f"{window_id} açık bir pencere değil; dock edilemiyor.")
        wlog = window_logger(__name__, window_id)
        pkg = session.state.package
        old_server = session.server
        old_disp_id = old_server.display_id
        wlog.info(
            "🏠 [DOCK:START] %s (window_id=%s) -> stream=%sx%s, target=%sx%s, state_bounds=%s, incoming_bounds=%s, old_disp_id=%s",
            pkg, window_id, session.stream_w, session.stream_h, session.target_display_w, session.target_display_h, session.state.task_bounds, bounds, old_disp_id,
        )

        from ..device.deep_navigator import find_task_id_for_package
        task_id = await find_task_id_for_package(self._adb, pkg, display_id=str(old_disp_id or ""), serial=serial)
        if not task_id:
            task_id = await find_task_id_for_package(self._adb, pkg, display_id=None, serial=serial)
        if not task_id:
            raise RuntimeError(f"{pkg} için Task ID bulunamadı; dock edilemiyor.")

        dock_bounds = bounds
        if not dock_bounds and session.stream_w and session.stream_h:
            dock_w = min(session.stream_w, self._settings.ECO_WORKSPACE_DISPLAY_W - 160)
            dock_h = min(session.stream_h, self._settings.ECO_WORKSPACE_DISPLAY_H - 160)
            dock_bounds = (80, 80, 80 + dock_w, 80 + dock_h)

        ws_url, stream_w, stream_h, effective_bounds = await self._workspace.attach_existing_task(
            pkg, window_id, task_id, bounds=dock_bounds,
        )
        wlog.info(
            "🏠 [DOCK:ATTACHED] %s -> effective_bounds=%s, stream=%sx%s, ws_url=%s",
            pkg, effective_bounds, stream_w, stream_h, ws_url,
        )

        self._bind_to_workspace(session, ws_url, stream_w, stream_h, effective_bounds)

        await cancel_and_wait(session.pump_task)
        session.pump_task = None
        with contextlib.suppress(Exception):
            await old_server.stop()
        # Gerçek cihazda gözlemlenen yarış: yukarıdaki `await session.pump_task`, pompanın bitiş bildirimini
        # (HandoffManager.on_pump_ended) bekler. Eskiden o kontrol görevi ekran filtresi olmadan arıyordu ve az önce
        # paylaşımlı VD'ye taşınan görevi "telefonda" sanabiliyordu. Artık yalnızca Display 0'a bakıyor ve üye zaten
        # "eco" olarak bağlandığı için hemen çıkıyor. Yine de dock'un kesin son durumu burada garanti ediliyor:
        # kullanıcı asla yanlış bir "telefona aktarıldı" sinyali görmemeli.
        if session.state.handoff_to_phone:
            session.state.handoff_to_phone = False
            wlog.info(
                "🔧 [DOCK: YANLIŞ POZİTİF DÜZELTİLDİ] %s — pump kapanışı paketi paylaşımlı "
                "VD'de odaklı buldu ve hatalıca telefona aktarıldı sandı; workspace_id=eco "
                "olarak düzeltildi.", pkg,
            )
        await self._events.emit(
            "task_dock_result",
            window_id=window_id,
            package=pkg,
            success=True,
            ws_url=ws_url,
            bounds=list(effective_bounds),
            display_w=self._workspace.vd_w,
            display_h=self._workspace.vd_h,
        )
        wlog.info("🏠 [DOCK] %s Eco Workspace'e katıldı.", pkg)

    def _bind_to_workspace(
        self, session: "WindowSession", ws_url: str, stream_w: int, stream_h: int, bounds: TaskBounds,
    ) -> None:
        """The session is now a Workspace member: it streams through the SHARED server/anchor, not its own."""
        session.server = self._workspace.server
        session.state.workspace_id = "eco"
        session.state.task_bounds = list(bounds)
        session.state.display_id = self._workspace.display_id
        session.state.ws_url = ws_url
        session.state.workspace_vd_w = self._workspace.vd_w
        session.state.workspace_vd_h = self._workspace.vd_h
        session.stream_w = stream_w
        session.stream_h = stream_h

    # ------------------------------------------------------------------ workspace ⟷ telefon (Display 0)
    #
    # Bu iki yöntem task_locus.py'deki 6 kenardan EKSİK olan ikisidir. İkisi de
    # `move_task_to_display` primitifini DOĞRUDAN kullanır — "popout + handoff"
    # zinciriyle (dedicated VD aç → encoder tahsis et → taşı → telefona ilet) aynı sonuca
    # ulaşmak, sırf geçiş için gereksiz bir VD + encoder oturumu doğurur.

    async def _density_snapshot_if_changing(self, pkg: str, serial: str, workspace_density: int | None):
        """(process identity, device-clock mark) of ``pkg`` taken right before a phone<->Workspace move that changes the
        density it lives under (the phone's physical density vs the member's Workspace density); (None, None) when
        nothing changes or there is no reconciler."""
        if self._density is None:
            return None, None
        phys_dpi = await android_shell.phone_density(self._adb, serial)
        workspace_dpi = workspace_density or self._settings.ECO_WORKSPACE_DPI
        if phys_dpi != workspace_dpi:  # an unread phone density counts as a change (the settle verifies it)
            return await self._density.snapshot(pkg), await self._density.mark()
        return None, None

    async def _log_released_density(self, task_id: str, display: str, wlog: logging.Logger) -> None:
        """After a task's density override was lifted: what Android reports for the task (its configuration density) next to
        what its display carries. They must agree — a difference means something still pins the app at another density
        (SizeCompat, a forced display value). Evidence for "the app looks bigger than it should" instead of a guess; best
        effort, log only (an automatic restart on this signal alone could loop on an app that is legitimately letterboxed)."""
        daemon = self._daemon_client_getter()
        read = getattr(daemon, "task_density_info", None)
        serial = self._serial_getter()
        if read is None or not serial:
            return
        try:
            info = await read(task_id)
            command = "wm density" if display in ("0", "") else f"wm density -d {display}"
            raw = await self._adb.shell(command, serial=serial, timeout_s=1.5)
        except Exception as exc:  # noqa: BLE001
            wlog.debug("[DENSITY] doğrulama okunamadı (task=%s): %s", task_id, exc)
            return
        task_dpi = info.get("density_dpi") if isinstance(info, dict) else None
        shown = re.search(r"Override density:\s*(\d+)", raw or "") or re.search(r"Physical density:\s*(\d+)", raw or "")
        display_dpi = int(shown.group(1)) if shown else None
        mismatch = isinstance(task_dpi, int) and display_dpi is not None and abs(task_dpi - display_dpi) > 2
        wlog.log(
            logging.WARNING if mismatch else logging.INFO,
            "[DENSITY] DOĞRULAMA task=%s: görev yoğunluğu=%s dpi, ekran(%s) yoğunluğu=%s dpi, size_compat=%s%s",
            task_id, task_dpi if task_dpi is not None else "?", display, display_dpi if display_dpi is not None else "?",
            info.get("in_size_compat", "?") if isinstance(info, dict) else "?",
            " — UYUŞMUYOR: görevde ekranın yoğunluğundan farklı bir sabitleme/zorlama var" if mismatch else "",
        )

    async def _release_task_density(self, task_id: str, wlog: logging.Logger, *, why: str, display: str = "") -> bool:
        """Lifts a task's density override (WindowContainerTransaction densityDpi=0 = "undefined"): the task follows its
        DISPLAY's density again. The ONE rule for every exit from the Workspace — to the phone, to a window of its own:
        an override may only exist while the task lives in the shared display. When the override already equals the
        display's density Android sees no change at all; when it differs the app adapts to the display's real value.
        Best effort (needs the daemon, Android 12+); never breaks a transfer."""
        daemon = self._daemon_client_getter()
        if daemon is None or not getattr(daemon, "is_connected", False):
            return False
        try:
            released = bool(await daemon.set_task_density(task_id, 0))
        except Exception as exc:  # noqa: BLE001
            wlog.warning("⚠️ [DENSITY] task=%s görev-düzeyi yoğunluk kaldırılamadı (%s): %s", task_id, why, exc)
            return False
        wlog.info(
            "🎯 [DENSITY] task=%s: görev-düzeyi yoğunluk sabitlemesi %s (%s) — artık ekranın kendi yoğunluğunda",
            task_id, "kaldırıldı" if released else "kaldırılamadı", why,
        )
        if released and display:
            await self._log_released_density(task_id, display, wlog)
        return released

    async def _release_phone_density_pin(
        self, pkg: str, task_id: str, pinned_dpi: int, serial: str, wlog: logging.Logger, before, changed_at,
    ):
        """After a Workspace task landed on the phone: lifts the density it was pinned at before the move (see
        _phone_stealth_prepare). The pin was a trick so the MOVE itself changes no density; afterwards the task has to follow
        the phone's own — if the two differ (the phone's density was read differently than it is applied) lifting IS a
        density change, so the process identity and the change mark are taken right before it. Returns the (possibly
        updated) (snapshot, changed_at) for the settle."""
        if self._density is not None and pinned_dpi:
            phone_dpi = await android_shell.phone_density(self._adb, serial)
            if phone_dpi != pinned_dpi:
                if before is None:
                    before = await self._density.snapshot(pkg)
                changed_at = await self._density.mark()
        await self._release_task_density(task_id, wlog, why="telefon", display="0")
        return before, changed_at

    async def _phone_stealth_prepare(self, task_id: str, serial: str, daemon: Any) -> int:
        """Task-düzeyi Stealth DPI: handoff_manager._execute_reverse_stealth'in 1. adımının
        (sanal EKRANI telefon DPI'ına çek) görev granülaritesindeki karşılığı. Paylaşımlı VD
        başka görevleri de barındırdığı için display yoğunluğuna DOKUNULMAZ; onun yerine bu
        task'ın kendi Configuration override'ı (WCT) telefon DPI'ına eşitlenir.
        Döner: yazılan telefon yoğunluğu (0: override yazılmadı). Taşımadan SONRA `_release_phone_density_pin` kaldırır.

        Pencereleme kipi burada AYARLANMAZ: Android görevi taşırken kipi yeniden çözdüğü için taşıma ÖNCESİ verilen
        `windowing-mode 1` kalıntıyı temizlemiyordu. Temizlik taşımadan SONRA, doğrulamalı yapılır
        (`_settle_on_phone`)."""
        changed = False
        phys_dpi = await android_shell.phone_density(self._adb, serial)
        if phys_dpi and daemon is not None and daemon.is_connected:  # unread → no pin: never pin a guessed density
            with contextlib.suppress(Exception):
                changed = bool(await daemon.set_task_density(task_id, phys_dpi))
            if changed:
                await asyncio.sleep(0.25)  # uygulamanın telefon DPI'ında yeniden düzen yapması için
        return phys_dpi if changed else 0

    # Uygulamanın telefonda yeniden başlatılıp yerleşmesi için (son çare yolunda) bekleme.
    _RELAUNCH_WAIT_S = 0.8

    async def _phone_windowing_target(self) -> str:
        """Kullanıcının seçtiği aktarma kipi (`phone_handoff_windowing`); okunamazsa güvenli varsayılan tam ekran."""
        try:
            from ..storage import settings_db

            return (await settings_db.get_project_settings()).phone_handoff_windowing
        except Exception:  # noqa: BLE001
            return "fullscreen"

    async def _settle_on_phone(
        self, task_id: str, pkg: str, serial: str, daemon: Any, wlog: logging.Logger,
    ) -> tuple[str, bool]:
        """Görev telefona TAŞINDIKTAN SONRA hedef kipe (tam ekran | serbest) oturtulur ve doğrulanır.
        Tam ekranda pozitif olarak doğrulanamazsa (kalıntı tüm denemelerde sürdü) SON ÇARE: uygulama telefonda sıfırdan
        başlatılır. Döner: (görevin GÜNCEL kimliği, yeniden başlatıldı mı)."""
        target = await self._phone_windowing_target()
        report = await settle_task_windowing(
            self._adb, serial, task_id, pkg, target=target, display_id="0", daemon=daemon, wlog=wlog,
        )
        if report.verdict != "bad":
            return task_id, False
        if target != "fullscreen":
            wlog.warning("⚠️ [TRANSFER] %s serbest pencere kipi doğrulanamadı (yalnız bilgi; uygulama yeniden başlatılmaz).", pkg)
            return task_id, False

        wlog.warning(
            "⚠️ [TRANSFER] %s tam ekrana oturtulamadı (%d deneme) — SON ÇARE: telefonda sıfırdan başlatılıyor.", pkg, report.attempts,
        )
        await cold_relaunch(self._adb, serial, pkg, "0")
        await asyncio.sleep(self._RELAUNCH_WAIT_S)
        from ..device.deep_navigator import find_task_id_for_package

        fresh_id = await find_task_id_for_package(self._adb, pkg, display_id="0", serial=serial)
        if fresh_id:
            task_id = str(fresh_id)
            await settle_task_windowing(
                self._adb, serial, task_id, pkg, target="fullscreen", display_id="0", daemon=daemon, wlog=wlog, attempts=2,
            )
        return task_id, True

    async def workspace_to_phone(self, window_id: str, *, already_on_phone: bool = False) -> bool:
        """Eco Workspace üyesini telefonun kendi ekranına (Display 0) aktarır.

        Üye Workspace'ten SİLİNMEZ, "park edilir": defter kaydı (bounds, yoğunluk
        tercihi) ve WindowSession korunur, böylece `phone_to_workspace` görevi tam
        bıraktığı yere koyabilir. Geriye canlı üye kalmazsa paylaşımlı VD + encoder
        hemen serbest bırakılır (park edilmiş üye encoder maliyeti doğurmaz).

        `already_on_phone=True`: task'ı kullanıcı/sistem zaten telefona taşıdı
        (Display 0 odak olayı) — taşıma/öne çıkarma/uyandırma atlanır, sadece
        bookkeeping + task-düzeyi kalıntı temizliği yapılır.

        İdempotent: zaten park edilmişse True döner (açık istek ile olay-tetikli yol
        çakışabilir). Çağıran WindowManager kilidini tutmalıdır."""
        serial = self._serial_getter()
        session = self._sessions.get(window_id)
        if session is None or not serial:
            return False
        task = self._workspace.get_task(window_id)
        if task is None:
            raise RuntimeError(f"{window_id} Eco Workspace üyesi değil.")
        if task.parked:
            return True

        wlog = window_logger(__name__, window_id)
        pkg = task.package
        daemon = self._daemon_client_getter()
        wlog.info("📱 [WORKSPACE→PHONE] %s (task=%s) telefona aktarılıyor (already_on_phone=%s)...", pkg, task.task_id, already_on_phone)

        from ..device.deep_navigator import find_task_id_for_package

        task_id = task.task_id
        if already_on_phone:
            task_id = (await find_task_id_for_package(self._adb, pkg, display_id="0", serial=serial)) or task_id

        density_before, changed_at = await self._density_snapshot_if_changing(pkg, serial, task.density)
        density_overridden = await self._phone_stealth_prepare(task_id, serial, daemon)
        if not already_on_phone:
            try:
                await move_task_to_display(self._adb, task_id, "0", serial=serial, timeout_s=2.0, daemon=daemon)
            except Exception:
                # Task hâlâ paylaşımlı VD'de: telefon DPI'ını geri al — yoksa Workspace'teki görev bozuk kalırdı.
                # (Pencereleme kipine taşımadan ÖNCE dokunulmadığı için geri alınacak bir şey yok.)
                if density_overridden:
                    with contextlib.suppress(Exception):
                        await daemon.set_task_density(task_id, task.density or self._settings.ECO_WORKSPACE_DPI)
                raise
            # Android'in tam ekran yığınına oturmasını sağla + telefonu uyandır
            # (handoff_manager._execute_reverse_stealth adım 3-4 ile aynı).
            with contextlib.suppress(Exception):
                await android_shell.bring_to_front(self._adb, serial, pkg, "0")
            await android_shell.wake_and_unlock(self._adb, serial)

        # Taşımadan SONRA: Workspace'ten kalan freeform/override bounds temizlenir ve doğrulanır,
        # seçilen aktarma kipi uygulanır.
        task_id, relaunched = await self._settle_on_phone(task_id, pkg, serial, daemon, wlog)
        if density_overridden:
            # The pin only existed to keep the move itself density-neutral; from here the app follows the phone.
            density_before, changed_at = await self._release_phone_density_pin(
                pkg, task_id, density_overridden, serial, wlog, density_before, changed_at,
            )
        if not relaunched and self._density is not None and density_before is not None:
            # Süreç Workspace yoğunluğunda doğdu ve telefonun yoğunluğuna geçti: aynı süreç yaşadıysa durum korunarak
            # yeniden başlatılır (yeniden başlatılmışsa zaten taze). Arka planda: WindowManager kilidini tutmayız.
            self._density.schedule_settle(
                window_id, pkg, density_before, display="0", reason="workspace_to_phone", quiet_s=0.3,
                changed_at=changed_at,
            )

        message = f"{pkg} telefonunuza aktarıldı."
        if relaunched:
            message = f"{pkg} telefonunuza aktarıldı (pencere düzeni düzeltilemediği için uygulama yeniden başlatıldı)."

        await self._workspace.park_task(window_id, task_id)
        session.state.handoff_to_phone = True
        session.state.display_id = "0"
        await self._events.emit(
            "app_handoff_to_phone",
            window_id=window_id, package=pkg, display_id="0",
            message=message,
        )
        wlog.info("📱 [WORKSPACE→PHONE] %s telefonda; Workspace'teki yeri korunuyor.", pkg)
        return True

    async def phone_to_workspace(
        self, window_id: str, bounds: TaskBounds | None = None, *, announce: bool = True,
    ) -> bool:
        """Telefona park edilmiş bir Workspace üyesini paylaşımlı VD'ye geri alır.
        `bounds` verilmezse park anındaki yer kullanılır. Telefonda task hâlâ
        yaşıyorsa taşınır; kapatılmışsa aynı yerde sıfırdan başlatılır.

        Paylaşımlı VD park sırasında serbest bırakılmış olabilir — o durumda burada
        yeniden kurulur (yeni anchor ⇒ yeni ws_url; `workspace_task_returned` bunu
        frontend'e taşır). Herhangi bir adım patlarsa üye park halinde KALIR (durum
        değişmez), istisna çağırana yükselir."""
        serial = self._serial_getter()
        session = self._sessions.get(window_id)
        if session is None or not serial:
            return False
        task = self._workspace.get_task(window_id)
        if task is None:
            raise RuntimeError(f"{window_id} Eco Workspace üyesi değil.")
        if not task.parked:
            return True

        wlog = window_logger(__name__, window_id)
        pkg = task.package
        wlog.info("🖥️ [PHONE→WORKSPACE] %s Workspace'e geri alınıyor...", pkg)

        from ..device.deep_navigator import find_task_id_for_package

        task_id = await find_task_id_for_package(self._adb, pkg, display_id="0", serial=serial)
        if not task_id:
            task_id = await find_task_id_for_package(self._adb, pkg, display_id=None, serial=serial)
        density_before, changed_at = await self._density_snapshot_if_changing(pkg, serial, task.density)

        # Merdiven: canlı görev taşınır; taşıma/bağlama başarısız olursa (bayat kimlik) veya görev hiç yoksa
        # (kullanıcı Son Kullanılanlar'dan silmiş) uygulama Workspace'te SIFIRDAN başlatılır.
        outcome = "moved" if task_id else "relaunched"
        try:
            ws_url, stream_w, stream_h, effective = await self._workspace.unpark_task(window_id, task_id, bounds=bounds)
        except Exception as exc:
            if not task_id:
                raise
            wlog.warning("⚠️ [PHONE→WORKSPACE] task=%s bağlanamadı (%s) — %s Workspace'te sıfırdan başlatılıyor", task_id, exc, pkg)
            outcome = "relaunched"
            ws_url, stream_w, stream_h, effective = await self._workspace.unpark_task(window_id, None, bounds=bounds)

        fresh = self._workspace.get_task(window_id)
        self._bind_to_workspace(session, ws_url, stream_w, stream_h, effective)  # eski (durmuş olabilir) sunucuya değil
        session.state.handoff_to_phone = False
        if fresh is not None:
            session.state.render_scale = list(fresh.render_scale)
            session.state.task_density = fresh.density

        if outcome == "moved" and self._density is not None and density_before is not None:
            self._density.schedule_settle(
                window_id, pkg, density_before, display=lambda: self._workspace.display_id,
                reason="phone_to_workspace", quiet_s=0.3, changed_at=changed_at,
            )

        if announce:  # a user's "PC'ye geri al" — not a transport switch's silent return (announce=False)
            await self._events.emit("app_handoff_resolved", window_id=window_id, package=pkg)
            await self._events.emit("app_reclaim_result", window_id=window_id, package=pkg, outcome=outcome)
        await self._events.emit(
            "workspace_task_returned",
            window_id=window_id, package=pkg, ws_url=ws_url,
            bounds=list(effective),
            render_scale=list(fresh.render_scale) if fresh else [1.0, 1.0],
            density=fresh.density if fresh else None,
            display_w=self._workspace.vd_w, display_h=self._workspace.vd_h,
        )
        wlog.info("🖥️ [PHONE→WORKSPACE] %s Workspace'te (bounds=%s).", pkg, effective)
        return True
