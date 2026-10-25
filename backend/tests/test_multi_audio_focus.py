"""Telefonun "çoklu uygulama sesi": okuma, onaylı uygulama + GERİ OKUMA, çıkışta geri alma, çökme kurtarma (device/multi_audio_focus.py).

Cihazda ölçülen davranış sahtede de korunur: ayar anahtarı bayrağı değiştirmez; bayrağı yalnız servis çağrısı değiştirir ve durum
yalnız dökümden okunur. Bir çağrı sessizce dönüp bir şey değiştirmezse bu BAŞARI sayılmaz.
"""
import re

import pytest

from app.device.multi_audio_focus import MARKER_KEY, MultiAudioFocusService, parse_flag


class _Phone:
    """`settings get/put/delete global` + `dumpsys audio | grep` yapan sahte cihaz; bayrak yalnız `flag` alanında."""

    def __init__(self, flag=False, **globals_):
        self.flag = flag
        self.g = dict(globals_)
        self.shells = []

    async def shell(self, cmd, serial=None, timeout_s=None):
        self.shells.append(cmd)
        if cmd.startswith("dumpsys audio"):
            return f"Multi Audio Focus enabled :{'true' if self.flag else 'false'}\n"
        m = re.fullmatch(r"settings (get|put|delete) global (\w+)(?: (\S+))?", cmd)
        verb, key, value = m.groups()
        if verb == "put":
            self.g[key] = value  # NOT: multi_audio_focus_enabled anahtarı bayrağı DEĞİŞTİRMEZ (cihazda ölçüldü)
        elif verb == "delete":
            self.g.pop(key, None)
        return self.g.get(key, "null") if verb == "get" else ""


class _Daemon:
    supports_multi_audio_focus = True

    def __init__(self, phone, *, applies=True, error=None):
        self.phone, self.applies, self.error, self.calls = phone, applies, error, []

    async def multi_audio_focus(self, enabled=None):
        self.calls.append(enabled)
        if self.error:
            return {"ok": False, "error": self.error}
        if enabled is None:
            return {"ok": True, "enabled": self.phone.flag}
        if self.applies:
            self.phone.flag = enabled
        return {"ok": True, "requested": enabled, "enabled": self.phone.flag, "applied": self.phone.flag == enabled}


class _OldDaemon:
    supports_multi_audio_focus = False


class _Bus:
    def __init__(self):
        self.events = []

    async def emit(self, type, **payload):
        self.events.append((type, payload))


def _svc(phone, daemon, live, policy=("ask",), bus=None, now=(1000.0,)):
    bus = bus or _Bus()
    clock = list(now)
    service = MultiAudioFocusService(
        phone, lambda: "SER", lambda: daemon, lambda: live[0], _policy(policy), bus.emit, clock=lambda: clock[0],
    )
    service._bus, service._clock_box = bus, clock
    return service


def _policy(box):
    async def get():
        return box[0]
    return get


# ------------------------------------------------------------------ ayrıştırma


@pytest.mark.parametrize("text,want", [
    ("Multi Audio Focus enabled :false", False),
    ("Multi Audio Focus enabled :true", True),
    ("xx\nMulti Audio Focus enabled: true\nyy", True),
    ("Multi Audio Focus enabled :maybe", None),
    ("", None),
    (None, None),
])
def test_parse_flag_never_guesses(text, want):
    assert parse_flag(text) is want


# ------------------------------------------------------------------ okuma (telefonu DEĞİŞTİRMEZ)


async def test_read_reports_the_live_flag_and_changes_nothing_on_the_phone():
    phone = _Phone(flag=False, multi_audio_focus_enabled="1")  # ayar "açık" görünür ama uygulanmıyor (cihazdaki bulgu)
    daemon = _Daemon(phone)
    service = _svc(phone, daemon, [True])

    snap = await service.read()

    assert snap["state"] == "off" and snap["enabled"] is False and snap["owner"] is None
    assert snap["checked_at"] == 1000.0 and snap["can_set"] is True
    assert daemon.calls == [None]                      # yalnız okuma
    assert phone.flag is False and MARKER_KEY not in phone.g


