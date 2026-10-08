"""Eco Workspace — N adet Android task'ının TEK bir paylaşımlı VirtualDisplay
ve TEK bir MediaCodec/encoder oturumunu paylaşarak freeform pencereler olarak
yaşadığı mod (Karar: Hibrit Pencereleme Faz 3, bkz.
HIBRIT_WINDOWING_VE_TOMURCUK_MIMARISI_PLANI.md §4.1).

Sorumluluk sınırı: bu modül SADECE paylaşımlı VD'nin yaşam döngüsünü ve
içindeki task'ların launch/resize/remove işlemlerini yönetir. WindowManager
tek bir WindowSession ile (workspace_id="eco" işaretli) bunu temsil eder —
TitleBar, focus, minimize gibi her şey mevcut kod yollarından değişmeden
geçer; sadece video KAYNAĞI N görev arasında paylaşılır.

DURUM (gerçek cihaz doğrulaması gerekli): `--activity-launch-bounds` CLI
flag'inin var olup olmadığı ve `dumpsys activity`'nin bounds'u tam olarak bu
regex ile eşleşip eşleşmeyeceği doğrulanmadı. Kod bunu İYİMSER DENE + ÖLÇ +
KANITLANMIŞ FALLBACK'E DÜŞ deseniyle (capability_probe.py'nin encoder_limit
önbellekleme deseninin aynısı) baştan güvenli hale getirdi; ilk gerçek cihaz
turunda tek doğrulanması gereken budur.
"""
from __future__ import annotations

import asyncio
import contextlib
import logging
import math
import re
import uuid
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any, Callable

from ..config import Settings
from ..device import android_shell, daemon_registry
from ..device.adb import Adb
from ..device.device_manager import DeviceNotBoundError
from ..events import EventBus, cancel_and_wait, spawn_background
from ..logging_config import window_logger
from ..schemas import DeviceProfile, WindowState
from ..streams.broadcaster import BroadcasterRegistry
from ..storage import settings_db
from .scrcpy_launcher import ScrcpyServer
from .spawn_profile import bring_up_server
from .task_movement import move_task_to_display
from .task_windowing import FREEFORM, TaskWindowingState, read_task_windowing, settle_task_windowing
from . import surfaceflinger_probe

if TYPE_CHECKING:
    from .window_manager import WindowSession

log = logging.getLogger(__name__)

TaskBounds = tuple[int, int, int, int]  # (left, top, right, bottom) — px, paylaşımlı canvas içinde


def visible_to_android_bounds(bounds: TaskBounds, scale: float = 1.0, max_w: int = 0, max_h: int = 0) -> TaskBounds:
    """Frontend'in gördüğü görünür koordinatlardan Android'in internal task bounds'una dönüştürür.
    Subpixel Kuralı (Bölüm 1.2): Başlangıç ofsetlerinde floor, boyutlarda round uygulanır.
    Sanal ekran sınırlarını aşmayacak şekilde esnek ve güvenli sınırlar üretir."""
    left, top, right, bottom = bounds
    w = max(50, right - left)
    h = max(50, bottom - top)
    left_f = int(math.floor(left))
    top_f = int(math.floor(top))
    if abs(scale - 1.0) < 0.01:
        android_w = round(w)
        android_h = round(h)
    else:
        android_w = round(w / scale)
        android_h = round(h / scale)

    android_right = left_f + android_w
    android_bottom = top_f + android_h
    if max_w > 0:
        android_right = min(max_w, android_right)
    if max_h > 0:
        android_bottom = min(max_h, android_bottom)

    return (max(0, left_f), max(0, top_f), max(left_f + 50, android_right), max(top_f + 50, android_bottom))


def android_to_visible_bounds(bounds: TaskBounds, scale: float) -> TaskBounds:
    """Android dumpsys'ten okunan internal task bounds'unu ekrandaki görünür koordinatlara dönüştürür.
    Subpixel Kuralı (Bölüm 1.2): Başlangıç ofsetlerinde floor, boyutlarda round uygulanır.
    Örn: Android 1143x857 bildiriyorsa ve scale 0.70 ise, ekrandaki görünür kutu 800x600'dür."""
    left, top, right, bottom = bounds
    left_f = int(math.floor(left))
    top_f = int(math.floor(top))
    android_w = max(50, right - left)
    android_h = max(50, bottom - top)
    if abs(scale - 1.0) < 0.01:
        return (left_f, top_f, left_f + round(android_w), top_f + round(android_h))
    vis_w = round(android_w * scale)
    vis_h = round(android_h * scale)
    return (left_f, top_f, left_f + vis_w, top_f + vis_h)


def freeform_start_command(display_id: str, component: str, launch_bounds: TaskBounds | None = None) -> str:
    """`am start` of `component` as a freeform (windowing mode 5) task on `display_id`, optionally placed at
    `launch_bounds` (Android px) — the flag some OEM builds ignore, hence the post-launch resize fallback."""
    placement = f"--activity-launch-bounds {','.join(map(str, launch_bounds))} " if launch_bounds else ""
    return (
        f"am start --display {display_id} --windowingMode 5 {placement}"
        f"-f 0x10000000 --activity-reorder-to-front -n {component}"
    )


def _same_box(a: TaskBounds, b: TaskBounds, tolerance: int = 2) -> bool:
    return all(abs(x - y) <= tolerance for x, y in zip(a, b))


def layout_class(bounds: TaskBounds, density: int) -> tuple[int, int, int, str]:
    """(w_dp, h_dp, smallest_width_dp, label) of a task box at `density` — the size class an app picks its layout
    by (sw ≥ 720 desktop, ≥ 600 tablet, else phone). Log-only."""
    left, top, right, bottom = bounds
    w_dp = round((right - left) * 160 / density)
    h_dp = round((bottom - top) * 160 / density)
    sw_dp = min(w_dp, h_dp)
    label = "Masaüstü (≥720dp)" if sw_dp >= 720 else ("Tablet (≥600dp)" if sw_dp >= 600 else "Telefon (<600dp)")
    return w_dp, h_dp, sw_dp, label

# WindowState.workspace_id için ayrılmış özel değer — gerçek bir Eco
# Workspace ÜYESİ değil, EcoWorkspaceManager'ın kendi dahili "video pump/WS
# routing" iskeletidir. window_manager.py'nin list_windows() ve
# _active_encoder_count()'u bunu FİLTRELER — frontend'e ASLA sızmaz.
ANCHOR_MARKER = "eco-anchor"
ANCHOR_PACKAGE = "com.opendex.eco_workspace"  # "com.opendex" öneki → mirror_packages.is_internal_package() True:
# handoff izleyicisi, kapanıştaki DPI eşitlemesi ve bütçe yeniden dağıtımı onu zaten atlar — ayrı istisna gerekmez.


DENSITY_MODES = ("auto", "manual")

# A member that Android (or the OEM's small-window layer) shrank on its own — swipe-up to a floating ball, idle auto-collapse —
# is told from one the user merely moved or resized by how much of its box is left: a window moved/resized inside the
# stream keeps most of its area, a ball keeps a sliver.
COLLAPSED_AREA_RATIO = 0.35


