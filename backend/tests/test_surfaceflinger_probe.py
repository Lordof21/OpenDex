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
