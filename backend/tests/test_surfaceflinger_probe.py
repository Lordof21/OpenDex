"""Omni-Adapter SurfaceFlinger & WindowManager Probe Birim Testleri.

Gerçek cihazlardan (Xiaomi HyperOS, AOSP/Pixel) toplanmış SurfaceFlinger ve
WindowManager döküm örnekleri üzerinde parse_task_layers ve resolve_render_info
mantığının kusursuz çalıştığını doğrular.
"""
import pytest
from app.windows.surfaceflinger_probe import (
    _UNIVERSAL_BOX_RE,
    _TRANSFORM_SCALE_RE,
    _SOURCE_CROP_RE,
    _DISPLAY_FRAME_RE,
    TaskGeometry,
)

# Canlı POCO F6 Pro dumpsys SurfaceFlinger çıktısından birebir kesit
REAL_XIAOMI_SF_DUMP = """
LayerStack=62
  Layer [10930] Task=4464#10930
    visible reason= color{< 1, 1, 1, 1 >} drawMiuiShadows
    bounds={80,80,684.8,1245.5} toDisplayTransform={ scale x=0.7000 y=0.7000  tx=80.0000 ty=80.0000 }
    input{(NO_INPUT_CHANNEL | TRUSTED_OVERLAY) touchableRegion={80,80,80,80}}
    viewCornerRadii={(0,0) (0,0) (0,0) (0,0) }
    roundedCorner{84.2857,84.2857}
      isSecure=false privateLayer=0 smallCastLayer=0 geomUsesSourceCrop=false geomBufferUsesDisplayInverseTransform=false geomLayerTransform (ROT_0) (SCALE TRANSLATE)
    0.7000  0.0000  80.0000
    0.0000  0.7000  80.0000
    0.0000  0.0000  1.0000

  - Output Layer 0xb400007128a98fb0(com.openai.chatgpt/com.openai.chatgpt.MainActivity#10998)
        Region visibleRegion (this=0xb400007128a99028, count=1)
    [ 80,  80, 1246, 685]
        Region visibleNonTransparentRegion (this=0xb400007128a99090, count=1)
    [ 80,  80, 1246, 685]
      forceClientComposition=false clearClientTarget=false displayFrame=[80 80 1246 685] sourceCrop=[0.000000 0.000000 1665.000000 864.000000] bufferTransform=0 (0)"""

def test_regex_matching_real_xiaomi_dumpsys():
    # 1. Transform scale regex
    m_tr = _TRANSFORM_SCALE_RE.search(REAL_XIAOMI_SF_DUMP)
    assert m_tr is not None
    assert float(m_tr.group(1)) == 0.7000
    assert float(m_tr.group(2)) == 0.7000
    assert float(m_tr.group(3)) == 80.0
    assert float(m_tr.group(4)) == 80.0

    # 2. displayFrame regex
    m_df = _DISPLAY_FRAME_RE.search(REAL_XIAOMI_SF_DUMP)
    assert m_df is not None
    assert tuple(int(x) for x in m_df.groups()) == (80, 80, 1246, 685)

    # 3. sourceCrop regex
    m_sc = _SOURCE_CROP_RE.search(REAL_XIAOMI_SF_DUMP)
    assert m_sc is not None
    assert float(m_sc.group(3)) - float(m_sc.group(1)) == 1665.0
    assert float(m_sc.group(4)) - float(m_sc.group(2)) == 864.0

    # 4. Universal Box regex on visibleRegion
    m_reg = _UNIVERSAL_BOX_RE.search("[ 80,  80, 1246, 685]")
    assert m_reg is not None
    assert tuple(int(float(x)) for x in m_reg.groups()) == (80, 80, 1246, 685)


