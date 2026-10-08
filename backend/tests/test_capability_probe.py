"""Encoder limit probe + cache behavior (query, don't guess)."""
from app.config import Settings
from app.device.capability_probe import CapabilityProbe, parse_concurrent_instances
from app.device.adb import AdbError

SAMPLE_XML = """
<MediaCodecs>
  <MediaCodec name="c2.qti.avc.encoder" type="video/avc">
    <Limit name="concurrent-instances" max="13" />
  </MediaCodec>
  <MediaCodec name="c2.qti.hevc.encoder" type="video/hevc">
    <Limit name="concurrent-instances" max="6" />
  </MediaCodec>
</MediaCodecs>
"""


class TestXmlParsing:
    def test_reads_avc_limit(self):
        assert parse_concurrent_instances(SAMPLE_XML, "video/avc") == 13

    def test_ignores_other_codecs(self):
        assert parse_concurrent_instances(SAMPLE_XML, "video/hevc") == 6

    def test_missing_codec_returns_none(self):
        assert parse_concurrent_instances(SAMPLE_XML, "video/av01") is None

    def test_garbage_returns_none(self):
        assert parse_concurrent_instances("<xml>nothing here</xml>") is None


class _StubAdb:
    def __init__(self, xml: str | None):
        self._xml = xml
        self.shell_calls = 0

    async def shell(self, cmd: str, serial=None, timeout_s=20.0) -> str:
        self.shell_calls += 1
        if self._xml is None:
            raise AdbError([cmd], 1, "No such file")
        return self._xml


class _StubDevices:
    async def get_android_version(self, serial: str) -> int:
        return 34


def _probe(adb) -> CapabilityProbe:
    return CapabilityProbe(adb, _StubDevices(), Settings(FALLBACK_ENCODER_LIMIT=2))


async def test_probe_reads_oem_published_value():
    probe = _probe(_StubAdb(SAMPLE_XML))
    assert await probe.probe_encoder_limit("SER") == 13


async def test_probe_falls_back_when_oem_hides_the_value():
    probe = _probe(_StubAdb(None))
    assert await probe.probe_encoder_limit("SER") == 2


async def test_probe_runs_once_then_serves_from_cache(tmp_db):
    adb = _StubAdb(SAMPLE_XML)
    probe = _probe(adb)

    first = await probe.get_or_probe("SER", "android-123")
    calls_after_probe = adb.shell_calls
    second = await probe.get_or_probe("SER", "android-123")

    assert first.encoder_limit == second.encoder_limit == 13
    assert adb.shell_calls == calls_after_probe  # no re-probe for a known device
    assert first.android_api == 34
