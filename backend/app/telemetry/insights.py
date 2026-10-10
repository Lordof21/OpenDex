"""Plain-language findings from a window of load samples — the panel's "Neden ısınıyor?". Pure: no I/O, no clock.

Every rule states its evidence (the number that triggered it) so a finding can be checked against the charts.
Thresholds come from the phone the feature was built on (2026-09-30: 42 °C usual maximum, 45.7 °C during a test
session with 16 YouTube restarts in 6 minutes while charging over USB).
"""
from __future__ import annotations

from typing import Any

TEMP_WARN_C = 42.0
TEMP_CRITICAL_C = 45.0
SLOPE_WARN_C_PER_MIN = 0.25
RESTART_WINDOW_S = 600.0
RESTART_WARN_COUNT = 3
HEAVY_POLL_WARN_PER_MIN = 20.0
HEAVY_POLL_INFO_PER_MIN = 8.0
ENCODE_WARN_MPX_S = 1920 * 1080 * 60 / 1e6   # one 1080p60 stream
ENCODE_INFO_MPX_S = ENCODE_WARN_MPX_S / 2
CPU_WARN_PCT = 60.0

_SEVERITY_ORDER = {"critical": 0, "warning": 1, "info": 2, "good": 3}


def body_temp(sample: dict[str, Any]) -> float | None:
    """What the user feels: battery (always present) or the hottest skin/board sensor."""
    temps = sample.get("temp") or {}
    values = [v for v in (temps.get("battery"), temps.get("skin")) if isinstance(v, (int, float))]
    return max(values) if values else None


def slope_per_min(points: list[tuple[float, float]]) -> float | None:
    """Least-squares slope in units per minute; None without ≥3 points over ≥60 s."""
    if len(points) < 3 or points[-1][0] - points[0][0] < 60:
        return None
    n = len(points)
    mt = sum(t for t, _ in points) / n
    mv = sum(v for _, v in points) / n
    den = sum((t - mt) ** 2 for t, _ in points)
    if den <= 0:
        return None
    return sum((t - mt) * (v - mv) for t, v in points) / den * 60.0


def _fmt(v: float, digits: int = 1) -> str:
    return f"{v:.{digits}f}".replace(".", ",")