@pytest.mark.asyncio
async def test_probe_omni_geometry_parsing():
    from unittest.mock import AsyncMock
    from app.windows.surfaceflinger_probe import probe_omni_geometry

    mock_adb = AsyncMock()
    async def mock_shell(cmd, serial=None, timeout_s=None):
        if "SurfaceFlinger" in cmd:
            return REAL_XIAOMI_SF_DUMP
        return ""

    mock_adb.shell = mock_shell

    geom = await probe_omni_geometry(mock_adb, "DUMMY_SERIAL", "4464")
    assert geom is not None
    assert geom.render_bounds == (80, 80, 1246, 685)
    assert geom.scale_x == 0.7000
    assert geom.scale_y == 0.7000
    # Logical bounds (1665x864)
    assert geom.logical_bounds == (80, 80, 1745, 944)


DUMP_WITH_DECOR = REAL_XIAOMI_SF_DUMP.replace(
    "LayerStack=62\n",
    "LayerStack=62\n  Layer [10931] Task=4464#10931 caption\n    bounds={80,40,684,80}\n  Layer [10932] Task=4464#10932 resize handle\n    bounds={0,0,10,10}\n",
)


@pytest.mark.asyncio
async def test_probe_reports_the_window_chrome_the_system_drew_and_the_vendors_marks():
    """A phone-side freeform window is moved/resized by chrome the phone's SystemUI draws. Whether any exists is read out of
    the task's own layers (report-only) — and the vendor's freeform layer leaves its mark (HyperOS `drawMiuiShadows`)."""
    from unittest.mock import AsyncMock
    from app.windows.surfaceflinger_probe import probe_omni_geometry

    async def shell_with(dump):
        adb = AsyncMock()

        async def mock_shell(cmd, serial=None, timeout_s=None):
            return dump if "SurfaceFlinger" in cmd else ""

        adb.shell = mock_shell
        return await probe_omni_geometry(adb, "S", "4464")

    plain = await shell_with(REAL_XIAOMI_SF_DUMP)
    assert plain.decor_layers == () and plain.oem_marks == ("drawMiuiShadows",)

    chrome = await shell_with(DUMP_WITH_DECOR)
    assert len(chrome.decor_layers) == 2 and "caption" in chrome.decor_layers[0]
    assert chrome.render_bounds == (80, 80, 1246, 685)  # the chrome never becomes the content's box


# ---------------------------------------------------------------- window chrome of a task whose content box cannot be measured
# Layer blocks as a HyperOS 3.0 (Android 16) dump prints them for a freeform task on a virtual display (device-captured 2026-10-16).
CHROME_DUMP = """\
Displays (2 entries)
  Layer [3130] Miui Caption of Task=309#3130
    visible reason= buffer=12386685683113 frame=8
    bounds={230,53,65,290} toDisplayTransform={ tx=230.0000 ty=53.0000 }
      geomBufferSize=[0 0 60 12] geomContentCrop=[0 0 60 12] geomCrop=[0.000000 0.000000 -1.000000 -1.000000]
      blend=PREMULTIPLIED (2) alpha=1.000000 backgroundBlurRadius=0 miVisibleStateForDisplay=32

  Layer [3132] Miui Bottom Caption of Task=309#3132
    visible reason= buffer=12386685683118 frame=8
      geomBufferSize=[0 0 130 12] geomContentCrop=[0 0 130 12]
      blend=PREMULTIPLIED (2) alpha=0.500000 backgroundBlurRadius=0

  Layer [3140] Miui Caption of Task=310#3140
    visible reason= buffer=1 frame=2
      geomBufferSize=[0 0 60 12]
      blend=PREMULTIPLIED (2) alpha=1.000000

  Layer [3150] Miui Shadow of Task=309#3150
      geomBufferSize=[0 0 400 300]
      blend=PREMULTIPLIED (2) alpha=1.000000

Input list
  Layer [3130] Miui Caption of Task=309#3130
    visible reason= buffer=1 frame=1
"""


def test_parse_task_chrome_reads_each_layer_of_the_task_once_with_what_the_dump_says_about_it():
    from app.windows.surfaceflinger_probe import ChromeLayer, parse_task_chrome

    layers = parse_task_chrome(CHROME_DUMP, "309")
    assert layers == (
        ChromeLayer("Miui Caption of Task=309", visible=True, alpha=1.0, size=(60, 12)),
        ChromeLayer("Miui Bottom Caption of Task=309", visible=True, alpha=0.5, size=(130, 12)),
        ChromeLayer("Miui Shadow of Task=309", visible=False, alpha=1.0, size=(400, 300)),   # no `visible reason=` line: not on screen
    )                                                  # task 310's caption is not 309's; the input-list repeat is not a 2nd layer