@dataclass(frozen=True)
class MemberCheck:
    """`EcoWorkspaceManager.verify_member`: ok (matches the ledger) | healed (it had collapsed and was put back) | failed
    (collapsed, could not be put back) | unknown (not readable / not on the Workspace display) | absent (no live member)."""

    status: str
    reason: str | None = None
    bounds: TaskBounds | None = None


def collapse_reason(state: TaskWindowingState, expected_android: TaskBounds, workspace_display: str | None) -> str | None:
    """Why a Workspace member's real state is NOT what the ledger says, or None when it is fine / cannot be told.
    Only a POSITIVE reading counts: an unreadable state, or a task that stands on another display (parked on the phone, popped
    out), is never "collapsed" — those flows have their own owners."""
    if not state.found:
        return None
    if workspace_display and state.display_id not in (None, str(workspace_display)):
        return None
    if state.windowing_mode is not None and state.windowing_mode != FREEFORM:
        return f"kip={state.mode_name}"
    if state.visible is False:
        return "görünmez"
    if state.bounds is not None:
        have = (state.bounds[2] - state.bounds[0]) * (state.bounds[3] - state.bounds[1])
        want = (expected_android[2] - expected_android[0]) * (expected_android[3] - expected_android[1])
        if want > 0 and have < want * COLLAPSED_AREA_RATIO:
            return f"küçülmüş ({have}px² < %{COLLAPSED_AREA_RATIO * 100:.0f} × {want}px²)"
    return None


@dataclass
class WorkspaceTask:
    window_id: str
    package: str
    task_id: str
    bounds: TaskBounds
    render_scale: tuple[float, float] = (1.0, 1.0)
    density: int | None = None
    # "auto": yoğunluğu OpenDeX görev boyutuna göre hesaplar (yeniden boyutlandırmada yeniden hesaplanır);
    # "manual": kullanıcı sabitledi — boyutlandırma yoğunluğa DOKUNMAZ. Karar tek yerde (burada) tutulur ki
    # Workspace çerçevesi, Sub-PiP ve DeX-içi kırpma penceresi AYNI kararı versin (eskiden yalnızca ana
    # pencerenin ön yüz belleğindeydi; ayrı JS dünyasındaki PiP göremiyordu).
    density_mode: str = "auto"
    # True ⇒ Android task'ı şu an Display 0'da (telefonda) yaşıyor; Workspace'teki
    # YERİ (bounds/yoğunluk tercihi) korunuyor ama paylaşımlı VD'ye hiçbir maliyeti
    # yok.
    parked: bool = False