async def test_read_falls_back_to_dumpsys_when_the_helper_is_old():
    phone = _Phone(flag=True)
    service = _svc(phone, _OldDaemon(), [True])

    snap = await service.read()

    assert snap["state"] == "on" and snap["owner"] == "phone" and snap["can_set"] is False
    assert any(c.startswith("dumpsys audio") for c in phone.shells)


async def test_a_phone_that_prints_no_flag_line_is_unsupported_not_off():
    class _Silent(_Phone):
        async def shell(self, cmd, serial=None, timeout_s=None):
            return "" if cmd.startswith("dumpsys") else await super().shell(cmd, serial, timeout_s)

    service = _svc(_Silent(), _OldDaemon(), [True])
    snap = await service.read()
    assert snap["state"] == "unsupported" and snap["error"] == "flag_not_found" and snap["enabled"] is None


async def test_no_device_is_unknown():
    service = MultiAudioFocusService(_Phone(), lambda: None, lambda: None, lambda: False, _policy(["ask"]), _Bus().emit)
    snap = await service.read()
    assert snap["state"] == "unknown" and snap["error"] == "no_device"


async def test_every_read_is_published_with_the_policy_and_a_timestamp():
    phone, bus = _Phone(flag=False), _Bus()
    service = _svc(phone, _Daemon(phone), [True], policy=["always"], bus=bus)
    await service.read()
    kinds = [e[0] for e in bus.events]
    assert kinds and set(kinds) == {"multi_audio_focus_update"}
    assert bus.events[-1][1]["policy"] == "always" and bus.events[-1][1]["checked_at"] == 1000.0


# ------------------------------------------------------------------ uygulama + doğrulama + geri alma


async def test_enable_saves_the_original_applies_verifies_and_disable_restores():
    phone = _Phone(flag=False)
    service = _svc(phone, _Daemon(phone), [True])

    snap = await service.enable()
    assert snap["state"] == "on" and snap["owner"] == "opendex" and snap["busy"] is False and snap["session"] is True
    assert phone.flag is True and phone.g[MARKER_KEY] == "0"      # özgün değer cihazda yedeklendi

    snap = await service.disable()
    assert snap["state"] == "off" and snap["session"] is False
    assert phone.flag is False and MARKER_KEY not in phone.g


async def test_a_call_that_returns_quietly_but_changes_nothing_is_a_failure_not_a_success():
    phone = _Phone(flag=False)
    service = _svc(phone, _Daemon(phone, applies=False), [True])

    snap = await service.enable()

    assert snap["state"] == "failed" and snap["error"] == "not_applied"
    assert snap["enabled"] is False and snap["owner"] is None
    assert MARKER_KEY not in phone.g                                # bir şey değişmedi: yedek bırakılmaz


@pytest.mark.parametrize("error", ["permission_denied", "method_missing", "audio_service_missing"])
async def test_a_phone_that_refuses_the_call_is_unsupported_with_its_reason(error):
    phone = _Phone(flag=False)

    class _Refusing(_Daemon):
        async def multi_audio_focus(self, enabled=None):
            if enabled is None:
                return {"ok": True, "enabled": self.phone.flag}
            return {"ok": False, "requested": enabled, "error": error}

    snap = await _svc(phone, _Refusing(phone), [True]).enable()
    assert snap["state"] == "unsupported" and snap["error"] == error


async def test_an_old_helper_cannot_set_and_says_so():
    phone = _Phone(flag=False)
    snap = await _svc(phone, _OldDaemon(), [True]).enable()
    assert snap["state"] == "unsupported" and snap["error"] == "daemon_required" and phone.flag is False


