"""Zero-Apps ADB XML Element Inspector (Faz 3+ Deneysel Mod).

Under the Zero-Apps rule, no APK is installed on the phone.
This module uses ADB shell `uiautomator dump` to parse the screen's UI hierarchy XML
and extract text nodes and bounding boxes for element inspection.
"""
from __future__ import annotations

import logging
import re
import xml.etree.ElementTree as ET

from .adb import Adb

log = logging.getLogger(__name__)

_BOUNDS_RE = re.compile(r"\[(?P<x1>\d+),(?P<y1>\d+)\]\[(?P<x2>\d+),(?P<y2>\d+)\]")


async def dump_ui_elements(adb: Adb, serial: str) -> list[dict]:
    """Runs uiautomator dump over ADB and returns parsed text/clickable element bounds."""
    try:
        # 1. Dump UI hierarchy XML on device
        dump_out = await adb.shell("uiautomator dump /sdcard/opendex_dump.xml", serial=serial, timeout_s=4.0)
        if "dumped to" not in dump_out and "UI hierarchy" not in dump_out:
            log.debug("uiautomator dump output unexpected: %s", dump_out)

        # 2. Read dumped XML
        xml_text = await adb.shell("cat /sdcard/opendex_dump.xml", serial=serial, timeout_s=3.0)
        if not xml_text or not xml_text.strip().startswith("<?xml"):
            return []

        # 3. Parse XML nodes
        root = ET.fromstring(xml_text)
        nodes: list[dict] = []

        for elem in root.iter("node"):
            text = elem.attrib.get("text", "").strip()
            content_desc = elem.attrib.get("content-desc", "").strip()
            bounds_str = elem.attrib.get("bounds", "")
            resource_id = elem.attrib.get("resource-id", "")
            clickable = elem.attrib.get("clickable", "false") == "true"
            password = elem.attrib.get("password", "false") == "true"

            if password:
                continue  # Security: never expose password fields

            display_text = text or content_desc
            if not display_text and not clickable:
                continue

            m = _BOUNDS_RE.match(bounds_str)
            if not m:
                continue

            x1, y1 = int(m.group("x1")), int(m.group("y1"))
            x2, y2 = int(m.group("x2")), int(m.group("y2"))
            w, h = x2 - x1, y2 - y1

            if w <= 0 or h <= 0:
                continue

            nodes.append({
                "id": resource_id,
                "text": display_text,
                "x": x1,
                "y": y1,
                "w": w,
                "h": h,
                "clickable": clickable,
            })

        return nodes
    except Exception as exc:
        log.debug("xml dump failed: %s", exc)
        return []
