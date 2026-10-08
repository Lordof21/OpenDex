"""Görev pencereleme kipi: temiz çıkış + doğrulama.

Ayrıştırıcılar gerçek AOSP dumpsys parçalarıyla, akış ise DURUMU TUTAN sahte adb ile sınanır: sahte cihaz komutlara
gerçekten tepki verir (kip değişir), böylece "uygula → doğrula → yeniden yerleştir" merdiveni uçtan uca kanıtlanır.
"""
import logging

import re

import pytest

from app.windows.task_windowing import (
    FREEFORM,
    FULLSCREEN,
    TaskWindowingState,
    cold_relaunch,
    freeform_box_for,
    parse_display_size,
    parse_task_windowing,
    read_task_windowing,
    settle_task_windowing,
    verify_windowing,
)

PHONE = (1080, 2400)


def _block(task_id, mode, bounds, pkg="com.app.a", display=0, override_mode="undefined"):
    l, t, r, b = bounds
    return (
        f"  * Task{{6ae7b4f #{task_id} type=standard A=10087:{pkg} U=0 visible=true mode={mode} translucent=false sz=1}}\n"
        f"    mDisplayId={display}\n"
        f"    mOverrideConfiguration={{1.0 winConfig={{ mBounds=Rect(0, 0 - 0, 0) mWindowingMode={override_mode} }}}}\n"
        f"    mFullConfiguration={{1.0 winConfig={{ mBounds=Rect({l}, {t} - {r}, {b}) mWindowingMode={mode} }}}}\n"
    )


# ------------------------------------------------------------------ ayrıştırıcı

class TestParseTaskWindowing:
    def test_baslik_satirindaki_kip_ve_kutu(self):
        state = parse_task_windowing(_block(12, "freeform", (80, 80, 700, 500)), "12")

        assert state.found is True
        assert state.windowing_mode == FREEFORM
        assert state.bounds == (80, 80, 700, 500)
        assert state.display_id == "0"
        assert state.mode_name == "freeform"

    def test_fullscreen(self):
        state = parse_task_windowing(_block(12, "fullscreen", (0, 0, 1080, 2400)), "12")
        assert (state.windowing_mode, state.bounds) == (FULLSCREEN, (0, 0, 1080, 2400))

    def test_override_yapilandirmasindaki_undefined_gercek_kip_sayilmaz(self):
        # başlık satırı yoksa yapılandırmadaki İLK undefined atlanıp etkin kip alınmalı
        raw = (
            "  * Task{6ae7b4f #12 type=standard A=10087:com.app.a U=0 visible=true translucent=false sz=1}\n"
            "    mOverrideConfiguration={1.0 winConfig={ mBounds=Rect(0, 0 - 0, 0) mWindowingMode=undefined }}\n"
            "    mFullConfiguration={1.0 winConfig={ mBounds=Rect(0, 0 - 1080, 2400) mWindowingMode=fullscreen }}\n"
        )
        state = parse_task_windowing(raw, "12")
        assert state.windowing_mode == FULLSCREEN
        assert state.bounds == (0, 0, 1080, 2400)  # boş override kutusu atlandı

    def test_kucuk_kutular_gercek_pencere_degildir(self):
        raw = _block(12, "fullscreen", (0, 0, 60, 40))
        assert parse_task_windowing(raw, "12").bounds is None

    def test_baska_gorevin_blogu_karismaz(self):
        raw = _block(11, "fullscreen", (0, 0, 1080, 2400), pkg="com.other") + _block(12, "freeform", (80, 80, 700, 500))
        assert parse_task_windowing(raw, "12").windowing_mode == FREEFORM
        assert parse_task_windowing(raw, "11").windowing_mode == FULLSCREEN

    def test_gorev_id_onek_eslesmesi_yapmaz(self):
        # #123 varken #12 aranırsa 123'ün bloğu dönmemeli
        raw = _block(123, "freeform", (80, 80, 700, 500))
        assert parse_task_windowing(raw, "12").found is False

    def test_bulunamayan_veya_bos_cikti(self):
        assert parse_task_windowing("", "12").found is False
        assert parse_task_windowing("baska bir cikti", "12").found is False
        assert parse_task_windowing(None, "12").found is False  # type: ignore[arg-type]

    def test_taninmayan_kip_adi_unknown_birakir(self):
        raw = "  * Task{x #12 type=standard mode=garip-kip translucent=false}\n"
        state = parse_task_windowing(raw, "12")
        assert state.found is True and state.windowing_mode is None


