"""Telefon ekranı gücü.

Saha raporu: telefon ekranı "bir anda kapanıp açılıyor". Kök neden: "kapat" komutunun son çaresi
KEYCODE_POWER (toggle), ekran durumu okunmuyor, arayüz sahte `screen_on=true` gösteriyordu.
"""
from __future__ import annotations

import asyncio
import pathlib
import re

import pytest

from app.device.display_power import DisplayPowerController, PowerReading, parse_power_state

BACKEND = pathlib.Path(__file__).resolve().parents[1]


# ---------------------------------------------------------------- ayrıştırıcı
def _dump(wake: str | None, disp: str | None) -> str:
    lines = ["Power Manager State:", "  mDirty=0x0"]
    if wake:
        lines.append(f"  mWakefulness={wake}")
    lines.append("  mWakefulnessChanging=false")
    if disp:
        lines.append(f"  Display Power: state={disp}")
    return "\n".join(lines)


def test_parse_awake_and_asleep():
    on = parse_power_state(_dump("Awake", "ON"))
    off = parse_power_state(_dump("Asleep", "OFF"))
    assert (on.wakefulness, on.display_state, on.panel_on) == ("awake", "on", True)
    assert (off.wakefulness, off.display_state, off.panel_on) == ("asleep", "off", False)


def test_wakefulness_changing_line_is_not_mistaken_for_wakefulness():
    r = parse_power_state("  mWakefulnessChanging=false\n")
    assert r.wakefulness is None and r.panel_on is None


def test_display_state_wins_over_wakefulness():
    """Yakınlık sensörü/çağrı: cihaz 'Awake' ama panel kapalı."""
    assert parse_power_state(_dump("Awake", "OFF")).panel_on is False


def test_falls_back_to_wakefulness_when_display_state_is_missing():
    assert parse_power_state(_dump("Awake", None)).panel_on is True
    assert parse_power_state(_dump("Asleep", None)).panel_on is False
    assert parse_power_state(_dump("Dozing", None)).panel_on is False
    assert parse_power_state(_dump("Dreaming", None)).panel_on is True


def test_doze_display_counts_as_dark_and_garbage_is_unknown():
    assert parse_power_state(_dump("Awake", "DOZE")).panel_on is False
    assert parse_power_state("").panel_on is None
    assert parse_power_state("no such service").panel_on is None
    assert PowerReading().panel_on is None


# ---------------------------------------------------------------- sahte telefon
class FakePhone:
    """PowerManager taklidi: WAKEUP/SLEEP mutlaktır; KEYCODE_POWER (26) TOGGLE'dır."""

    def __init__(self, lit: bool = True, obeys_sleep: bool = True) -> None:
        self.lit = lit
        self.obeys_sleep = obeys_sleep
        self.dump_fails = False
        self.calls: list[str] = []

    async def shell(self, cmd, serial=None, timeout_s=0):
        self.calls.append(cmd)
        if cmd == "dumpsys power":
            if self.dump_fails:
                raise RuntimeError("adb down")
            return _dump("Awake" if self.lit else "Asleep", "ON" if self.lit else "OFF")
        if cmd == "input keyevent 223":
            if self.obeys_sleep:
                self.lit = False
        elif cmd == "input keyevent 224":
            self.lit = True
        elif cmd == "input keyevent 26":
            self.lit = not self.lit
        return ""

    def keys(self) -> list[str]:
        return [c.rsplit(" ", 1)[1] for c in self.calls if c.startswith("input keyevent")]


class FakeDaemon:
    """raw=True: ham güç kipi (PowerManager'a görünmez). raw=False: eski jar — son çare tuşu."""

    is_connected = True

    def __init__(self, phone: FakePhone, raw: bool = True) -> None:
        self.phone = phone
        self.raw = raw
        self.calls: list[bool] = []

    async def set_display_power(self, on: bool) -> bool:
        self.calls.append(on)
        if not self.raw:
            self.phone.lit = on          # eski jar: 224/26 tuşuyla aynı etki
        return True


class FakeEvents:
    def __init__(self) -> None:
        self.emitted: list[tuple[str, dict]] = []

    async def emit(self, type_, **payload):
        self.emitted.append((type_, payload))


