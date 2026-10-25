"""Oynatma sürekliliği: bir uygulamayı ekranlar arası taşırken (Telefona aktar / Geri al) oynayan medya AYNI SAYFADA, AYNI NOKTADAN devam eder.

Saha bulgusu (2026-10-15, POCO 2412DPC0AG, HyperOS 3 / Android 16, YouTube 21.41): görevi VD ⇄ Display 0 taşıyınca Android etkinliği
yeniden kurar (`wm_relaunch_resume_activity`; YouTube ekran değişiminde `colorMode`/`touchscreen` değişimini kendisi karşılamıyor,
`configChanges`'inde yok). Süreç ÖLMEZ, medya oturumu yalnızca durur (`state=STOPPED`, `position` yerinde), ama izleme sayfası ana
akışa + mini oynatıcıya düşer. Kullanıcı bunu "state kaybı" olarak görür.

  * `capture(package)`: taşımadan ÖNCE paketin medya oturumu OYNUYORSA anlık görüntüsünü alır (yoksa None: dokunulmaz). Uygulama
    kendi `AssistContent`'inde (daemon `assist_content`: sistem asistanının sorduğu şey; UI'a dokunulmaz) oynatıcısının TAM SAYFA
    olduğunu bildiriyorsa o sayfanın web adresi de alınır.
  * `restore(snapshot, display_id)`: taşıma bitince oturum durmuşsa sayfa adresi derin bağlantıyla (`am start -a VIEW -d <adres>`)
    açılır — bildirime dokunulmuş gibi; adres yoksa yalnızca `play` + durma anındaki konuma `seek`. Hâlâ oynuyorsa (uygulama kendini
    taşımış) hiçbir şey yapılmaz. Kullanıcının kendi durdurduğu ASLA başlatılmaz: yalnız taşımadan önce OYNAYAN ve sonra DURMUŞ olan
    oturum devam ettirilir.

Karar uygulamanın bildirdiği veriye bağlıdır, paket adına değil: `@isPlayerVisible=true` ve `@isPlayerMinimized=false` diyen
uygulamanın adresi kullanılır (YouTube böyle söyler). Mini oynatıcıdaki uygulama ya da oynatıcısını anlatmayan uygulama için sayfa
açılmaz (kullanıcı başka sayfadaydı); onlara yalnızca oynat + sar uygulanır. Adresteki süre YouTube'da `t=` ile verilir, diğerlerinde
sayfa açıldıktan sonra sarma tamamlar.

Hiçbir hata taşımayı bozmaz: bu bir iyileştirmedir, her adım en iyi çabayla çalışır.
"""
from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import re
import time
from dataclasses import dataclass
from typing import Any, Callable
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

log = logging.getLogger(__name__)

_PLAYING_STATES = {"PLAYING", "BUFFERING"}
_STOPPED_STATES = {"STOPPED", "PAUSED", "NONE"}
_PACKAGE_RE = re.compile(r"[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z0-9_]+)+")
# An http(s) address with nothing the shell could read as syntax once it sits in single quotes (no quote, backtick, space, backslash).
_URL_RE = re.compile(r"https?://[A-Za-z0-9._~:/?#@!$&()*+,;=%-]+")
_NO_PAGE_RETRY_S = 600.0   # an app that did not describe its player is not asked again for this long (an unanswered request costs seconds)


@dataclass(frozen=True)
class PlaybackSnapshot:
    package: str
    position_ms: int      # taşımadan önceki konum (yedek: durma konumu okunamazsa)
    taken_at: float       # time.monotonic()
    url: str | None = None   # tam sayfa oynatıcının web adresi (uygulama bildirdiyse): taşımadan sonra derin bağlantıyla açılır
    paused: bool = False     # sayfa DURAKLATILMIŞ halde taşındı (yalnız `capture_page`): sayfa geri açılınca oynatılmaz, duraklatılı kalır
    title: str | None = None   # çalan parçanın adı: taşıma sırasında parça kendiliğinden değişmişse eski konuma SARILMAZ (başka parçanın saniyesi)


_VOLATILE_QUERY = {"t", "start", "time_continue", "si", "feature", "pp"}   # the same page whatever second / share tag it carries