class TestParseDisplaySize:
    def test_fiziksel_boyut(self):
        assert parse_display_size("Physical size: 1080x2400\n") == PHONE

    def test_override_boyutu_kazanir(self):
        assert parse_display_size("Physical size: 1080x2400\nOverride size: 1080x2000\n") == (1080, 2000)

    def test_bozuk_veya_bos(self):
        assert parse_display_size("") is None
        assert parse_display_size("hata: bulunamadı") is None


class TestVerify:
    def fs(self, bounds=None, mode=FULLSCREEN):
        return TaskWindowingState(task_id="12", found=True, windowing_mode=mode, bounds=bounds)

    def test_tam_ekran_dogru(self):
        assert verify_windowing(self.fs((0, 0, 1080, 2400)), "fullscreen", PHONE) == "ok"

    def test_yon_farketmez_yatay_ekran(self):
        assert verify_windowing(self.fs((0, 0, 2400, 1080)), "fullscreen", PHONE) == "ok"

    def test_kip_freeform_ise_bad(self):
        assert verify_windowing(self.fs((80, 80, 700, 500), mode=FREEFORM), "fullscreen", PHONE) == "bad"

    def test_kip_dogru_ama_ekrani_doldurmuyorsa_bad(self):
        assert verify_windowing(self.fs((80, 80, 700, 500)), "fullscreen", PHONE) == "bad"

    def test_ekran_boyutu_bilinmiyorsa_yalniz_kipe_bakilir(self):
        assert verify_windowing(self.fs((80, 80, 700, 500)), "fullscreen", None) == "ok"

    def test_okunamayan_durum_unknown_bad_degil(self):
        assert verify_windowing(None, "fullscreen", PHONE) == "unknown"
        assert verify_windowing(TaskWindowingState("12", found=False), "fullscreen", PHONE) == "unknown"
        assert verify_windowing(TaskWindowingState("12", found=True, windowing_mode=None), "fullscreen", PHONE) == "unknown"

    def test_freeform_hedefi(self):
        assert verify_windowing(self.fs((80, 80, 700, 500), mode=FREEFORM), "freeform", PHONE) == "ok"
        assert verify_windowing(self.fs((0, 0, 1080, 2400)), "freeform", PHONE) == "bad"


def test_freeform_kutusu_ekranin_yuzde_seksen_ortali():
    assert freeform_box_for(PHONE) == (108, 240, 972, 2160)
    assert freeform_box_for(None) is None


# ------------------------------------------------------------------ durumu tutan sahte cihaz
#
# Gerçeğe sadık: bir görevin pencereleme kipini değiştiren İKİ yol vardır — daemon'un WindowContainerTransaction'ı ve
# etkinliği `am start --windowingMode N` ile yeniden yerleştirmek. `am task` yalnız lock / resizeable / resize / focus
# bilir; `cmd activity task windowing-mode` AOSP'de "unknown command"dır (eski sahte cihaz onu "çalışıyor" sayıyordu ve
# Workspace'e dönüşün tam ekranda kalması bu yüzden testlerden geçti).

class _Device:
    """Komutlara TEPKİ veren sahte cihaz. `relayout_fixes`: `am start --windowingMode` kipi düzeltir mi."""

    def __init__(self, mode="freeform", bounds=(80, 80, 700, 500), relayout_fixes=True, readable=True, display=PHONE):
        self.mode = mode
        self.bounds = bounds
        self.relayout_fixes = relayout_fixes
        self.readable = readable
        self.display = display
        self.calls = []

    def become(self, mode, box=None):
        self.mode = mode
        self.bounds = (0, 0, *self.display) if mode == "fullscreen" else (box or (108, 240, 972, 2160))

    async def shell(self, cmd, *, serial, timeout_s=3.0):
        self.calls.append(cmd)
        if cmd.startswith("dumpsys activity activities"):
            return _block(12, self.mode, self.bounds) if self.readable else "yok"
        if cmd.startswith("wm size"):
            return f"Physical size: {self.display[0]}x{self.display[1]}"
        if "task windowing-mode" in cmd:
            return "Error: unknown command 'windowing-mode'"  # AOSP ActivityManagerShellCommand.runTask
        m = re.search(r"task resize 12 (\d+) (\d+) (\d+) (\d+)", cmd)
        if m and self.mode == "freeform":
            self.bounds = tuple(int(v) for v in m.groups())
        if cmd.startswith("am start") and "--windowingMode" in cmd and self.relayout_fixes:
            self.become("fullscreen" if "--windowingMode 1" in cmd else "freeform")
        return ""