def make(phone: FakePhone, daemon: FakeDaemon | None = None, serial: str | None = "S", events=None):
    t = [0.0]

    async def fake_sleep(s: float) -> None:
        t[0] += s

    ctl = DisplayPowerController(
        phone,
        lambda: serial,
        lambda: daemon,
        events,
        clock=lambda: t[0],
        sleep=fake_sleep,
    )
    return ctl, t


# ---------------------------------------------------------------- idempotans (asıl hata)
@pytest.mark.asyncio
async def test_off_when_already_dark_sends_no_command_at_all():
    """REGRESYON (asıl hata): ekran zaten kapalıyken 'kapat' AÇMAMALI — hiçbir tuş gönderilmez."""
    phone = FakePhone(lit=False)
    ctl, _ = make(phone)
    res = await ctl.set(False)
    assert res["ok"] is True and res["on"] is False and res["changed"] is False
    assert phone.keys() == []
    assert phone.lit is False


@pytest.mark.asyncio
async def test_off_from_lit_uses_the_absolute_sleep_key_once():
    phone = FakePhone(lit=True)
    ctl, _ = make(phone)
    res = await ctl.set(False)
    assert phone.keys() == ["223"]
    assert res["ok"] and res["on"] is False and res["changed"] and res["verified"]


@pytest.mark.asyncio
async def test_on_from_dark_uses_wakeup_only():
    phone = FakePhone(lit=False)
    ctl, _ = make(phone)
    res = await ctl.set(True)
    assert phone.keys() == ["224"]
    assert res["ok"] and res["on"] is True and phone.lit is True


@pytest.mark.asyncio
async def test_on_when_already_lit_sends_nothing():
    phone = FakePhone(lit=True)
    ctl, _ = make(phone)
    res = await ctl.set(True)
    assert res["changed"] is False and phone.keys() == []


@pytest.mark.asyncio
async def test_repeated_off_never_flips_the_screen_back_on():
    phone = FakePhone(lit=True)
    ctl, _ = make(phone)
    for _ in range(5):
        await ctl.set(False)
    assert phone.lit is False
    assert phone.keys() == ["223"]          # ilk komuttan sonrası "zaten kapalı"


@pytest.mark.asyncio
async def test_concurrent_off_requests_send_a_single_command():
    """Çift tıklama / iki sekme: kilit + taze okuma ile TEK komut."""
    phone = FakePhone(lit=True)
    ctl, _ = make(phone)
    results = await asyncio.gather(*[ctl.set(False, source=f"tab{i}") for i in range(4)])
    assert phone.keys() == ["223"]
    assert all(r["on"] is False for r in results)
    assert sum(1 for r in results if r["changed"]) == 1


@pytest.mark.asyncio
async def test_opposite_request_is_not_swallowed():
    phone = FakePhone(lit=True)
    ctl, _ = make(phone)
    await ctl.set(False)
    res = await ctl.set(True)
    assert res["on"] is True and phone.keys() == ["223", "224"]


@pytest.mark.asyncio
async def test_same_target_inside_settle_window_is_swallowed_even_if_first_failed():
    """Telefon uyku isteğini reddetti; hemen ardından gelen aynı istek 2. komut olarak gitmez."""
    phone = FakePhone(lit=True, obeys_sleep=False)
    ctl, _ = make(phone)
    first = await ctl.set(False)
    assert first["ok"] is False and first["error"] == "screen_did_not_sleep" and first["on"] is True
    second = await ctl.set(False)
    assert second["reason"] == "settling"
    assert phone.keys() == ["223"]


# ---------------------------------------------------------------- daemon (ham güç kipi)
@pytest.mark.asyncio
async def test_daemon_raw_off_is_remembered_and_reported_as_off():
    phone = FakePhone(lit=True)          # PowerManager hâlâ "awake"
    daemon = FakeDaemon(phone, raw=True)
    ctl, _ = make(phone, daemon)
    res = await ctl.set(False)
    assert daemon.calls == [False] and phone.keys() == []
    assert res["ok"] and res["on"] is False and res["verified"] is False
    st = await ctl.state(fresh=True)
    assert st["on"] is False and st["raw_blanked"] is True


