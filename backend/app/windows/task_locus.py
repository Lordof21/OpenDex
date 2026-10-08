"""Görev konumu (locus) — bir Android task'ının ŞU AN hangi ekranda yaşadığı.

Üç konum, altı geçiş kenarı:

    desktop   = bağımsız pencere (kendi VirtualDisplay + kendi encoder'ı)
    workspace = Eco Workspace üyesi (paylaşımlı VD + paylaşımlı encoder)
    phone     = telefonun kendi ekranı (Display 0)

Konum ayrı bir alan olarak SAKLANMAZ — mevcut iki bayraktan türetilir; böylece
"iki alan birbiriyle çelişiyor" sınıfı hata (örn. workspace_id="eco" iken
handoff_to_phone=True kalması — zombi hal) yapısal olarak
temsil edilemez hale gelir: çakışma durumunda `handoff_to_phone` kazanır,
çünkü task'ın fiziksel olarak nerede olduğunu o söyler.

`workspace_id == "eco"` iken `handoff_to_phone == True` geçerli bir durumdur ve
"telefona park edilmiş Workspace üyesi" anlamına gelir: Workspace'teki yeri
(bounds, yoğunluk tercihi) korunur, ama Android task'ı Display 0'dadır.
"""
from __future__ import annotations

from typing import Literal

TaskLocus = Literal["desktop", "workspace", "phone"]


def locus_of(workspace_id: str | None, handoff_to_phone: bool) -> TaskLocus:
    if handoff_to_phone:
        return "phone"
    if workspace_id == "eco":
        return "workspace"
    return "desktop"


def home_locus_of(workspace_id: str | None) -> Literal["desktop", "workspace"]:
    """`reclaim` (telefondan geri alma) task'ı NEREYE döndürür: doğduğu yere."""
    return "workspace" if workspace_id == "eco" else "desktop"