async def test_a_flag_the_phone_already_had_on_is_never_touched_or_undone():
    phone = _Phone(flag=True)
    daemon = _Daemon(phone)
    service = _svc(phone, daemon, [True])

    snap = await service.enable()
    assert snap["state"] == "on" and snap["owner"] == "phone"
    assert daemon.calls == [None]                                   # yazma çağrısı yok
    assert MARKER_KEY not in phone.g

    await service.release("SER")
    assert phone.flag is True                                       # telefonun kendi değeri: geri alınmaz


async def test_the_original_saved_by_a_crashed_session_is_not_overwritten():
    phone = _Phone(flag=False, **{MARKER_KEY: "0"})
    service = _svc(phone, _Daemon(phone), [True])
    await service.enable()
    assert phone.g[MARKER_KEY] == "0"


# ------------------------------------------------------------------ kira: pencere ömrü + politika


async def test_ask_policy_never_applies_without_the_users_consent():
    phone = _Phone(flag=False)
    live = [True]
    service = _svc(phone, _Daemon(phone), live, policy=["ask"])
    await service.sync()
    assert phone.flag is False


async def test_consent_holds_while_windows_exist_and_the_last_window_gives_it_back():
    phone = _Phone(flag=False)
    live = [True]
    service = _svc(phone, _Daemon(phone), live, policy=["ask"])
    await service.enable()
    assert phone.flag is True

    live[0] = False                                                 # son pencere kapandı
    await service.sync()
    assert phone.flag is False and MARKER_KEY not in phone.g

    live[0] = True                                                  # oturum içinde yeni pencere: onay hâlâ geçerli
    await service.sync()
    assert phone.flag is True


async def test_always_policy_applies_when_windows_open_and_releases_when_they_close():
    phone = _Phone(flag=False)
    live = [False]
    service = _svc(phone, _Daemon(phone), live, policy=["always"])

    await service.sync()
    assert phone.flag is False                                      # pencere yok → uygulanmaz

    live[0] = True
    await service.sync()
    assert phone.flag is True and phone.g[MARKER_KEY] == "0"

    live[0] = False
    await service.sync()
    assert phone.flag is False and MARKER_KEY not in phone.g


async def test_never_policy_overrides_everything_and_undoes_what_is_on():
    phone = _Phone(flag=False)
    live, policy = [True], ["ask"]
    service = _svc(phone, _Daemon(phone), live, policy=policy)
    await service.enable()
    assert phone.flag is True

    policy[0] = "never"
    await service.sync()
    assert phone.flag is False


async def test_a_users_off_sticks_until_the_policy_changes():
    phone = _Phone(flag=False)
    live, policy = [True], ["always"]
    service = _svc(phone, _Daemon(phone), live, policy=policy)
    await service.sync()
    assert phone.flag is True

    await service.disable()
    await service.sync()
    assert phone.flag is False                                      # "always" olsa da kullanıcı kapattı

    await service.on_policy_changed()                               # politika yeniden seçildi
    await service.sync()
    assert phone.flag is True


async def test_a_crashed_session_is_undone_on_the_next_bind():
    phone = _Phone(flag=True, **{MARKER_KEY: "0"})                  # arka uç bayrağı açıp çöktü
    service = _svc(phone, _Daemon(phone), [False])
    await service.sync()                                            # yeni oturum, pencere yok
    assert phone.flag is False and MARKER_KEY not in phone.g


async def test_a_failed_apply_is_not_retried_on_every_window_change():
    phone = _Phone(flag=False)
    daemon = _Daemon(phone, applies=False)
    live = [True]
    service = _svc(phone, daemon, live, policy=["always"])

    await service.sync()
    first = len(daemon.calls)
    await service.sync()
    assert len(daemon.calls) == first                                # 30 sn dolmadan yeniden denenmez

    service._clock_box[0] += 31.0
    await service.sync()
    assert len(daemon.calls) > first