def same_page(a: str | None, b: str | None) -> bool:
    """Two web addresses of one page: same host and path and the same query apart from the start second / share tags."""
    if not a or not b:
        return False

    def key(url: str) -> tuple[str, str, tuple[tuple[str, str], ...]]:
        parts = urlsplit(url)
        query = tuple(sorted(kv for kv in parse_qsl(parts.query) if kv[0] not in _VOLATILE_QUERY))
        return (parts.hostname or "").removeprefix("www.").removeprefix("m."), parts.path.rstrip("/"), query

    return key(a) == key(b)


def _session_of(snapshot: dict[str, Any] | None, package: str) -> dict[str, Any] | None:
    """`media_get` sonucundaki bu pakete ait oturum (yoksa None)."""
    if not isinstance(snapshot, dict) or snapshot.get("error"):
        return None
    sessions = snapshot.get("sessions")
    if not isinstance(sessions, list):
        sessions = [snapshot] if snapshot.get("active") else []
    wanted = package.lower()
    for s in sessions:
        if isinstance(s, dict) and str(s.get("package", "")).lower() == wanted:
            return s
    return None


def _state(session: dict[str, Any] | None) -> str:
    return str(session.get("state", "")).upper() if session else ""


def _is_playing(session: dict[str, Any] | None) -> bool:
    return bool(session) and (session.get("is_playing") is True or _state(session) in _PLAYING_STATES)


def _title(session: dict[str, Any] | None) -> str | None:
    title = session.get("title") if session else None
    return title.strip() if isinstance(title, str) and title.strip() else None


def _structured(reply: dict[str, Any] | None) -> dict[str, Any]:
    """The app's schema.org-style structured data of an `assist_content` reply ({} when absent or not an object)."""
    with contextlib.suppress(ValueError, TypeError):
        parsed = json.loads(reply.get("structured"))
        if isinstance(parsed, dict):
            return parsed
    return {}


def page_url_from_assist(reply: dict[str, Any] | None) -> str | None:
    """The web address of the page the app is on — only when the app says its player IS that page (visible, not a mini player):
    reopening it for an app that was elsewhere would take the user off the page they were really on."""
    if not isinstance(reply, dict) or not reply.get("ok"):
        return None
    player = _structured(reply)
    if player.get("@isPlayerVisible") is not True or player.get("@isPlayerMinimized") is not False:
        return None
    url = reply.get("web_uri")
    return url if isinstance(url, str) and _URL_RE.fullmatch(url) else None


def _at_second(url: str, position_ms: int) -> str:
    """YouTube addresses take the start second as `t=<s>s`; any other address is returned as it is (the seek after the link does it)."""
    parts = urlsplit(url)
    host = parts.hostname or ""
    if not position_ms or not (host == "youtu.be" or host.endswith("youtube.com")):
        return url
    query = [kv for kv in parse_qsl(parts.query) if kv[0] != "t"] + [("t", f"{position_ms // 1000}s")]
    return urlunsplit(parts._replace(query=urlencode(query)))


