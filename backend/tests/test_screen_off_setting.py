"""`screen_off_while_mirroring` ayarının UYGULANMASI: eskiden yalnızca saklanıyordu."""
import types

import pytest

from app.api.v1.endpoints import windows as endpoint
from app.schemas.settings import ProjectSettings


class _Power:
    def __init__(self, boom=False):
        self.calls = []
        self.boom = boom

    async def set(self, on, source):
        self.calls.append((on, source))
        if self.boom:
            raise RuntimeError("adb koptu")
        return True


@pytest.fixture
def use_settings(monkeypatch):
    def apply(**overrides):
        async def _get():
            return ProjectSettings(**overrides)

        monkeypatch.setattr(endpoint.settings_db, "get_project_settings", _get)

    return apply


def _ctx(power):
    return types.SimpleNamespace(display_power=power)


@pytest.mark.asyncio
async def test_ayar_acik_ve_ilk_pencerede_ekran_tek_sahipten_kapatilir(use_settings):
    use_settings(screen_off_while_mirroring=True)
    power = _Power()

    assert await endpoint.apply_screen_off_setting(_ctx(power), first_window=True) is True

    assert power.calls == [(False, "mirror_setting")]  # DisplayPowerController: idempotent, toggle (keyevent 26) yok


@pytest.mark.asyncio
async def test_sonraki_pencereler_ekrani_tekrar_kapatmaz(use_settings):
    """Kullanıcı ekranı elle açtıysa her yeni pencere onu yeniden kapatmamalı."""
    use_settings(screen_off_while_mirroring=True)
    power = _Power()

    assert await endpoint.apply_screen_off_setting(_ctx(power), first_window=False) is False
    assert power.calls == []


@pytest.mark.asyncio
async def test_ayar_kapaliysa_hicbir_sey_yapilmaz(use_settings):
    use_settings(screen_off_while_mirroring=False)
    power = _Power()

    assert await endpoint.apply_screen_off_setting(_ctx(power), first_window=True) is False
    assert power.calls == []


@pytest.mark.asyncio
async def test_kapatma_basarisiz_olsa_pencere_acilisi_bozulmaz(use_settings):
    use_settings(screen_off_while_mirroring=True)

    assert await endpoint.apply_screen_off_setting(_ctx(_Power(boom=True)), first_window=True) is False  # istisna yutulur


@pytest.mark.asyncio
async def test_ayar_okunamazsa_sessizce_atlanir(monkeypatch):
    async def _boom():
        raise RuntimeError("db yok")

    monkeypatch.setattr(endpoint.settings_db, "get_project_settings", _boom)
    power = _Power()

    assert await endpoint.apply_screen_off_setting(_ctx(power), first_window=True) is False
    assert power.calls == []