async def test_a_flag_the_phone_owns_is_not_re_read_on_every_window_change():
    phone = _Phone(flag=True)
    daemon = _Daemon(phone)
    live = [True]
    service = _svc(phone, daemon, live, policy=["always"])
    await service.sync()
    reads = len(daemon.calls)
    for _ in range(3):
        await service.sync()
    assert len(daemon.calls) == reads


async def test_release_without_a_device_never_raises():
    service = _svc(_Phone(), _Daemon(_Phone()), [False])
    await service.release(None)


# ------------------------------------------------------------------ HTTP yüzeyi


def _client(phone=None, daemon=None, serial="SER"):
    from fastapi.testclient import TestClient

    from app.main import create_app

    client = TestClient(create_app())            # `with` yok: ömür döngüsü (cihaz keşfi…) başlamaz
    ctx = client.app.state.ctx
    ctx.serial = serial
    if phone is not None:
        ctx.multi_audio_focus = MultiAudioFocusService(
            phone, lambda: serial, lambda: daemon, lambda: True, _policy(["ask"]), _Bus().emit,
        )
    return client


def test_without_a_device_the_flag_is_unknown_and_writing_it_is_refused():
    client = _client(serial=None)
    body = client.get("/api/audio/multi-focus").json()
    assert body["state"] == "unknown" and body["policy"] == "ask" and body["can_set"] is False
    assert client.post("/api/audio/multi-focus/recheck").status_code == 409
    assert client.put("/api/audio/multi-focus", json={"enabled": True}).status_code == 409


def test_a_non_boolean_answer_is_rejected_by_validation():
    client = _client()
    assert client.put("/api/audio/multi-focus", json={"enabled": "yes please"}).status_code == 422
    assert client.put("/api/audio/multi-focus", json={}).status_code == 422


def test_recheck_reads_the_phone_and_put_applies_then_reads_back():
    phone = _Phone(flag=False)
    client = _client(phone, _Daemon(phone))

    snap = client.post("/api/audio/multi-focus/recheck").json()
    assert snap["state"] == "off" and snap["checked_at"] is not None

    snap = client.put("/api/audio/multi-focus", json={"enabled": True}).json()
    assert snap["state"] == "on" and snap["owner"] == "opendex" and phone.flag is True
    assert client.get("/api/audio/multi-focus").json()["state"] == "on"

    snap = client.put("/api/audio/multi-focus", json={"enabled": False}).json()
    assert snap["state"] == "off" and phone.flag is False


def test_a_phone_that_does_not_take_it_is_a_409_with_the_reason():
    phone = _Phone(flag=False)
    res = _client(phone, _Daemon(phone, applies=False)).put("/api/audio/multi-focus", json={"enabled": True})
    assert (res.status_code, res.json()["detail"]) == (409, "not_applied")

    res = _client(_Phone(), _OldDaemon()).put("/api/audio/multi-focus", json={"enabled": True})
    assert (res.status_code, res.json()["detail"]) == (409, "not_supported")


def test_the_policy_is_a_validated_setting():
    from app.schemas import ProjectSettings

    assert ProjectSettings().multi_audio_focus_policy == "ask"
    assert ProjectSettings(multi_audio_focus_policy="always").multi_audio_focus_policy == "always"
    with pytest.raises(ValueError):
        ProjectSettings(multi_audio_focus_policy="sometimes")


async def test_a_flag_the_phone_lost_by_itself_is_noticed_and_re_applied_while_the_consent_lasts():
    phone = _Phone(flag=False)
    live = [True]
    service = _svc(phone, _Daemon(phone), live, policy=["ask"])
    await service.enable()
    assert phone.flag is True

    phone.flag = False                                              # telefon yeniden başladı / başka bileşen kapattı
    snap = await service.read()
    assert snap["state"] == "off" and snap["owner"] is None         # "OpenDeX açtı" demeye devam etmez

    await service.sync()                                            # onay sürüyor, pencere var → yeniden uygulanır
    assert phone.flag is True