class EcoWorkspaceManager:
    """Cihaz bağlı olduğu sürece EN FAZLA bir paylaşımlı Eco Workspace VD'si
    tutar (Karar: basitlik — çoklu workspace kavramı mimari planın kapsamında
    yok, gereksiz karmaşıklık olurdu).

    Video pump / WS routing kimliği: `session_reconfigure.start_video_pump(session)`
    broadcaster kimliğini `session.state.window_id`'den ÇAĞRILDIĞI ANDA
    closure'a gömer; bu yüzden "hangi üye ilk açıldıysa o owner'dır, ayrılırsa
    devredilir" tasarımı ÇALIŞMAZ (devir, zaten akan görevin closure'ını
    değiştirmez). Çözüm: paylaşımlı VD oluşturulduğunda, hiçbir gerçek
    pencereye ait OLMAYAN, sadece bu sınıfın kendi kullandığı sabit bir
    "anchor" WindowSession yaratılır (`self._anchor`) — WS routing/pump ömrü
    boyunca SABİT kalır, üyelerin gelip gitmesinden tamamen bağımsızdır."""

    DEFAULT_BOUNDS: TaskBounds = (120, 60, 1560, 960)

    # Android applies a move, a density and bounds ASYNCHRONOUSLY: right after them a read still returns where the task
    # WAS. The bounds are read again until two readings agree (see _settled_effective_bounds).
    SETTLE_STEP_S = 0.12
    SETTLE_TRIES = 5
    SETTLE_NEAR_PX = 24      # "where we asked": the same slack the launch-bounds probe allows for system insets

    def __init__(
        self,
        adb: Adb,
        settings: Settings,
        events: EventBus,
        sessions: dict[str, "WindowSession"],
        *,
        serial_getter: Callable[[], str | None],
        profile_getter: Callable[[], DeviceProfile | None],
        start_video_pump: Callable[["WindowSession"], None],
        broadcasters: BroadcasterRegistry | None = None,
        daemon_client_getter: Callable[[], Any] | None = None,
    ) -> None:
        self._adb = adb
        self._settings = settings
        self._events = events
        self._sessions = sessions  # WindowManager'ın AYNI sözlüğü — kopya değil
        # Paylaşımlı VD ölünce anchor'ın broadcaster'ı kayıt defterinden düşürülüp
        # bağlı WS istemcilerine CLOSE_SENTINEL gönderilmeli — aksi halde decoder'lar
        # (ana pencere + açık Sub-PiP'ler) ölü bir kuyrukta sessizce bekler.
        self._broadcasters = broadcasters
        self._serial_getter = serial_getter
        self._profile_getter = profile_getter
        self._start_video_pump = start_video_pump
        # WindowManager's daemon client (injected like every other collaborator here; this used to reach for the
        # module-global active-client lookup from two different import sites).
        self._daemon_client_getter = daemon_client_getter or (lambda: None)

        self._server: ScrcpyServer | None = None
        self._display_id: str | None = None
        self._anchor: "WindowSession | None" = None
        self._tasks: dict[str, WorkspaceTask] = {}  # window_id -> WorkspaceTask
        self._vd_w: int | None = None
        self._vd_h: int | None = None

    # ------------------------------------------------------------------ durum

    def _live_tasks(self) -> list[WorkspaceTask]:
        """Paylaşımlı VD'de GERÇEKTEN yaşayanlar — telefona park edilmişler hariç."""
        return [t for t in self._tasks.values() if not t.parked]

    @property
    def is_active(self) -> bool:
        return self._server is not None and bool(self._live_tasks())

    def live_task_ids(self) -> list[str]:
        return [t.window_id for t in self._live_tasks()]

    @property
    def member_count(self) -> int:
        return len(self._live_tasks())

    @property
    def display_id(self) -> str | None:
        return self._display_id

    @property
    def vd_w(self) -> int:
        return self._vd_w or self._settings.ECO_WORKSPACE_DISPLAY_W

    @property
    def vd_h(self) -> int:
        return self._vd_h or self._settings.ECO_WORKSPACE_DISPLAY_H

    @property
    def server(self) -> ScrcpyServer | None:
        return self._server

    def get_task(self, window_id: str) -> WorkspaceTask | None:
        return self._tasks.get(window_id)

    # ------------------------------------------------------------------ paylaşımlı VD

    async def _ensure_shared_display(self) -> ScrcpyServer:
        if self._server is not None and self._server.is_alive:
            return self._server

        serial = self._serial_getter()
        if not serial:
            raise DeviceNotBoundError()

        server = ScrcpyServer(self._adb, self._settings, serial, daemon=self._daemon_client_getter())
        sockets = await bring_up_server(server, lambda: server.spawn(
            new_display=f"{self._settings.ECO_WORKSPACE_DISPLAY_W}x{self._settings.ECO_WORKSPACE_DISPLAY_H}",
            dpi=self._settings.ECO_WORKSPACE_DPI,
            max_size=0,
            video_bit_rate=self._settings.DEFAULT_VIDEO_BIT_RATE,
            max_fps=self._settings.DEFAULT_MAX_FPS,
            control=True,
            send_frame_meta=True,
            flex_display=False,  # paylaşımlı VD boyutu sabit — flex tek-pencere teleport'a özgü
            video_codec="auto",
        ))
        self._server = server
        self._display_id = str(server.display_id or "")

        # ONE adb round trip (`;`: each command independent of the others' failure): non-resizable apps may be freeform
        # windows on the shared display. Only what the Workspace itself needs is written, and NEVER a setting of the
        # phone's own UI: `enable_freeform_support` / `force_resizable_activities` were already written when the device
        # was bound (window_manager.bind_device), and `hide_gesture_line` — the user's own gesture-bar choice (Xiaomi/
        # HyperOS) — was DELETED here on every open, which made SystemUI reset the phone's gesture handling. The virtual
        # display hides its own nav bar locally (scrcpy vd_system_decorations=false); the phone's gestures are not ours
        # to touch. The display-scoped commands (`-d <id>`) cannot reach the physical screen.
        display_cmds = (
            f"; wm set-display-windowing-mode -d {self._display_id} 5; cmd window set-ignore-orientation -d {self._display_id} true"
            if self._display_id else ""
        )
        with contextlib.suppress(Exception):
            await self._adb.shell(
                "settings put secure force_resizable_activities 1; settings put global enable_non_resizable_multi_window 1; "
                "wm set-multi-window-config --supportsNonResizable 1 --respectsActivityMinWidthHeight -1" + display_cmds,
                serial=serial,
            )

        from .window_manager import WindowSession  # döngüsel import'tan kaçınmak için burada

        self._vd_w = self._settings.ECO_WORKSPACE_DISPLAY_W
        self._vd_h = self._settings.ECO_WORKSPACE_DISPLAY_H
        if self._display_id:
            size = await android_shell.read_display_size(self._adb, serial, self._display_id)
            if size:
                self._vd_w, self._vd_h = size
            log.info(
                "🌱 [ECO WORKSPACE] VD gerçek boyut: %dx%d (istenen: %dx%d)",
                self._vd_w, self._vd_h,
                self._settings.ECO_WORKSPACE_DISPLAY_W, self._settings.ECO_WORKSPACE_DISPLAY_H,
            )

        anchor_id = f"eco-anchor-{uuid.uuid4().hex[:10]}"
        stream_w = sockets.video_meta.width if sockets.video_meta else self.vd_w
        stream_h = sockets.video_meta.height if sockets.video_meta else self.vd_h
        anchor_state = WindowState(
            window_id=anchor_id, package=ANCHOR_PACKAGE,
            width=stream_w, height=stream_h,
            display_id=self._display_id, ws_url=f"/ws/video/{anchor_id}",
            workspace_id=ANCHOR_MARKER,
        )
        anchor_session = WindowSession(
            state=anchor_state, server=server,
            target_display_w=self.vd_w,
            target_display_h=self.vd_h,
            stream_w=stream_w, stream_h=stream_h,
            dpi=self._settings.ECO_WORKSPACE_DPI,
            max_fps=self._settings.DEFAULT_MAX_FPS,
            video_bit_rate=self._settings.DEFAULT_VIDEO_BIT_RATE,
            max_size=0,
        )
        # WindowManager'ın PAYLAŞTIĞI sözlüğe yazılır — /ws/video/{anchor_id}
        # normal get_session(window_id) yoluyla, websockets.py'de HİÇBİR
        # değişiklik gerekmeden çalışır.
        self._sessions[anchor_id] = anchor_session
        self._start_video_pump(anchor_session)
        self._anchor = anchor_session

        log.info("🌱 [ECO WORKSPACE] Paylaşımlı VD oluşturuldu (disp_id=%s, anchor=%s)", self._display_id, anchor_id)
        return server

    def notify_anchor_pump_terminated(self, window_id: str) -> None:
        """session_reconfigure.py'nin pump wrapper'ı, HERHANGİ bir session'ın
        video pompası bittiğinde çağırır — burada sadece bu window_id gerçekten
        BU yöneticinin kendi anchor'ıysa tepki verilir. Hem normal teardown'ı
        (`_teardown_if_empty` zaten anchor.pump_task'ı iptal edip bekliyor —
        bu metodun pompa bitince tetiklenmesi orada da zararsızca çakışır,
        state zaten temizdi) HEM DE dışarıdan/Android tarafından VD çöktüğünde
        hiçbir normal teardown çağrısı hiç yapılmadan pompanın kendiliğinden
        bitmesi durumunu kapsar — ikinci durum, düzeltilmeden önce, hayalet
        anchor oturumunun sonsuza dek encoder bütçesinde bir slot işgal
        etmesine yol açıyordu."""
        if self._anchor is None or self._anchor.state.window_id != window_id:
            return
        anchor_id = self._anchor.state.window_id
        # VD öldü: CANLI üyelerin Android task'ları onunla birlikte gitti — onların
        # oturumları da düşer (aksi halde frontend'de hayalet çerçeve kalır).
        # TELEFONA PARK EDİLMİŞ üyeler hayatta: task'ları Display 0'da, defter
        # kaydı ve oturumları korunur (tekrar Workspace'e alınabilirler).
        dead_members = [wid for wid, t in self._tasks.items() if not t.parked]
        for wid in dead_members:
            self._tasks.pop(wid, None)
            self._sessions.pop(wid, None)
        self._sessions.pop(anchor_id, None)
        if self._broadcasters is not None:
            self._broadcasters.remove(anchor_id)
        if dead_members:
            with contextlib.suppress(RuntimeError):  # no running loop: nobody to tell
                for wid in dead_members:
                    spawn_background(self._events.emit("workspace_task_removed", window_id=wid))
        self._forget_shared_display()
        log.warning("🧹 [ECO WORKSPACE] Hayalet anchor oturumu (%s) video pompası koptuğu için temizlendi.", anchor_id)

    def _forget_shared_display(self) -> None:
        """No shared VD any more (torn down, or died under us): the next member creates a fresh one."""
        self._server = None
        self._display_id = None
        self._anchor = None
        self._vd_w = None
        self._vd_h = None

    async def _teardown_if_empty(self) -> None:
        if self._live_tasks() or self._server is None:
            return
        anchor = self._anchor
        if anchor is not None and self._broadcasters is not None:
            # İstemciler kaynak yıkımından ÖNCE haberdar edilir (close_window ile aynı sıra).
            self._broadcasters.remove(anchor.state.window_id)
        if anchor is not None:
            await cancel_and_wait(anchor.pump_task)
        with contextlib.suppress(Exception):
            await self._server.stop()
        if anchor is not None:
            self._sessions.pop(anchor.state.window_id, None)
        self._forget_shared_display()
        log.info("🌱 [ECO WORKSPACE] Son üye ayrıldı, paylaşımlı VD imha edildi.")

    # ------------------------------------------------------------------ launch-bounds probe & freeform scale bridge

    async def _get_freeform_scale(self, serial: str) -> float:
        """Cihazın freeform pencere görsel ölçeğini döner (Xiaomi HyperOS / MIUI = 0.70, AOSP = 1.0).
        Önbellekte varsa doğrudan döner; yoksa dumpsys window üzerinden probe edip kaydeder."""
        profile = self._profile_getter()
        scale_cached = profile.freeform_scale if profile else None
        if scale_cached is not None:
            return scale_cached
        try:
            # Once per device (cached in its profile). The daemon reads the window service's dump in-process.
            daemon = daemon_registry.live("dump")
            out = await daemon.dump("window") if daemon is not None else None
            if out is None:
                out = await self._adb.shell("dumpsys window | grep -m 1 mFreeformScale", serial=serial, timeout_s=1.5)
            m = re.search(r"mFreeformScale=([0-9.]+)", out)
            if m:
                val = float(m.group(1))
                if 0.1 <= val <= 2.0:
                    if profile:
                        profile.freeform_scale = val
                        with contextlib.suppress(Exception):
                            await settings_db.save_device_profile(profile.android_id, profile)
                    log.info("🔍 [ECO WORKSPACE] freeform_scale tespit edildi: %.2f (serial=%s)", val, serial)
                    return val
        except Exception as exc:
            log.warning("⚠️ [ECO WORKSPACE] freeform_scale probe hatası: %s", exc)
        return 1.0

    async def _probe_launch_bounds_support(self, serial: str, task_id: str, expected: TaskBounds, *, freeform_scale: float = 1.0) -> bool:
        """`--activity-launch-bounds` fiilen uygulandı mı? Görevin gerçek bounds'u (daemon, yoksa dumpsys —
        `_get_task_actual_bounds`) istenenle karşılaştırılır. Bir kez çalışır, sonuç
        DeviceProfile.supports_launch_bounds'a önbelleklenir."""
        visible = await self._get_task_actual_bounds(serial, task_id, freeform_scale=freeform_scale)
        tolerance = 24  # sistem insets/status bar için küçük piksel toleransı
        return visible is not None and all(abs(a - e) <= tolerance for a, e in zip(visible, expected))

    async def _get_task_actual_bounds(
        self, serial: str, task_id: str, wlog: logging.Logger | None = None, *, freeform_scale: float = 1.0,
    ) -> TaskBounds | None:
        """Task'ın Android WM'deki GERÇEK fiziksel bounds'unu (görünür koordinatlara çevrilmiş) okur.
        0. Daemon-First (En Hızlı, ~1ms):
           opendex-tools.jar daemon'u üzerinden in-memory WindowConfiguration sorgusu.
        1. Yedek: `dumpsys activity activities <task>` çıktısından bounds ayrıştırması.

        Başlık (caption) ve alt inset yüksekliği BİLEREK okunmaz: Workspace görevleri kırpılmaz /
        boyanmaz, görüntü olduğu gibi gösterilir.
        """
        daemon_fallback_reason: str | None = None

        # 0. Daemon-First Fast Path: in-memory Binder IPC (< 2ms)
        daemon = self._daemon_client_getter()
        if daemon and daemon.is_connected:
            try:
                geom = await daemon.get_task_geometry(task_id)
                if geom and geom.get("ok") and "bounds" in geom:
                    actual = tuple(geom["bounds"])
                    if len(actual) == 4 and (actual[2] - actual[0] >= 100) and (actual[3] - actual[1] >= 100):
                        visible = android_to_visible_bounds(actual, freeform_scale)  # type: ignore[arg-type]
                        if wlog:
                            wlog.info(
                                "⚡ [ECO WM:DAEMON_HIT] task=%s Geometri DAEMON'dan okundu (0ms shell): "
                                "android_bounds=%s -> visible_bounds=%s (scale=%.2f)",
                                task_id, actual, visible, freeform_scale,
                            )
                        return visible
                    else:
                        daemon_fallback_reason = f"geçersiz/küçük bounds ({actual})"
                else:
                    err_msg = geom.get("error", "yanıt başarısız") if geom else "yanıt boş"
                    daemon_fallback_reason = f"daemon sorgusu olumsuz ({err_msg})"
            except Exception as exc:
                daemon_fallback_reason = f"daemon istisnası ({exc})"
        elif daemon:
            daemon_fallback_reason = "daemon soketi bağlı değil"
        else:
            daemon_fallback_reason = "daemon istemcisi aktif değil"

        if wlog and daemon_fallback_reason:
            wlog.info(
                "⚠️ [ECO WM:FALLBACK_TO_DUMPSYS] task=%s Daemon kullanılamadı (%s) -> DUMPSYS yedek yoluna düşülüyor",
                task_id, daemon_fallback_reason,
            )

        try:
            # Yalnızca daemon yokken ya da yukarıdaki hızlı yol cevap veremediğinde.
            raw = await self._adb.shell(f"dumpsys activity activities {task_id}", serial=serial, timeout_s=2.5)
            # Dumpsys activity activities tüm sistemi döker. Spesifik task bloğunu izole et:
            m_block = re.search(rf"\* Task\{{[^\n]*#{task_id}\b.*?(?=\n  \* Task\{{|\n\s*Display #|\Z)", raw, re.DOTALL)
            target_raw = m_block.group(0) if m_block else raw

            if wlog:
                relevant_lines = [
                    line.strip()
                    for line in target_raw.splitlines()
                    if any(k in line.lower() for k in ("bounds", "rect", "windowingmode", "resizemode", "aspect", "orientation"))
                ]
                wlog.info("🔍 [ECO WM:DUMPSYS] task=%s WM dump satırları:\n  %s", task_id, "\n  ".join(relevant_lines[:15]) if relevant_lines else "(ilgili satır yok)")

            # Dumpsys çıktısındaki mGlobalConfig={...} ve mOverrideConfig={...} blokları
            # eski/geçmiş snapshot'ları tuttuğundan regex'in bunlardaki eski değerlere takılmasını engellemek için temizle:
            clean_raw = re.sub(r"m(?:Global|Override)Config=\{.*?\}\s*(?=[a-zA-Z]|\n)", "", target_raw, flags=re.DOTALL)

            for pattern in (
                r"^\s*mBounds=Rect\((\d+),\s*(\d+)\s*-\s*(\d+),\s*(\d+)\)",
                r"^\s*bounds=Rect\((\d+),\s*(\d+)\s*-\s*(\d+),\s*(\d+)\)",
                r"CurrentConfiguration=\{.*?mAppBounds=Rect\((\d+),\s*(\d+)\s*-\s*(\d+),\s*(\d+)\)",
                r"CurrentConfiguration=\{.*?mBounds=Rect\((\d+),\s*(\d+)\s*-\s*(\d+),\s*(\d+)\)",
                r"mBounds=Rect\((\d+),\s*(\d+)\s*-\s*(\d+),\s*(\d+)\)",
                r"mAppBounds=Rect\((\d+),\s*(\d+)\s*-\s*(\d+),\s*(\d+)\)",
                r"taskBounds=Rect\((\d+),\s*(\d+)\s*-\s*(\d+),\s*(\d+)\)",
                r"bounds=Rect\((\d+),\s*(\d+)\s*-\s*(\d+),\s*(\d+)\)",
                r"bounds=\[(\d+),(\d+)\]\[(\d+),(\d+)\]",
            ):
                m = re.search(pattern, clean_raw, re.MULTILINE)
                if not m and "CurrentConfiguration" in pattern:
                    m = re.search(pattern, clean_raw, re.DOTALL)
                if m:
                    actual = tuple(int(g) for g in m.groups())
                    # Sistem insets veya durum çubuğu gibi < 100px minik kutuları filtrele
                    if (actual[2] - actual[0] >= 100) and (actual[3] - actual[1] >= 100):
                        visible = android_to_visible_bounds(actual, freeform_scale)  # type: ignore[arg-type]
                        if wlog:
                            wlog.info(
                                "🎯 [ECO WM:ACTUAL_FOUND] task=%s android_bounds=%s -> visible_bounds=%s (scale=%.2f, pattern=%s)",
                                task_id, actual, visible, freeform_scale, pattern,
                            )
                        return visible
        except Exception as exc:
            if wlog:
                wlog.warning("⚠️ [ECO WM:DUMPSYS_ERR] task=%s dumpsys okunamadı: %s", task_id, exc)
        return None

    async def _get_task_effective_bounds(
        self, serial: str, task_id: str, requested: TaskBounds, wlog: logging.Logger | None = None,
    ) -> tuple[TaskBounds, tuple[float, float]]:
        """1. Öncelik: SurfaceFlinger fiziksel görünür alan (GPU gerçeği, Omni-Adapter)
           2. Fallback: WindowManager / Daemon actual visible bounds
           3. Son çare: İstenen hedef kutu
           Döner: (bounds, (scale_x, scale_y))
        """
        freeform_scale = await self._get_freeform_scale(serial)
        wm_bounds = await self._get_task_actual_bounds(serial, task_id, wlog, freeform_scale=freeform_scale)

        # Öncelik 1: SurfaceFlinger Omni-Adapter (GPU gerçeği, OEM leashing/scale'i çözen tek yer)
        geom = await surfaceflinger_probe.probe_omni_geometry(self._adb, serial, task_id)
        if geom and geom.render_bounds:
            scale_x = geom.scale_x if geom.scale_x > 0.1 else freeform_scale
            scale_y = geom.scale_y if geom.scale_y > 0.1 else freeform_scale
            if scale_x > 0.1 and abs(scale_x - 1.0) > 0.02:
                profile = self._profile_getter()
                if profile and profile.freeform_scale != scale_x:
                    profile.freeform_scale = scale_x
                    with contextlib.suppress(Exception):
                        await settings_db.save_device_profile(profile.android_id, profile)
            if wlog:
                wlog.info(
                    "🎯 [OMNI-ADAPTER] task=%s Render: %s, Scale: (%.2f, %.2f)",
                    task_id, geom.render_bounds, scale_x, scale_y,
                )
            return geom.render_bounds, (scale_x, scale_y)

        # Fallback 1: WindowManager / Daemon doğrudan doğrulanmış görünür bounds
        if wm_bounds:
            if wlog:
                wlog.info("⚠️ [OMNI-ADAPTER] SurfaceFlinger boş, WM bounds kullanılıyor: %s (scale=%.2f)", wm_bounds, freeform_scale)
            return wm_bounds, (freeform_scale, freeform_scale)

        # Fallback 2: İstenen hedef
        return requested, (1.0, 1.0)

    async def _settled_effective_bounds(
        self, serial: str, task_id: str, requested: TaskBounds, wlog: logging.Logger | None = None,
    ) -> tuple[TaskBounds, tuple[float, float]]:
        """`_get_task_effective_bounds` once Android has finished placing the task. One read at a fixed delay returned the
        place the task had been (after a phone -> Workspace move: the phone's), so the frame in the UI sat somewhere
        else than the app. The cheap window-manager reading is repeated until two consecutive readings agree — at once
        when they also sit where the task was asked to go, after at least one more reading when they do not (Android
        may legitimately place it elsewhere: minimum size, insets) — and only then the full reading is taken."""
        freeform_scale = await self._get_freeform_scale(serial)
        previous: TaskBounds | None = None
        for attempt in range(self.SETTLE_TRIES):
            await asyncio.sleep(self.SETTLE_STEP_S)
            seen = await self._get_task_actual_bounds(serial, task_id, freeform_scale=freeform_scale)
            if seen is None:
                break                                          # unreadable: nothing to wait for, the full reading decides
            if previous is not None and _same_box(seen, previous) and (attempt >= 2 or _same_box(seen, requested, self.SETTLE_NEAR_PX)):
                break
            previous = seen
        return await self._get_task_effective_bounds(serial, task_id, requested, wlog)

    # ------------------------------------------------------------------ launch / attach / resize / remove

    async def _finalize_task_registration(
        self,
        window_id: str,
        package: str,
        task_id: str,
        target_bounds: TaskBounds,
        serial: str,
        wlog,
        server,
        *,
        settle_log_tag: str,
        density: int | None = None,
    ) -> tuple[str, int, int, TaskBounds]:
        """Common tail of open_in_workspace/attach_existing_task once the
        task is placed on the shared VD: set its density (BEFORE the readback: a density change moves the minimum task
        size in pixels, and Android grows the task to comply — after the readback nobody would hear of it), wait for
        the WM layout to settle, read back the real (Android-adjusted) bounds, register the task, and
        emit workspace_task_added."""
        if density:
            await self._daemon_set_task_density(task_id, density)
        effective_bounds, scale = await self._settled_effective_bounds(serial, task_id, target_bounds, wlog)
        wlog.info(
            "🔬 [ECO WORKSPACE:%s] %s (task=%s) -> effective=%s (hedef: %s, scale=%s)",
            settle_log_tag, package, task_id, effective_bounds, target_bounds, scale,
        )

        self._tasks[window_id] = WorkspaceTask(
            window_id=window_id, package=package, task_id=task_id, bounds=effective_bounds,
            render_scale=scale,
        )
        await self._events.emit(
            "workspace_task_added",
            window_id=window_id, package=package, bounds=list(effective_bounds),
            render_scale=list(scale),
            density=None,
        )

        stream_w, stream_h = self._stream_dims(server)
        return self._ws_url(), stream_w, stream_h, effective_bounds

    async def open_in_workspace(
        self,
        package: str,
        window_id: str,
        *,
        bounds: TaskBounds | None = None,
        density: int | None = None,
    ) -> tuple[str, int, int, TaskBounds]:
        """Paylaşımlı VD'de YENİ bir freeform task başlatır (`am start`).
        Döner: (ws_url, stream_w, stream_h, effective_bounds)."""
        serial = self._serial_getter()
        if not serial:
            raise DeviceNotBoundError()
        target_bounds = bounds or self.DEFAULT_BOUNDS
        wlog = window_logger(__name__, window_id)

        server = await self._ensure_shared_display()
        assert self._display_id

        from ..device.deep_navigator import find_task_id_for_package

        component = await self._launch_component(serial, package)

        profile = self._profile_getter()
        try_bounds_flag = profile is None or profile.supports_launch_bounds is not False
        freeform_scale = await self._get_freeform_scale(serial)
        android_target = visible_to_android_bounds(target_bounds, freeform_scale)
        wlog.info("🌱 [ECO WORKSPACE:OPEN_REQ] %s -> Hedef Bounds: %s (Android: %s, Scale: %.2f), Component: %s, Display: %s",
                  package, target_bounds, android_target, freeform_scale, component, self._display_id)

        launched = False
        if try_bounds_flag:
            with contextlib.suppress(Exception):
                await self._adb.shell(
                    freeform_start_command(self._display_id, component, android_target), serial=serial, timeout_s=3.0,
                )
                launched = True
                wlog.info("🌱 [ECO WORKSPACE:LAUNCHED] am start --activity-launch-bounds ile çalıştırıldı.")
        if not launched:
            await self._adb.shell(freeform_start_command(self._display_id, component), serial=serial, timeout_s=3.0)
            wlog.info("🌱 [ECO WORKSPACE:LAUNCHED] am start (bounds bayrağı olmadan) çalıştırıldı.")

        moved = False
        task_id = await find_task_id_for_package(self._adb, package, display_id=self._display_id, serial=serial)
        if not task_id:
            # Fallback to global search across entire device
            task_id = await find_task_id_for_package(self._adb, package, display_id=None, serial=serial)
            if task_id:
                # Task was running on another display; move it to this shared workspace display
                moved = True
                wlog.info("🌱 [ECO WORKSPACE:MOVE_TASK] %s (task=%s) paylaşımlı ekrana (%s) taşınıyor...", package, task_id, self._display_id)
                with contextlib.suppress(Exception):
                    await move_task_to_display(self._adb, task_id, self._display_id, serial=serial)

        if not task_id:
            # Brief retry after WM settles
            await asyncio.sleep(0.25)
            task_id = await find_task_id_for_package(self._adb, package, display_id=None, serial=serial)

        if not task_id:
            raise RuntimeError(f"{package} paylaşımlı çalışma alanında başlatılamadı (task_id bulunamadı).")

        # Resizable, and freeform: a fresh launch already is (`--windowingMode 5`); a task found on another display and
        # moved here keeps whatever mode it requested there — set it, verified (nothing is sent when it already is).
        with contextlib.suppress(Exception):
            await self._adb.shell(f"cmd activity task resizeable {task_id} 2", serial=serial)
        if moved:
            await self._make_freeform(serial, task_id, package, android_target, wlog, skip_if_ok=True)

        if try_bounds_flag and profile is not None and profile.supports_launch_bounds is None:
            supported = await self._probe_launch_bounds_support(serial, task_id, target_bounds, freeform_scale=freeform_scale)
            profile.supports_launch_bounds = supported
            with contextlib.suppress(Exception):
                await settings_db.save_device_profile(profile.android_id, profile)
            wlog.info("🔬 [ECO WORKSPACE] launch-bounds probe sonucu: supports=%s", supported)
            try_bounds_flag = supported

        if not try_bounds_flag:
            # Kanıtlanmış fallback: launch sonrası konumlandırma (am start
            # sırasında bounds flag'i yoksayıldıysa veya hiç yoksa).
            await self._resize_task_to(serial, task_id, android_target, wlog, "FALLBACK_RESIZE_OUT")

        # Android istenen bounds'u aynen vermek ZORUNDA DEĞİL (min genişlik,
        # insets, aspect kısıtları). React çerçevesi GERÇEK kutuyu sarmalı,
        # yoksa çerçeve ile freeform penceresi birbirini tutmaz.
        return await self._finalize_task_registration(
            window_id, package, task_id, target_bounds, serial, wlog, server,
            settle_log_tag="OPEN_EFFECTIVE", density=density,
        )

    async def attach_existing_task(
        self, package: str, window_id: str, task_id: str, *, bounds: TaskBounds | None = None, density: int | None = None,
    ) -> tuple[str, int, int, TaskBounds]:
        """Zaten çalışan bir task'ı (başka bir VD'den taşınmış — Dock akışı)
        Eco Workspace'e KAYDEDER. `am start` ÇAĞIRMAZ, sadece move-stack +
        defter kaydı yapar. task_teleporter.dock_to_workspace() kullanır."""
        serial = self._serial_getter()
        if not serial:
            raise DeviceNotBoundError()
        target_bounds = bounds or self.DEFAULT_BOUNDS
        wlog = window_logger(__name__, window_id)
        server = await self._ensure_shared_display()
        assert self._display_id
        wlog.info("🏠 [ECO WORKSPACE:ATTACH_START] %s (task=%s) -> target_display=%s, bounds=%s", package, task_id, self._display_id, target_bounds)
        try:
            await move_task_to_display(self._adb, task_id, self._display_id, serial=serial)
            wlog.info("🏠 [ECO WORKSPACE:MOVE_STACK_OK] task=%s display=%s üzerine taşındı", task_id, self._display_id)
        except Exception as exc:
            wlog.warning("⚠️ [ECO WORKSPACE:MOVE_STACK_WARN] move_task_to_display uyarısı: %s", exc)

        try:
            res_res = await self._adb.shell(f"cmd activity task resizeable {task_id} 2", serial=serial)
            wlog.info("🏠 [ECO WORKSPACE:RESIZEABLE] task=%s res=%r", task_id, res_res.strip())
        except Exception as exc:
            wlog.warning("⚠️ [ECO WORKSPACE:RESIZEABLE_ERR] %s", exc)

        component = await self._launch_component(serial, package)
        freeform_scale = await self._get_freeform_scale(serial)
        android_target = visible_to_android_bounds(target_bounds, freeform_scale)

        try:
            res_start = await self._adb.shell(
                freeform_start_command(self._display_id, component, android_target), serial=serial, timeout_s=3.0,
            )
            wlog.info("🏠 [ECO WORKSPACE:AM_START_DOCK] %s res=%r", component, res_start.strip())
        except Exception as exc:
            wlog.warning("⚠️ [ECO WORKSPACE:AM_START_DOCK_ERR] %s", exc)

        wlog.info("🔬 [ECO WORKSPACE:DOCK_REQ] %s (task=%s) -> Hedef Bounds: %s (Android: %s, Scale: %.2f)",
                  package, task_id, target_bounds, android_target, freeform_scale)
        # The task arrives with the mode it requested where it was — FULLSCREEN when it comes back from the phone (pinned
        # there) or from its own window. `am start --windowingMode 5` above does not change an existing task's mode, so
        # it is set here, together with its box, and verified: the task returns as a freeform window, not fullscreen.
        await self._make_freeform(serial, task_id, package, android_target, wlog, skip_if_ok=False)

        ws_url, stream_w, stream_h, effective_bounds = await self._finalize_task_registration(
            window_id, package, task_id, target_bounds, serial, wlog, server,
            settle_log_tag="ACTUAL_BOUNDS", density=density,
        )
        wlog.info("🌱 [ECO WORKSPACE] %s dock ile katıldı (task=%s, bounds=%s, freeform_coerced=%s)", package, task_id, effective_bounds, component)
        return ws_url, stream_w, stream_h, effective_bounds

    async def _make_freeform(
        self, serial: str, task_id: str, package: str, android_bounds: TaskBounds, wlog, *, skip_if_ok: bool,
    ) -> None:
        """The task's requested windowing mode → freeform, placed at ``android_bounds`` (Android px) and verified
        (task_windowing.settle_task_windowing: the daemon's WindowContainerTransaction applies mode and box together; the
        activity is re-laid out with `am start --windowingMode 5` when that did not take). Never raises."""
        try:
            await settle_task_windowing(
                self._adb, serial, str(task_id), package, target="freeform", display_id=self._display_id,
                daemon=self._daemon_client_getter(), wlog=wlog, freeform_bounds=tuple(android_bounds),
                skip_if_ok=skip_if_ok,
            )
        except Exception as exc:  # noqa: BLE001 — a failed check must not abort the move; the frame shows what Android gave
            wlog.warning("⚠️ [ECO WORKSPACE:FREEFORM] task=%s serbest kipe alınamadı: %s", task_id, exc)

    async def _launch_component(self, serial: str, package: str) -> str:
        """`pkg/.Activity` of the app's launcher entry, or the bare package when it can't be resolved."""
        from ..device.deep_navigator import _resolve_default_launcher_activity  # call-time: tests patch it there

        activity = await _resolve_default_launcher_activity(self._adb, serial, package)
        return activity if activity and "/" in activity else package

    async def _resize_task_to(self, serial: str, task_id: str, android_bounds: TaskBounds, wlog, tag: str) -> None:
        """Places a freeform task at `android_bounds` (Android px), best effort. Both spellings are sent as they
        always were: on AOSP `am` is only a wrapper script over `cmd activity`, so the second is probably redundant —
        drop it only after a check on the OEM builds (report, P4 notes)."""
        coords = " ".join(map(str, android_bounds))
        for tool in ("cmd activity", "am"):
            with contextlib.suppress(Exception):
                out = await self._adb.shell(f"{tool} task resize {task_id} {coords}", serial=serial, timeout_s=2.0)
                wlog.info("📐 [ECO WORKSPACE:%s] `%s task resize` output: %r", tag, tool, out)

    def _ws_url(self) -> str:
        assert self._anchor is not None
        return self._anchor.state.ws_url

    @staticmethod
    def _stream_dims(server: ScrcpyServer) -> tuple[int, int]:
        if server.sockets and server.sockets.video_meta:
            return server.sockets.video_meta.width, server.sockets.video_meta.height
        return 0, 0

    async def verify_member(self, window_id: str) -> MemberCheck:
        """The user pressed on this member: is the real task what the ledger says (freeform, visible, its box)? If the OS
        collapsed it meanwhile (swipe-up to a floating ball, idle auto-collapse — nothing on the PC side ever told us), it is
        put back: freeform + its box in ONE transaction, brought to the front, and the frame gets the box Android settled on.
        Never changes a healthy task, never raises."""
        task = self._tasks.get(window_id)
        serial = self._serial_getter()
        if task is None or task.parked or not serial or not self._display_id:
            return MemberCheck("absent")
        wlog = window_logger(__name__, window_id)
        try:
            state = await read_task_windowing(self._adb, serial, task.task_id)
            scale = task.render_scale[0] if task.render_scale[0] > 0.1 else 1.0
            android_box = visible_to_android_bounds(task.bounds, scale)
            reason = collapse_reason(state, android_box, self._display_id)
            if reason is None:
                on_workspace = state.found and state.display_id in (None, str(self._display_id))
                return MemberCheck("ok" if on_workspace else "unknown")
            wlog.warning(
                "🩹 [WS-GUARD] %s (task=%s) Workspace'te bozulmuş: %s — mod=%s bounds=%s display=%s görünür=%s; geri yerleştiriliyor",
                task.package, task.task_id, reason, state.mode_name, state.bounds, state.display_id, state.visible,
            )
            await self._make_freeform(serial, task.task_id, task.package, android_box, wlog, skip_if_ok=False)
            with contextlib.suppress(Exception):
                await android_shell.bring_to_front(self._adb, serial, task.package, self._display_id)
            effective, new_scale = await self._settled_effective_bounds(serial, task.task_id, task.bounds, wlog)
            task.bounds, task.render_scale = effective, new_scale
            await self._events.emit(
                "workspace_task_bounds_changed", window_id=window_id, bounds=list(effective), render_scale=list(new_scale),
            )
            after = await read_task_windowing(self._adb, serial, task.task_id)
            still = collapse_reason(after, visible_to_android_bounds(effective, new_scale[0] if new_scale[0] > 0.1 else 1.0), self._display_id)
            if still is None:
                wlog.info("🩹 [WS-GUARD] %s geri yerleştirildi: bounds=%s", task.package, effective)
                return MemberCheck("healed", reason, effective)
            wlog.warning("🩹 [WS-GUARD] %s geri yerleştirilemedi (hâlâ: %s)", task.package, still)
            return MemberCheck("failed", still, effective)
        except Exception as exc:  # noqa: BLE001 — a check must never break the press that triggered it
            wlog.warning("⚠️ [WS-GUARD] task=%s doğrulanamadı: %s", task.task_id, exc)
            return MemberCheck("unknown", str(exc))

    async def resize_task(
        self, window_id: str, bounds: TaskBounds, density: int | None = None, density_mode: str | None = None,
    ) -> TaskBounds | None:
        """Returns the bounds Android actually settled on (what `workspace_task_bounds_changed` carries), or None when
        nothing was resized."""
        task = self._tasks.get(window_id)
        serial = self._serial_getter()
        if not task or task.parked or not serial:
            # parked: task_id artık Display 0'daki TAM EKRAN telefon uygulamasını gösteriyor —
            # `cmd activity task resize` onu bozardı. Slot geometrisi frontend'de yerel kalır
            # ve reclaim isteğiyle birlikte gelir.
            return None
        wlog = window_logger(__name__, window_id)

        # Density MUST be applied BEFORE the resize commands / effective-bounds
        # readback below, not after (as this used to do): changing a task's
        # densityDpi via WCT changes how many pixels satisfy Android's own
        # minimum resizable-task-size (declared in dp) — a box that was legal
        # at the OLD density can suddenly be BELOW that minimum at a NEW,
        # higher one (calculateWorkspaceTaskDpi deliberately raises DPI for
        # smaller boxes), and WindowManagerService silently grows the task to
        # comply. Applying density afterward meant that growth happened AFTER
        # we had already read back "effective" bounds and emitted them as
        # final — the window would then resize ITSELF a second time with no
        # corresponding event ever telling the frontend why ("300x300
        # yapıyorum, commit gidiyor, sonra pencere kendini 400x400 gibi
        # büyütüyor"). Doing it first means the single effective-bounds read
        # below already reflects whatever size Android actually settles on.
        if density is not None and density > 0 and density != task.density:
            await self.set_task_density(window_id, density, mode=density_mode or task.density_mode)
        elif density_mode in DENSITY_MODES:
            task.density_mode = density_mode

        scale = task.render_scale[0] if task.render_scale[0] > 0.1 else (await self._get_freeform_scale(serial))
        android_bounds = visible_to_android_bounds(bounds, scale)
        wlog.info("📐 [ECO WORKSPACE:RESIZE_REQ] %s (task=%s) -> vis_bounds=%s, android_bounds=%s (scale=%.2f, req_density=%s)",
                  task.package, task.task_id, bounds, android_bounds, scale, density)
        with contextlib.suppress(Exception):
            await self._adb.shell(f"cmd activity task resizeable {task.task_id} 2", serial=serial)
        await self._resize_task_to(serial, task.task_id, android_bounds, wlog, "RESIZE_OUT")

        effective, new_scale = await self._settled_effective_bounds(serial, task.task_id, bounds, wlog)
        task.bounds = effective
        task.render_scale = new_scale
        await self._events.emit(
            "workspace_task_bounds_changed",
            window_id=window_id, bounds=list(effective),
            render_scale=list(new_scale),
        )

        active_dpi = task.density or self._settings.ECO_WORKSPACE_DPI
        w_dp, h_dp, sw_dp, label = layout_class(effective, active_dpi)
        wlog.info(
            "📐 [ECO WORKSPACE:RESIZE] %s (task=%s) -> %dx%d px @ %d DPI => %dx%d dp (sw=%ddp: %s) [effective=%s, scale=%s]",
            task.package, task.task_id, effective[2] - effective[0], effective[3] - effective[1], active_dpi,
            w_dp, h_dp, sw_dp, label, effective, new_scale,
        )
        return effective

    async def remove_task(self, window_id: str) -> None:
        """Eco Workspace üyesini kaldırır ve o task'ın Android uygulamasını
        kapatır. Anchor session'a DOKUNMAZ (bkz. sınıf docstring'i) — video
        pump'ı ve WS routing'i etkilenmeden, sadece bu tek üye defterden
        düşer. Son üye ayrılıyorsa `_teardown_if_empty` paylaşımlı VD'yi de
        imha eder."""
        task = self._tasks.pop(window_id, None)
        if not task:
            return
        wlog = window_logger(__name__, window_id)
        serial = self._serial_getter()
        if serial:
            with contextlib.suppress(Exception):
                await self._adb.shell(f"am force-stop {task.package}", serial=serial, timeout_s=2.0)
        await self._events.emit("workspace_task_removed", window_id=window_id)
        wlog.info("🚪 [ECO WORKSPACE] %s kapatıldı (force-stop), kalan üye sayısı=%d", task.package, len(self._tasks))
        await self._teardown_if_empty()

    async def _daemon_set_task_density(self, task_id: str, density: int) -> bool:
        """Task-level densityDpi override via the daemon's WindowContainerTransaction; False when it can't."""
        daemon = self._daemon_client_getter()
        if not (daemon and daemon.is_connected):
            log.warning("⚠️ [ECO WORKSPACE:DENSITY] Daemon aktif değil veya bağlı değil (task=%s).", task_id)
            return False
        try:
            return bool(await daemon.set_task_density(task_id, density))
        except Exception as exc:
            log.warning("⚠️ [ECO WORKSPACE:DENSITY] Daemon RPC hatası (task=%s): %s", task_id, exc)
            return False

    async def park_task(self, window_id: str, task_id: str | None = None) -> WorkspaceTask | None:
        """Üyeyi "telefona park edilmiş" olarak işaretler. Workspace'teki yeri
        (bounds, yoğunluk tercihi) KORUNUR; Android task'ı çağıran tarafından ZATEN
        Display 0'a taşınmış olmalıdır — burada Android'e hiçbir şey yapılmaz.
        Geriye canlı üye kalmadıysa paylaşımlı VD (ve encoder'ı) hemen serbest bırakılır.
        İdempotent: olay-tetikli yol ile açık kullanıcı isteği çakışabilir."""
        task = self._tasks.get(window_id)
        if task is None:
            return None
        if task_id:
            task.task_id = task_id
        if task.parked:
            return task
        task.parked = True
        window_logger(__name__, window_id).info(
            "📱 [ECO WORKSPACE] %s telefona park edildi (yeri korunuyor), canlı üye sayısı=%d",
            task.package, len(self._live_tasks()),
        )
        await self._teardown_if_empty()
        return task

    async def unpark_task(
        self, window_id: str, task_id: str | None, *, bounds: TaskBounds | None = None,
    ) -> tuple[str, int, int, TaskBounds]:
        """Park edilmiş üyeyi paylaşımlı VD'ye geri alır. `task_id` verilirse (telefonda
        hâlâ yaşıyor) taşınır (attach_existing_task); verilmezse (uygulama telefonda
        kapatılmış) park edilen yerde SIFIRDAN başlatılır (open_in_workspace).
        Park sırasında task'a telefon DPI'ı yazılmıştı — burada Workspace yoğunluğu geri
        yüklenir (aksi halde görev 520 DPI ile 160 DPI'lık VD'de çift yoğun görünür)."""
        parked = self._tasks.get(window_id)
        if parked is None or not parked.parked:
            raise RuntimeError(f"{window_id} telefona park edilmiş bir Workspace üyesi değil.")
        slot = bounds or parked.bounds
        remembered = parked.density
        target = remembered or self._settings.ECO_WORKSPACE_DPI
        try:
            if task_id:
                result = await self.attach_existing_task(parked.package, window_id, task_id, bounds=slot, density=target)
            else:
                result = await self.open_in_workspace(parked.package, window_id, bounds=slot, density=target)
        except Exception:
            # _ensure_shared_display() başarılı olup sonraki adım patladıysa paylaşımlı VD
            # canlı üyesiz kalır — sızdırma.
            await self._teardown_if_empty()
            raise
        self._tasks[window_id].density = remembered
        if remembered:
            await self._events.emit("workspace_task_density_changed", window_id=window_id, density=remembered)
        return result

    async def take_task_out(self, window_id: str) -> WorkspaceTask | None:
        """Task'ı workspace defterinden düşürür AMA Android tarafında hiçbir
        şey yapmaz — çağıran (task_teleporter.popout_to_desktop) task'ı ZATEN
        başka bir display'e taşıdığı için burada force-stop edilMEMELİdir."""
        task = self._tasks.pop(window_id, None)
        if task:
            window_logger(__name__, window_id).info(
                "🌸 [ECO WORKSPACE] %s tomurcuklanmak üzere defterden düşürüldü, kalan üye sayısı=%d",
                task.package, len(self._tasks),
            )
        await self._teardown_if_empty()
        return task

    async def set_task_density(self, window_id: str, density: int, mode: str = "manual") -> bool:
        """AOSP WindowContainerTransaction kullanarak Eco Workspace içindeki
        belirli bir görevin (task) densityDpi Configuration override'ını ayarlar.
        Bu işlem tek bir paylaşımlı VirtualDisplay içinde gerçekleşir,
        ekstra encoder/VPU maliyeti oluşturmaz."""
        task = self._tasks.get(window_id)
        if not task:
            window_logger(__name__, window_id).warning("⚠️ [ECO WORKSPACE:DENSITY] görev bulunamadı")
            return False
        if task.parked:
            window_logger(__name__, window_id).info("ℹ️ [ECO WORKSPACE:DENSITY] telefonda park halinde — yoğunluk unpark'ta uygulanacak")
            return False

        if not await self._daemon_set_task_density(task.task_id, density):
            return False
        task.density = density
        if mode in DENSITY_MODES:
            task.density_mode = mode
        await self._events.emit(
            "workspace_task_density_changed",
            window_id=window_id,
            density=density,
            density_mode=task.density_mode,
        )
        w_dp, h_dp, sw_dp, label = layout_class(task.bounds, density)
        window_logger(__name__, window_id).info(
            "🎯 [ECO WORKSPACE:DENSITY] %s (task=%s) -> Yeni DPI: %d => %dx%d dp (sw=%ddp: %s)",
            task.package, task.task_id, density, w_dp, h_dp, sw_dp, label,
        )
        return True