class _Daemon:
    """The daemon's WCT setter. `applies`: whether the transaction really changes the task (an OEM may ignore it)."""

    is_connected = True

    def __init__(self, dev, *, applies=True, place=True, result=True):
        self.dev, self.applies, self.result, self.calls = dev, applies, result, []
        self.daemon_capabilities = {"set_task_windowing_bounds"} if place else set()

    def supports(self, capability):
        return capability in self.daemon_capabilities

    async def set_task_windowing(self, task_id, mode, clear_bounds=False, bounds=None):
        self.calls.append((task_id, mode, clear_bounds, bounds))
        if self.applies and self.result:
            self.dev.become("fullscreen" if mode == FULLSCREEN else "freeform", bounds)
        return self.result


async def _no_sleep(_s):
    return None


async def _settle(device, **kwargs):
    kwargs.setdefault("sleep", _no_sleep)
    return await settle_task_windowing(device, "SER", "12", "com.app.a", **kwargs)


def _relayouts(device):
    return [c for c in device.calls if c.startswith("am start") and "--windowingMode" in c]


@pytest.mark.asyncio
async def test_daemon_ile_tek_denemede_duzelir_yeniden_yerlesim_yok():
    dev = _Device()
    daemon = _Daemon(dev)

    report = await _settle(dev, daemon=daemon)

    assert (report.verdict, report.attempts, report.method, report.relayout) == ("ok", 1, "daemon", False)
    assert report.before.windowing_mode == FREEFORM and report.after.windowing_mode == FULLSCREEN
    assert daemon.calls == [("12", FULLSCREEN, True, None)]  # tam ekranda bounds da temizlenir
    assert _relayouts(dev) == []


@pytest.mark.asyncio
async def test_var_olmayan_kabuk_komutu_hic_gonderilmez_ve_basari_sayilmaz():
    """Daemon yokken eskiden `cmd activity task windowing-mode` gönderilip yöntem 'shell' (başarılı) raporlanıyordu."""
    dev = _Device(relayout_fixes=True)

    report = await _settle(dev)

    assert not any("task windowing-mode" in c for c in dev.calls)
    assert report.method == "none"
    assert report.verdict == "ok" and report.attempts == 2 and report.relayout is True  # yeniden yerleşim düzeltti


@pytest.mark.asyncio
async def test_inatci_kalinti_yeniden_yerlesimle_duzelir():
    """Daemon işlemi kabul ediyor ama OEM görevi değiştirmiyor: 2. denemede etkinlik --windowingMode 1 ile öne alınır."""
    dev = _Device()

    report = await _settle(dev, daemon=_Daemon(dev, applies=False))

    assert report.verdict == "ok"
    assert report.attempts == 2 and report.relayout is True
    assert any(c.startswith("am start --display 0 --windowingMode 1") and "-p com.app.a" in c for c in dev.calls)


@pytest.mark.asyncio
async def test_hic_duzelmezse_uc_deneme_sonra_bad_ve_yikici_adim_YOK():
    dev = _Device(relayout_fixes=False)

    report = await _settle(dev, daemon=_Daemon(dev, applies=False))

    assert (report.verdict, report.attempts) == ("bad", 3)
    assert not any("force-stop" in c for c in dev.calls)  # settle asla uygulamayı öldürmez (son çare çağıranındır)


@pytest.mark.asyncio
async def test_durum_okunamiyorsa_tek_deneme_unknown():
    dev = _Device(readable=False)
    daemon = _Daemon(dev)

    report = await _settle(dev, daemon=daemon)

    assert (report.verdict, report.attempts) == ("unknown", 1)
    assert len(daemon.calls) == 1 and _relayouts(dev) == []  # döngüye girmedi


@pytest.mark.asyncio
async def test_kip_dogru_ama_kutu_ekrani_doldurmuyorsa_yeniden_dener():
    dev = _Device(mode="fullscreen", bounds=(80, 80, 700, 500))

    report = await _settle(dev, daemon=_Daemon(dev, applies=False))

    assert report.verdict == "ok" and report.attempts == 2


@pytest.mark.asyncio
@pytest.mark.parametrize("failure", ["false", "raises", "old_jar_without_method"])
async def test_daemon_basarisizsa_yeniden_yerlesim_devralir(failure):
    dev = _Device()

    class _Broken:
        is_connected = True

        def supports(self, _c):
            return False

    daemon = _Broken()
    if failure == "false":
        async def _f(task_id, mode, clear_bounds=False, bounds=None):
            return False
        daemon.set_task_windowing = _f
    elif failure == "raises":
        async def _f(task_id, mode, clear_bounds=False, bounds=None):
            raise RuntimeError("boom")
        daemon.set_task_windowing = _f

    report = await _settle(dev, daemon=daemon)

    assert report.method == "none" and report.verdict == "ok" and report.relayout is True