class PlaybackContinuity:
    def __init__(
        self,
        daemon_getter: Callable[[], Any],
        *,
        enabled: bool = True,
        settle_s: float = 2.0,
        wait_s: float = 8.0,
        poll_s: float = 0.25,
        seek_tolerance_ms: int = 1000,
        deep_link: bool = True,
        safe_wait_s: float = 4.0,
        safe_after_ms: int = 4000,
        safe_before_end_ms: int = 3000,
        lost_after_s: float = 1.5,
    ) -> None:
        self._daemon_getter = daemon_getter
        self._enabled = enabled
        self._deep_link = deep_link        # reopen the page the app reported (see the module docstring)
        self._settle_s = settle_s          # taşımadan sonra bu kadar süre hâlâ oynuyorsa: uygulama kendini taşımış
        self._wait_s = wait_s              # durmuş oturumu devam ettirmek için toplam üst sınır
        self._poll_s = poll_s
        self._tolerance = seek_tolerance_ms
        self._skip_until: dict[str, float] = {}   # package → monotonic time before which it is not asked for its page
        self._safe_wait_s = safe_wait_s            # `wait_stable`: the longest the audio route is held for a steady playback point
        self._safe_after_ms = safe_after_ms        # … a track must have played this long
        self._safe_before_end_ms = safe_before_end_ms   # … and must not end within this
        self._lost_after_s = lost_after_s          # a session missing this long after a move is LOST (see `_recover_lost`)

    async def _media(self) -> dict[str, Any] | None:
        daemon = self._daemon_getter()
        if daemon is None or not getattr(daemon, "is_connected", False):
            return None
        with contextlib.suppress(Exception):
            return await daemon.refresh_media()
        return getattr(daemon, "last_media_state", None)

    async def capture(self, package: str | None) -> PlaybackSnapshot | None:
        """Paket şu an OYNUYORSA anlık görüntüsü; aksi halde (duruyor / bilinmiyor / oturum yok) None."""
        if not self._enabled or not package:
            return None
        session = _session_of(await self._media(), package)
        if not _is_playing(session):
            return None
        position = int(session.get("position") or 0)
        url = await self._page_url(package)
        log.info("▶ [PlaybackContinuity] %s oynuyor (konum %.1f sn)%s — taşıma sonrası kaldığı yerden devam ettirilecek",
                 package, position / 1000, f", sayfa {url}" if url else "")
        return PlaybackSnapshot(package=package, position_ms=position, taken_at=time.monotonic(), url=url, title=_title(session))

    async def wait_stable(self, package: str | None) -> str:
        """The moment to take the app's AUDIO ROUTE apart (the phone's capture of it ends, its AudioTrack dies and the app must
        build a new one — a player that is in the middle of a track change can stop for good instead, field report 2026-10-24:
        the song had started 3 s earlier and the session went STOPPED, then vanished). 'idle': nothing plays (nothing to protect),
        'stable': playing for at least `safe_after_ms` and not about to end, 'timeout': still not stable after `safe_wait_s` — the
        caller goes on anyway (a few seconds of delay is the price, never a reason to keep the capture for ever)."""
        if not self._enabled or not package:
            return "idle"
        deadline = time.monotonic() + self._safe_wait_s
        while True:
            session = _session_of(await self._media(), package)
            if not _is_playing(session):
                return "idle"
            position = int(session.get("position") or 0)
            duration = session.get("duration")
            duration = int(duration) if isinstance(duration, (int, float)) and not isinstance(duration, bool) and duration > 0 else None
            if position >= self._safe_after_ms and (duration is None or duration - position >= self._safe_before_end_ms):
                return "stable"
            if time.monotonic() >= deadline:
                log.info("▶ [PlaybackContinuity] %s: parça geçişi sürüyor (konum %.1f sn) — ses rotası yine de değiştirilecek",
                         package, position / 1000)
                return "timeout"
            await asyncio.sleep(self._poll_s)

    async def capture_page(self, package: str | None) -> PlaybackSnapshot | None:
        """The page an app is on BEFORE it crosses displays, whether its video plays or is paused (`capture` takes only a
        playing one): for an app that was left on the phone and is now opened in a window — the move rebuilds it, and a paused
        watch page is exactly what that rebuild used to lose. None when the app does not say its player is the page (nothing
        to reopen, nothing is touched)."""
        if not self._enabled or not package:
            return None
        url = await self._page_url(package)
        if url is None:
            return None
        session = _session_of(await self._media(), package)
        playing = _is_playing(session)
        position = int(session.get("position") or 0) if session else 0
        log.info("▶ [PlaybackContinuity] %s %s (konum %.1f sn), sayfa %s — taşıma sonrası sayfada mı diye bakılacak",
                 package, "oynuyor" if playing else "duraklatılmış", position / 1000, url)
        return PlaybackSnapshot(package=package, position_ms=position, taken_at=time.monotonic(), url=url, paused=not playing)

    async def repair_page(self, snapshot: PlaybackSnapshot | None, display_id: int | str | None = None) -> str:
        """After the move (and the app's rebuild): if the app is no longer on the page `capture_page` saw — it fell to its home
        feed or lost it with its process — that page is reopened at the saved second (paused when it was paused). 'skipped' |
        'kept' (still on the page: nothing done) | 'reopened' | 'gave_up'. Never raises."""
        if snapshot is None or snapshot.url is None or not self._enabled:
            return "skipped"
        daemon = self._daemon_getter()
        if daemon is None or not getattr(daemon, "is_connected", False):
            return "skipped"
        package = snapshot.package
        try:
            await asyncio.sleep(self._settle_s)   # the rebuild after a move is still under way for a moment
            current = await self._page_url(package, remember=False)
            session = _session_of(await self._media(), package)
            # The app may simply not answer yet (None) while its player is alive at the second it was left: that is the page.
            alive = session is not None and _state(session) in ("PLAYING", "BUFFERING", "PAUSED") and (
                _is_playing(session) or abs(int(session.get("position") or 0) - snapshot.position_ms) <= 3 * self._tolerance)
            if same_page(current, snapshot.url) or (current is None and alive):
                log.info("▶ [PlaybackContinuity] %s taşımadan sonra aynı sayfada — dokunulmadı", package)
                return "kept"
            if snapshot.paused:
                opened = await self._open_page(daemon, snapshot, snapshot.position_ms, display_id)
                if not opened:
                    return "gave_up"
                return "reopened" if await self._hold_paused(daemon, package, snapshot.position_ms) else "gave_up"
            return "reopened" if await self._reopen_page(daemon, snapshot, snapshot.position_ms, display_id) else "gave_up"
        except Exception as exc:  # noqa: BLE001 — a nicety, never an error
            log.info("▶ [PlaybackContinuity] %s sayfa onarımı yapılamadı: %s", package, exc)
            return "gave_up"

    async def _hold_paused(self, daemon: Any, package: str, target_ms: int) -> bool:
        """A page opened by a link loads STOPPED → BUFFERING → PAUSED (it may also start by itself): wait for it, pause it if it
        plays, and bring it to `target_ms` if it is further off than the tolerance. True: it is paused at the second."""
        deadline = time.monotonic() + self._wait_s
        while time.monotonic() < deadline:
            session = _session_of(await self._media(), package)
            state = _state(session)
            if state == "PLAYING":
                await daemon.send_media_action("pause", package)
            elif state == "PAUSED":
                if abs(int(session.get("position") or 0) - target_ms) > self._tolerance:
                    await daemon.send_media_seek(target_ms, package)
                log.info("▶ [PlaybackContinuity] %s sayfası duraklatılmış halde geri açıldı (%.1f sn)", package, target_ms / 1000)
                return True
            await asyncio.sleep(self._poll_s)
        log.info("▶ [PlaybackContinuity] %s sayfası açıldı ama duraklatılamadı", package)
        return False

    async def _page_url(self, package: str, *, remember: bool = True) -> str | None:
        daemon = self._daemon_getter()
        supports = getattr(daemon, "supports", None)
        if not self._deep_link or not supports or not supports("assist_content") or time.monotonic() < self._skip_until.get(package, 0):
            return None
        try:
            task_id = ((await daemon.find_task(package)) or {}).get("task_id")
            reply = await daemon.assist_content(task_id) if task_id else None
        except Exception as exc:  # noqa: BLE001 — a nicety, never an error
            log.info("▶ [PlaybackContinuity] %s sayfası okunamadı: %s", package, exc)
            return None
        url = page_url_from_assist(reply)
        if remember and url is None and "@isPlayerMinimized" not in _structured(reply):
            self._skip_until[package] = time.monotonic() + _NO_PAGE_RETRY_S   # it did not describe its player at all
        return url

    async def restore(self, snapshot: PlaybackSnapshot | None, display_id: int | str | None = None) -> str:
        """Taşıma BİTTİKTEN sonra çağrılır. Sonuç (günlük/test için): 'skipped' | 'kept_playing' | 'reopened' | 'resumed' |
        'resumed_no_seek' | 'gave_up'."""
        if snapshot is None or not self._enabled:
            return "skipped"
        daemon = self._daemon_getter()
        if daemon is None:
            return "skipped"
        package = snapshot.package
        started = time.monotonic()
        missing_since: float | None = None
        while time.monotonic() - started < self._wait_s:
            session = _session_of(await self._media(), package)
            if session is None:
                # A session that is GONE (not merely stopped): when the app's player is torn down the session turns inactive and
                # Android's active list drops it. Waiting is right for a moment (a rebuild brings it back), not for ever.
                now = time.monotonic()
                missing_since = missing_since if missing_since is not None else now
                if now - missing_since >= self._lost_after_s:
                    return await self._recover_lost(daemon, snapshot, lost_at=missing_since)
                await asyncio.sleep(self._poll_s)
                continue
            missing_since = None
            if _is_playing(session):
                # Hâlâ (ya da yine) oynuyor. Etkinlik yeniden kurulumu taşımadan KISA SÜRE sonra durdurur: `settle_s` boyunca
                # kesintisiz oynuyorsa uygulama kendini taşımış demektir.
                if time.monotonic() - started >= self._settle_s:
                    log.info("▶ [PlaybackContinuity] %s taşımayı kesintisiz geçirdi — dokunulmadı", package)
                    return "kept_playing"
            elif _state(session) in _STOPPED_STATES:
                stopped = int(session.get("position") or snapshot.position_ms or 0)
                if self._other_track(snapshot, session):
                    # The track changed while the app was moving (it ended, the next one began): the saved second belongs to the OLD
                    # track — no page to reopen at it, no seek; the new track is simply started.
                    return await self._play_at(daemon, package, None, play_now=True, wait=4.0)
                if await self._reopen_page(daemon, snapshot, stopped, display_id):
                    return "reopened"
                return await self._play_at(daemon, package, stopped, play_now=True, wait=4.0)
            await asyncio.sleep(self._poll_s)
        log.info("▶ [PlaybackContinuity] %s: oturum toparlanmadı (süre doldu) — devam ettirilemedi", package)
        return "gave_up"

    @staticmethod
    def _other_track(snapshot: PlaybackSnapshot, session: dict[str, Any] | None) -> bool:
        """True when both names are known and differ: the saved second is of another track."""
        now = _title(session)
        return snapshot.title is not None and now is not None and now != snapshot.title

    async def _media_button_owner(self, daemon: Any) -> str | None:
        """The package Android routes media buttons to RIGHT NOW (`dumpsys media_session`: "Media button session is <pkg>/…"). It
        outlives the session turning inactive — which is what makes a button press reach a player whose session is gone."""
        run = getattr(daemon, "run_shell", None)
        if run is None:
            return None
        try:
            outcome = await run("dumpsys media_session | grep -m1 'Media button session is'", timeout_s=4.0)
        except Exception as exc:  # noqa: BLE001 — best effort
            log.info("▶ [PlaybackContinuity] medya düğmesi sahibi okunamadı: %s", exc)
            return None
        text = outcome.stdout.decode("utf-8", "replace") if outcome is not None and outcome.stdout else ""
        found = re.search(r"Media button session is ([A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)+)/", text)
        return found.group(1) if found else None

    async def _recover_lost(self, daemon: Any, snapshot: PlaybackSnapshot, *, lost_at: float) -> str:
        """The app's media session is gone after the move although it was playing (field report 2026-10-24: the audio route was taken
        apart while the player was changing tracks, it stopped and its session vanished). `media_action play <pkg>` cannot reach a
        session that does not exist, so the PLAY media key is pressed — but only when Android still routes media buttons to THIS
        package (never press play on whatever else happens to hold them). The same track goes on where it was lost; a different one
        is left to play from its start. 'resumed' | 'gave_up'."""
        package = snapshot.package
        owner = await self._media_button_owner(daemon)
        if owner != package:
            log.info("▶ [PlaybackContinuity] %s: oturum kayboldu, medya düğmesi %s'de — dokunulmadı", package, owner or "bilinmiyor")
            return "gave_up"
        run = getattr(daemon, "run_shell", None)
        try:
            pressed = await run("input keyevent 126", timeout_s=4.0)        # KEYCODE_MEDIA_PLAY: absolute, never a toggle
        except Exception as exc:  # noqa: BLE001
            log.info("▶ [PlaybackContinuity] %s: oynat tuşu gönderilemedi: %s", package, exc)
            return "gave_up"
        if pressed is None or pressed.exit_code != 0:
            return "gave_up"
        deadline = time.monotonic() + 4.0
        while time.monotonic() < deadline:
            session = _session_of(await self._media(), package)
            if _is_playing(session):
                break
            await asyncio.sleep(self._poll_s)
        else:
            log.info("▶ [PlaybackContinuity] %s: oynat tuşu da oturumu geri getirmedi", package)
            return "gave_up"
        if snapshot.title is not None and not self._other_track(snapshot, session) and _title(session) == snapshot.title:
            where = snapshot.position_ms + max(0, int((lost_at - snapshot.taken_at) * 1000))
            if abs(int(session.get("position") or 0) - where) > self._tolerance:
                await daemon.send_media_seek(where, package)
        log.info("▶ [PlaybackContinuity] %s: kaybolan oturum medya tuşuyla geri getirildi", package)
        return "resumed"

    async def _reopen_page(self, daemon: Any, snapshot: PlaybackSnapshot, stopped_ms: int, display_id: int | str | None) -> bool:
        """Opens the page the app was on, on `display_id`, and has it playing at `stopped_ms`. False — nothing is lost — when that
        cannot be done: the plain resume then runs."""
        package = snapshot.package
        if not await self._open_page(daemon, snapshot, stopped_ms, display_id):
            return False
        if await self._play_at(daemon, package, stopped_ms, play_now=False, wait=self._wait_s) == "gave_up":
            log.info("▶ [PlaybackContinuity] %s sayfa açıldı ama oynamadı — oynat + sar'a düşülüyor", package)
            return False
        log.info("▶ [PlaybackContinuity] %s sayfası açıldı (%s, display %s)", package, snapshot.url, display_id)
        return True

    async def _open_page(self, daemon: Any, snapshot: PlaybackSnapshot, at_ms: int, display_id: int | str | None) -> bool:
        """Runs the deep link to the snapshot's page (at the second `at_ms`) on `display_id`. False when it cannot be run or the
        app refuses it."""
        package = snapshot.package
        if snapshot.url is None or not str(display_id).strip().isdigit() or not _PACKAGE_RE.fullmatch(package):
            return False
        url = _at_second(snapshot.url, at_ms)
        try:   # `url` passed _URL_RE, the display is an integer, the package matched _PACKAGE_RE: nothing here is free text
            outcome = await daemon.run_shell(
                f"am start --display {int(display_id)} -a android.intent.action.VIEW -d '{url}' -p {package}", timeout_s=8.0)
        except Exception as exc:  # noqa: BLE001
            log.info("▶ [PlaybackContinuity] %s derin bağlantı çalıştırılamadı: %s", package, exc)
            return False
        text = (outcome.stdout + outcome.stderr).decode("utf-8", "replace") if outcome is not None else ""
        if outcome is None or outcome.exit_code != 0 or "Error" in text or "Exception" in text:
            log.info("▶ [PlaybackContinuity] %s derin bağlantı reddedildi: %s", package, text.strip()[:160])
            return False
        return True

    async def _play_at(self, daemon: Any, package: str, target_ms: int | None, *, play_now: bool, wait: float) -> str:
        """Gets the session PLAYING and at `target_ms` (None: wherever it starts — no seek): `play` (at once, or when it shows
        PAUSED — a page opened by a link loads STOPPED → BUFFERING → PAUSED and stays there; BUFFERING is not playing), then a seek
        if it is further off than the tolerance. 'resumed' | 'resumed_no_seek' | 'gave_up'."""
        if play_now and not await daemon.send_media_action("play", package):
            log.info("▶ [PlaybackContinuity] %s: play reddedildi", package)
            return "gave_up"
        nudged = play_now
        deadline = time.monotonic() + wait
        while True:
            session = _session_of(await self._media(), package)
            if _state(session) == "PLAYING":
                break
            if _state(session) == "PAUSED" and not nudged:
                nudged = await daemon.send_media_action("play", package)
            if time.monotonic() >= deadline:
                return "gave_up"
            await asyncio.sleep(self._poll_s)
        current = int(session.get("position") or 0)
        if target_ms is None:
            log.info("▶ [PlaybackContinuity] %s devam etti (parça değişmişti, başından: %.1f sn)", package, current / 1000)
            return "resumed"
        if abs(current - target_ms) <= self._tolerance:
            log.info("▶ [PlaybackContinuity] %s devam etti (konum %.1f sn)", package, current / 1000)
            return "resumed"
        if await daemon.send_media_seek(target_ms, package):
            log.info("▶ [PlaybackContinuity] %s devam etti: %.1f → %.1f sn'ye sarıldı", package, current / 1000, target_ms / 1000)
            return "resumed"
        log.info("▶ [PlaybackContinuity] %s devam etti ama konuma sarılamadı (%.1f sn yerine %.1f sn)", package,
                 target_ms / 1000, current / 1000)
        return "resumed_no_seek"