def compute(
    samples: list[dict[str, Any]],
    markers: list[dict[str, Any]],
    adb_rows: list[dict[str, Any]],
    now: float,
) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    if not samples:
        return out
    latest = samples[-1]

    # 1. Temperature: level and speed over the last 5 minutes.
    temp = body_temp(latest)
    recent = [(s["t"], body_temp(s)) for s in samples if s["t"] >= now - 300]
    slope = slope_per_min([(t, v) for t, v in recent if v is not None])
    if temp is not None:
        change = f"son 5 dk'da {'+' if slope >= 0 else ''}{_fmt(slope * 5)} °C ({_fmt(slope, 2)} °C/dk)" if slope is not None else ""
        trend = f" · {change}" if change else ""
        if temp >= TEMP_CRITICAL_C:
            out.append({"id": "temp", "severity": "critical", "title": f"Telefon çok sıcak: {_fmt(temp)} °C",
                        "detail": f"Olağan üst sınır ~{_fmt(TEMP_WARN_C, 0)} °C{trend}."})
        elif temp >= TEMP_WARN_C:
            out.append({"id": "temp", "severity": "warning", "title": f"Telefon ısındı: {_fmt(temp)} °C",
                        "detail": f"Olağan üst sınıra ulaştı{trend}."})
        elif slope is not None and slope >= SLOPE_WARN_C_PER_MIN:
            out.append({"id": "temp", "severity": "warning", "title": f"Hızla ısınıyor: {_fmt(slope, 2)} °C/dk",
                        "detail": f"Şu an {_fmt(temp)} °C{trend}."})
        else:
            out.append({"id": "temp", "severity": "good", "title": f"Sıcaklık normal: {_fmt(temp)} °C",
                        "detail": f"S{change[1:]}." if change else "Isınma eğilimi yok."})

    # 2. Charging while the battery still drains = load above what USB supplies; charging adds heat of its own.
    battery = latest.get("battery") or {}
    power = battery.get("power_w")
    # Without a current reading (vendors that deny it to shell), the level trend while charging tells the same story.
    charging_window = [s for s in samples if s["t"] >= now - 600 and (s.get("battery") or {}).get("charging")]
    levels = [(s["t"], s["battery"].get("level")) for s in charging_window if isinstance(s["battery"].get("level"), (int, float))]
    level_drop = levels[0][1] - levels[-1][1] if len(levels) >= 2 and levels[-1][0] - levels[0][0] >= 300 else 0
    if battery.get("charging") and isinstance(power, (int, float)) and power < -0.3:
        out.append({"id": "charge_drain", "severity": "warning", "title": "Şarjdayken pil azalıyor",
                    "detail": f"Telefon USB'nin verdiğinden ~{_fmt(-power)} W fazla harcıyor; şarj devresi de ayrıca ısı üretir."})
    elif battery.get("charging") and level_drop >= 1:
        minutes = (levels[-1][0] - levels[0][0]) / 60
        out.append({"id": "charge_drain", "severity": "warning", "title": "Şarjdayken pil azalıyor",
                    "detail": f"Şarj takılıyken pil son {_fmt(minutes, 0)} dk'da %{_fmt(level_drop, 0)} düştü: telefon "
                              "USB'nin verdiğinden fazla harcıyor; şarj devresi de ayrıca ısı üretir."})
    elif battery.get("charging") and temp is not None and temp >= TEMP_WARN_C - 2:
        out.append({"id": "charge_heat", "severity": "info", "title": "Şarj ısıya katkı yapıyor",
                    "detail": "Sıcakken şarj etmek telefonun kendini yavaşlatmasına yol açabilir."})

    # 3. Restart storms — each restart is a cold start of the app.
    restarts: dict[str, int] = {}
    for m in markers:
        if m.get("kind") == "app_restart" and m.get("t", 0) >= now - RESTART_WINDOW_S:
            restarts[m.get("package") or "?"] = restarts.get(m.get("package") or "?", 0) + 1
    for pkg, count in sorted(restarts.items(), key=lambda kv: -kv[1]):
        if count >= RESTART_WARN_COUNT:
            out.append({"id": f"restarts:{pkg}", "severity": "warning",
                        "title": f"{pkg} son 10 dk'da {count} kez yeniden başlatıldı",
                        "detail": "Her DPI değişimi uygulamanın yeniden açılması demek (soğuk açılış kadar işlemci yükü). "
                                  "Pencere boyutu/DP'yi ardı ardına değiştirmek telefonu ısıtır."})

    # 4. Background polling OpenDeX itself runs.
    heavy = [r for r in adb_rows if r.get("heavy")]
    heavy_rate = sum(r["per_min"] for r in heavy)
    if heavy_rate >= HEAVY_POLL_INFO_PER_MIN:
        top = max(heavy, key=lambda r: r["per_min"])
        out.append({"id": "polling", "severity": "warning" if heavy_rate >= HEAVY_POLL_WARN_PER_MIN else "info",
                    "title": f"Arka plan yoklaması: dakikada {_fmt(heavy_rate, 0)} ağır komut",
                    "detail": f"En büyük kaynak: {top['label']} — dakikada {_fmt(top['per_min'], 0)}. "
                              "Her biri telefonun sistem sürecini uyandırır."})

    # 5. Video encoding: pixels per second across every live stream.
    streams = [s for s in latest.get("streams") or [] if not s.get("paused")]
    mpx = sum((s.get("w") or 0) * (s.get("h") or 0) * (s.get("fps") or 0) for s in streams) / 1e6
    if mpx >= ENCODE_INFO_MPX_S:
        mbps = sum(s.get("mbps") or 0 for s in streams)
        out.append({"id": "encode", "severity": "warning" if mpx >= ENCODE_WARN_MPX_S else "info",
                    "title": f"Görüntü kodlama: saniyede {_fmt(mpx, 0)} megapiksel",
                    "detail": f"{len(streams)} akış, toplam {_fmt(mbps)} Mbps. Kare hızını ya da çözünürlüğü düşürmek "
                              "kodlayıcının ısısını doğrudan azaltır."})

    # 6. CPU: sustained total, with who is using it.
    last_min = [s for s in samples if s["t"] >= now - 60 and (s.get("cpu") or {}).get("total") is not None]
    if last_min:
        avg_total = sum(s["cpu"]["total"] for s in last_min) / len(last_min)
        groups: dict[str, float] = {}
        for s in last_min:
            for g, v in (s["cpu"].get("groups") or {}).items():
                groups[g] = groups.get(g, 0.0) + v / len(last_min)
        opendex = groups.get("opendex", 0.0)
        if avg_total >= CPU_WARN_PCT:
            out.append({"id": "cpu", "severity": "warning", "title": f"İşlemci yükü yüksek: %{_fmt(avg_total, 0)}",
                        "detail": f"Son 1 dk ortalaması. OpenDeX süreçlerinin payı %{_fmt(opendex, 0)}."})
        elif opendex >= 10.0:
            out.append({"id": "cpu_opendex", "severity": "info", "title": f"OpenDeX işlemcinin %{_fmt(opendex, 0)}'ini kullanıyor",
                        "detail": "Görüntü sunucusu + yardımcı süreçler, son 1 dk ortalaması."})

    out.sort(key=lambda f: _SEVERITY_ORDER.get(f["severity"], 9))
    return out