@pytest.mark.asyncio
async def test_raw_blanked_panel_is_relit_through_the_daemon():
    phone = FakePhone(lit=True)
    daemon = FakeDaemon(phone, raw=True)
    ctl, _ = make(phone, daemon)
    await ctl.set(False)
    res = await ctl.set(True)
    assert daemon.calls == [False, True] and res["on"] is True
    assert (await ctl.state(fresh=True))["raw_blanked"] is False


@pytest.mark.asyncio
async def test_raw_blank_without_daemon_is_relit_with_a_sleep_wake_cycle():
    phone = FakePhone(lit=True)
    daemon = FakeDaemon(phone, raw=True)
    ctl, _ = make(phone, daemon)
    await ctl.set(False)                    # ham karartma
    daemon.is_connected = False             # daemon koptu
    res = await ctl.set(True)
    assert phone.keys() == ["223", "224"] and res["on"] is True


@pytest.mark.asyncio
async def test_pm_sleep_clears_the_raw_blank_memory():
    phone = FakePhone(lit=True)
    ctl, _ = make(phone, FakeDaemon(phone, raw=True))
    await ctl.set(False)
    phone.lit = False                       # kullanıcı fiziksel tuşla uyuttu
    st = await ctl.state(fresh=True)
    assert st["on"] is False and st["raw_blanked"] is False
    phone.lit = True                        # tekrar uyandırdı → panel yandı
    assert (await ctl.state(fresh=True))["on"] is True


@pytest.mark.asyncio
async def test_unknown_state_never_uses_the_daemon_off_path():
    """Durum bilinmiyorsa daemon'un (eski jar'da toggle olabilen) KAPAT yolu kullanılmaz."""
    phone = FakePhone(lit=False)
    phone.dump_fails = True
    daemon = FakeDaemon(phone, raw=False)
    ctl, _ = make(phone, daemon)
    res = await ctl.set(False)
    assert daemon.calls == []
    assert phone.keys() == ["223"]          # belirleyici SLEEP
    assert phone.lit is False
    assert res["ok"] is True


@pytest.mark.asyncio
async def test_old_jar_toggle_fallback_is_safe_because_state_is_verified_first():
    """Eski jar'ın son çaresi toggle: ekran zaten kapalıysa daemon HİÇ çağrılmaz."""
    phone = FakePhone(lit=False)
    daemon = FakeDaemon(phone, raw=False)
    ctl, _ = make(phone, daemon)
    await ctl.set(False)
    assert daemon.calls == [] and phone.lit is False


# ---------------------------------------------------------------- dürüst durum
@pytest.mark.asyncio
async def test_state_is_unknown_not_fabricated_when_it_cannot_be_read():
    phone = FakePhone()
    phone.dump_fails = True
    ctl, _ = make(phone)
    st = await ctl.state(fresh=True)
    assert st["on"] is None and st["known"] is False


@pytest.mark.asyncio
async def test_no_device_reports_failure_and_unknown():
    ctl, _ = make(FakePhone(), serial=None)
    assert (await ctl.state())["on"] is None
    res = await ctl.set(False)
    assert res["ok"] is False and res["error"] == "no_device"


@pytest.mark.asyncio
async def test_state_reads_are_cached_briefly_to_spare_the_phone():
    phone = FakePhone()
    ctl, t = make(phone)
    await ctl.state()
    await ctl.state()
    assert phone.calls.count("dumpsys power") == 1
    t[0] += 3.0
    await ctl.state()
    assert phone.calls.count("dumpsys power") == 2


@pytest.mark.asyncio
async def test_state_reports_pending_target_while_a_command_is_in_flight():
    phone = FakePhone(lit=True)
    gate = asyncio.Event()

    async def slow_sleep(_s: float) -> None:
        await gate.wait()

    ctl = DisplayPowerController(phone, lambda: "S", lambda: None, None, sleep=slow_sleep, clock=lambda: 0.0)
    task = asyncio.create_task(ctl.set(False))
    for _ in range(20):
        await asyncio.sleep(0)
        if phone.keys():
            break
    st = await ctl.state()
    assert st["pending"] is True and st["on"] is False
    gate.set()
    await task
    assert (await ctl.state(fresh=True))["pending"] is False


