"""Device-load telemetry — how much OpenDeX makes the phone work, measured end to end.

Signals (one OTel-like "resource" = the bound phone):
  * gauges sampled on the phone by ONE cheap `adb shell` per tick (``probe``): temperatures, CPU, per-process CPU,
    battery power, CPU/GPU clocks;
  * host-side counters that cost the phone nothing: every adb command / daemon RPC OpenDeX sends (``adb_meter``),
    the video each window streams (bytes and packets through its broadcaster);
  * events on the same timeline (``markers``): app restarts, DPI changes, window open/close, handoff, thermal.

``load_monitor`` joins them into samples, ``insights`` turns a window of samples into plain-language findings
("the phone is heating 0.4 °C/min; YouTube was restarted 14 times"), the API and /ws/events deliver them to the
Telefon Yükü panel.
"""
from .hub import TelemetryHub, MAX_PHONE_APPS, PHONE
from . import insights, markers, probe
from .adb_meter import AdbMeter, classify, meter
from .load_monitor import DeviceLoadMonitor

__all__ = [
    "TelemetryHub",
    "MAX_PHONE_APPS",
    "PHONE",
    "insights",
    "markers",
    "probe",
    "AdbMeter",
    "classify",
    "meter",
    "DeviceLoadMonitor",
]