def test_a_task_without_chrome_has_none():
    from app.windows.surfaceflinger_probe import format_task_chrome, parse_task_chrome

    assert parse_task_chrome(CHROME_DUMP, "311") == ()
    assert isinstance(parse_task_chrome(REAL_XIAOMI_SF_DUMP, "4464"), tuple)      # a real dump parses without raising
    assert format_task_chrome(()) == "chrome=yok"


def test_format_task_chrome_is_one_readable_log_field():
    from app.windows.surfaceflinger_probe import format_task_chrome, parse_task_chrome

    text = format_task_chrome(parse_task_chrome(CHROME_DUMP, "309"))
    assert text.startswith("chrome=[Miui Caption of Task=309 60x12 görünür α1.00; Miui Bottom Caption of Task=309 130x12 görünür α0.50")
    assert "Miui Shadow of Task=309 400x300 gizli α1.00" in text


@pytest.mark.asyncio
async def test_the_transfer_log_reports_chrome_even_when_the_content_box_cannot_be_measured(monkeypatch):
    """A Workspace task prints `render=?` (no measurable box). The chrome field still comes through — it is what separates a
    window that has HyperOS' header from one that has none."""
    from app.windows import surfaceflinger_probe, task_windowing

    async def surface(adb, serial, task_id):
        return None, surfaceflinger_probe.parse_task_chrome(CHROME_DUMP, task_id)

    monkeypatch.setattr(surfaceflinger_probe, "probe_task_surface", surface)
    summary = await task_windowing._sf_summary(None, "S", "309")
    assert summary.startswith("render=? scale=? chrome=[Miui Caption of Task=309 60x12 görünür")


@pytest.mark.asyncio
async def test_the_transfer_log_keeps_its_old_shape_when_the_dump_cannot_be_read(monkeypatch):
    from app.windows import surfaceflinger_probe, task_windowing

    async def unreadable(adb, serial, task_id):
        return None, ()

    monkeypatch.setattr(surfaceflinger_probe, "probe_task_surface", unreadable)
    assert await task_windowing._sf_summary(None, "S", "309") == "render=? scale=? chrome=yok"


@pytest.mark.asyncio
async def test_a_workspace_task_reports_its_window_chrome_once_the_system_had_time_to_draw_it(monkeypatch, caplog):
    """HyperOS draws the caption a moment after the freeform transition: the report waits (CHROME_REPORT_DELAYS_S, two readings: a caption that comes late vs one that never comes) and says how the
    task entered the Workspace (open / dock / guard) — the one fact that separates a window with a header from one without."""
    import logging
    from types import SimpleNamespace

    from app.windows import surfaceflinger_probe
    from app.windows.eco_workspace import EcoWorkspaceManager

    waited: list[float] = []

    async def fake_sleep(seconds):
        waited.append(seconds)

    async def surface(adb, serial, task_id):
        return None, surfaceflinger_probe.parse_task_chrome(CHROME_DUMP, task_id)

    monkeypatch.setattr("app.windows.eco_workspace.asyncio.sleep", fake_sleep)
    monkeypatch.setattr(surfaceflinger_probe, "probe_task_surface", surface)
    wlog = logging.getLogger("test.chrome")
    stub = SimpleNamespace(CHROME_REPORT_DELAYS_S=(1.5, 5.0), _adb=None)
    with caplog.at_level(logging.INFO, logger="test.chrome"):
        await EcoWorkspaceManager._report_chrome_later(stub, "S", 309, "com.android.vending", "dock", wlog)

    assert waited == [1.5, 3.5]                      # sleeps are relative: readings at +1.5 s and +5.0 s
    assert "[ECO WORKSPACE:CHROME] com.android.vending (task=309, dock) +1.5s chrome=[Miui Caption of Task=309 60x12 görünür" in caplog.text
    assert "(task=309, dock) +5.0s chrome=" in caplog.text