@pytest.mark.asyncio
async def test_freeform_hedefi_kip_5_ve_kutu_ayni_islemde():
    dev = _Device(mode="fullscreen", bounds=(0, 0, *PHONE))
    daemon = _Daemon(dev)

    report = await _settle(dev, target="freeform", daemon=daemon)

    assert report.verdict == "ok" and report.after.windowing_mode == FREEFORM
    assert daemon.calls == [("12", FREEFORM, False, (108, 240, 972, 2160))]
    assert not any("task resize" in c for c in dev.calls)  # kutu işlemle geldi


@pytest.mark.asyncio
async def test_freeform_verilen_kutuya_yerlesir_eski_daemonda_kutuyu_kabuk_koyar():
    dev = _Device(mode="fullscreen", bounds=(0, 0, *PHONE))
    daemon = _Daemon(dev, place=False)  # set_task_windowing_bounds yok (eski jar)

    report = await _settle(dev, target="freeform", daemon=daemon, freeform_bounds=(20, 20, 600, 500))

    assert report.verdict == "ok"
    assert daemon.calls == [("12", FREEFORM, False, None)]
    assert "cmd activity task resize 12 20 20 600 500" in dev.calls
    assert report.after.bounds == (20, 20, 600, 500)


@pytest.mark.asyncio
async def test_skip_if_ok_zaten_hedefteyse_hicbir_komut_gondermez():
    dev = _Device(mode="fullscreen", bounds=(0, 0, *PHONE))
    daemon = _Daemon(dev)

    report = await _settle(dev, skip_if_ok=True, daemon=daemon)

    assert (report.verdict, report.attempts, report.method) == ("ok", 0, "none")
    assert daemon.calls == [] and _relayouts(dev) == []  # yalnız okuma yapıldı; normal pencere aktarımı gecikmez


@pytest.mark.asyncio
async def test_skip_if_ok_hedefte_degilse_yine_duzeltir():
    dev = _Device(mode="freeform")
    daemon = _Daemon(dev)

    report = await _settle(dev, skip_if_ok=True, daemon=daemon)

    assert (report.verdict, report.attempts) == ("ok", 1)
    assert daemon.calls[0][:2] == ("12", FULLSCREEN)


@pytest.mark.asyncio
async def test_skip_if_ok_okunamayan_durumda_atlamaz():
    dev = _Device(readable=False)
    daemon = _Daemon(dev)

    report = await _settle(dev, skip_if_ok=True, daemon=daemon)

    assert report.attempts == 1 and len(daemon.calls) == 1


@pytest.mark.asyncio
async def test_gecersiz_hedef_hata_verir():
    with pytest.raises(ValueError):
        await _settle(_Device(), target="saçma")


@pytest.mark.asyncio
async def test_gecis_raporu_tek_satir_before_ve_after_loglanir(caplog):
    dev = _Device()
    with caplog.at_level(logging.INFO):
        await _settle(dev, wlog=logging.getLogger("test.transfer"), daemon=_Daemon(dev))

    lines = [r.getMessage() for r in caplog.records if "[TRANSFER]" in r.getMessage()]
    assert len(lines) == 2
    assert "phase=before" in lines[0] and "mode=5(freeform)" in lines[0] and "bounds=(80, 80, 700, 500)" in lines[0]
    assert "phase=after" in lines[1] and "verdict=ok" in lines[1] and "attempts=1" in lines[1] and "method=daemon" in lines[1]
    assert "render=" in lines[1]  # SurfaceFlinger özeti de aynı satırda


@pytest.mark.asyncio
async def test_okuma_hatasi_gecisi_bozmaz():
    class _Broken:
        async def shell(self, *_a, **_kw):
            raise RuntimeError("adb koptu")

    state = await read_task_windowing(_Broken(), "SER", "12")
    assert state.found is False
    report = await settle_task_windowing(_Broken(), "SER", "12", "com.app.a", sleep=_no_sleep)
    assert report.verdict == "unknown"


@pytest.mark.asyncio
async def test_cold_relaunch_once_durdurur_sonra_hedef_display_de_baslatir():
    dev = _Device()
    await cold_relaunch(dev, "SER", "com.app.a", "0")

    assert dev.calls[0] == "am force-stop com.app.a"
    assert dev.calls[1].startswith("am start --display 0") and "-p com.app.a" in dev.calls[1]