@pytest.mark.asyncio
async def test_change_is_published_so_every_client_updates():
    phone = FakePhone(lit=True)
    events = FakeEvents()
    ctl, _ = make(phone, events=events)
    await ctl.set(False)
    assert events.emitted == [("device_states_update", {"states": {"screen_on": False}})]


@pytest.mark.asyncio
async def test_noop_publishes_nothing():
    phone = FakePhone(lit=False)
    events = FakeEvents()
    ctl, _ = make(phone, events=events)
    await ctl.set(False)
    assert events.emitted == []


@pytest.mark.asyncio
async def test_switching_device_forgets_previous_devices_raw_blank():
    phone = FakePhone(lit=True)
    serial = {"v": "A"}
    ctl = DisplayPowerController(
        phone, lambda: serial["v"], lambda: FakeDaemon(phone, raw=True), None,
        clock=lambda: 0.0, sleep=lambda s: asyncio.sleep(0),
    )
    await ctl.set(False)
    assert (await ctl.state(fresh=True))["raw_blanked"] is True
    serial["v"] = "B"
    assert (await ctl.state(fresh=True))["raw_blanked"] is False


# ---------------------------------------------------------------- kaynak taraması
def test_no_toggle_power_key_anywhere_in_backend_or_daemon_sources():
    """KEYCODE_POWER (26) toggle'dır: hiçbir kaynakta komut olarak bulunmamalı."""
    toggle = re.compile(r"keyevent\s+(26\b|KEYCODE_POWER\b)")
    offenders = []
    files = list((BACKEND / "app").rglob("*.py")) + list((BACKEND / "java" / "src").rglob("*.java"))
    assert files, "kaynak taraması boş çalıştı"
    for p in files:
        for n, line in enumerate(p.read_text(encoding="utf-8", errors="ignore").splitlines(), 1):
            if toggle.search(line):
                offenders.append(f"{p.relative_to(BACKEND)}:{n}: {line.strip()}")
    assert not offenders, "toggle güç tuşu bulundu:\n" + "\n".join(offenders)


# ---------------------------------------------------------------- daemon fail-safe resync
@pytest.mark.asyncio
async def test_resync_adopts_the_daemons_truth_when_it_relit_the_panel_itself():
    """The daemon lit a panel we raw-blanked (no client for 30 s). PowerManager said "awake" all along, so only the
    greeting's `screen_blanked=False` can tell us — and the UI must then show the screen as ON."""
    phone = FakePhone(lit=True)
    events = FakeEvents()
    ctl, _ = make(phone, FakeDaemon(phone, raw=True), events=events)
    await ctl.set(False)
    assert (await ctl.state(fresh=True))["raw_blanked"] is True

    await ctl.resync(screen_blanked=False)

    st = await ctl.state(fresh=True)
    assert st["on"] is True and st["raw_blanked"] is False
    assert events.emitted[-1] == ("device_states_update", {"states": {"screen_on": True}})


@pytest.mark.asyncio
async def test_resync_keeps_a_panel_that_is_still_blanked_dark():
    """A quick reconnect (transport switch): the daemon did NOT relight it. A fresh reading says "awake" — trusting
    it would show a dark panel as ON (the plan's first draft did exactly that)."""
    phone = FakePhone(lit=True)
    ctl, _ = make(phone, FakeDaemon(phone, raw=True), events=FakeEvents())
    await ctl.set(False)
    await ctl.resync(screen_blanked=True)
    assert (await ctl.state(fresh=True))["on"] is False


@pytest.mark.asyncio
async def test_resync_with_an_old_jar_keeps_our_memory():
    phone = FakePhone(lit=True)
    ctl, _ = make(phone, FakeDaemon(phone, raw=True), events=FakeEvents())
    await ctl.set(False)
    await ctl.resync()                     # greeting without `screen_blanked`
    assert (await ctl.state(fresh=True))["raw_blanked"] is True


@pytest.mark.asyncio
async def test_resync_without_a_device_does_nothing():
    phone = FakePhone(lit=True)
    events = FakeEvents()
    ctl, _ = make(phone, serial=None, events=events)
    await ctl.resync(screen_blanked=False)
    assert phone.calls == [] and events.emitted == []
