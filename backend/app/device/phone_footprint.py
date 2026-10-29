"""OpenDeX'in telefonda değiştirdiği GENEL ayarlar ("telefon izleri") — tek liste, canlı okuma ve kullanıcının seçimi.

Neden: OpenDeX'in bir kısmı telefonun kendisine dokunur — HyperOS pencere başlığı, uyanık tutma, geçiş animasyonu, Geliştirici
seçeneklerindeki çoklu pencere anahtarları. Bunların bir kısmı kira (pencereler açıkken tutulur, sonra kullanıcının KENDİ değeri
geri yazılır), bir kısmı kalıcıdır (bağlanınca yazılır, eskiden hiç geri alınmazdı). Kullanıcı "telefonum bozuldu" dememeli: her
iz burada görünür ve tek tek ya da topluca telefonun kendi varsayılanına bırakılabilir.

Her izin iki seçeneği vardır (ProjectSettings.phone_footprint; iki iz kendi eski ayarını kullanır):
  "auto"   — OpenDeX yönetsin (varsayılan; bugünkü davranış),
  "system" — OpenDeX bu ayara HİÇ dokunmasın; kalıcı bir iz ise OpenDeX'in yazdığı değer hemen silinir ve telefon kendi
             varsayılanına döner (yalnız değer hâlâ OpenDeX'inkiyse: kullanıcının kendi koyduğu değer silinmez).

Okuma tek kabuk çağrısıdır (`settings list` ad alanı başına bir süreç; anahtar başına `settings get` sürecin kendisini başlatırdı)
ve yalnız istendiğinde yapılır (panel açılınca, "Yenile", bir değişiklikten sonra): yoklama döngüsü yoktur.
"""
from __future__ import annotations

import logging
import re
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable, Literal

from app.device import android_shell
from app.device.usb_stability import parse_usb_state
from app.windows.transition_gate import MARKER as TRANSITION_MARKER

log = logging.getLogger(__name__)

Policy = Literal["auto", "system"]
POLICIES: tuple[str, ...] = ("auto", "system")


@dataclass(frozen=True)
class Knob:
    """Telefondaki tek bir ayar: `settings <namespace> <key>`; `ours` OpenDeX'in yazdığı, `default` Android'in kendi değeri
    (anahtar yokken telefonun davrandığı değer; bilinmiyorsa None)."""
    namespace: Literal["global", "secure"]
    key: str
    ours: str
    default: str | None = None

    @property
    def ref(self) -> str:
        return f"{self.namespace}/{self.key}"


@dataclass(frozen=True)
class FootprintItem:
    id: str
    # lease: pencereler açıkken tutulur, sonra kullanıcının değeri geri yazılır · moment: yalnız bir boyutlandırmanın etrafında ·
    # persistent: bağlanınca yazılır, kendiliğinden geri alınmaz · guard / policy: kendi eski ayarıyla yönetilen izler.
    kind: Literal["lease", "moment", "persistent", "guard", "policy"]
    knobs: tuple[Knob, ...] = ()
    backup: Knob | None = None          # kiranın kullanıcının özgün değerini sakladığı anahtar
    xiaomi_only: bool = False
    advised_for: str | None = None      # "workspace": kapatılırsa Workspace'te bazı uygulamalar pencere olamayabilir
    runtime_apply: str = ""             # ayar olmayan (yeniden başlatmada sıfırlanan) eşlik komutu
    runtime_restore: str = ""
    setting: str | None = None          # guard / policy: kendi ProjectSettings alanı
    # Telefondaki değer elle açılıp kapatılabilir mi (PUT /device/footprint/{id}). Hayır: değeri zaten Android'in varsayılanıyla
    # aynı olanlar (display_defaults) ve değiştirmek bağlantıyı koparan USB işlevi.
    toggle: bool = True


ITEMS: tuple[FootprintItem, ...] = (
    FootprintItem(
        "caption", "lease",
        knobs=(Knob("secure", "disable_decoration_dot", "1", "0"),),
        backup=Knob("secure", "opendex_decoration_dot_original", ""),
        xiaomi_only=True,
    ),
    FootprintItem(
        "stay_awake", "lease",
        knobs=(Knob("global", "stay_on_while_plugged_in", "7", "0"),),
        backup=Knob("global", "opendex_stay_on_original", ""),
    ),
    FootprintItem(
        "transition_animation", "moment",
        knobs=(Knob("global", "transition_animation_scale", "0", "1.0"),),
    ),
    FootprintItem(
        "freeform_support", "persistent",
        knobs=(Knob("global", "enable_freeform_support", "1", "0"),),
        advised_for="workspace",
    ),
    FootprintItem(
        "resizable_apps", "persistent",
        # `secure` ad alanındaki kopya Workspace açılışının eski bir yazımıdır (Android onu okumaz); silinirken o da gider.
        knobs=(Knob("global", "force_resizable_activities", "1", "0"), Knob("secure", "force_resizable_activities", "1")),
        advised_for="workspace",
    ),
    FootprintItem(
        "non_resizable_multi_window", "persistent",
        knobs=(Knob("global", "enable_non_resizable_multi_window", "1"),),
        advised_for="workspace",
        runtime_apply="wm set-multi-window-config --supportsNonResizable 1 --respectsActivityMinWidthHeight -1",
        runtime_restore="wm reset-multi-window-config",
    ),
    FootprintItem(
        "display_defaults", "persistent",
        # İkisi de Android'in varsayılanıyla aynı davranır: bağlanınca eski oturumlardan kalmış bir değeri temizler.
        knobs=(
            Knob("global", "force_desktop_mode_on_external_displays", "0", "0"),
            Knob("global", "overlay_display_devices", "none", "none"),
        ),
        runtime_apply="cmd window set-ignore-orientation-request false",
        toggle=False,
    ),
    FootprintItem("usb_guard", "guard", setting="usb_stability_guard", toggle=False),
    FootprintItem("multi_audio_focus", "policy", setting="multi_audio_focus_policy"),
)
ITEMS_BY_ID: dict[str, FootprintItem] = {item.id: item for item in ITEMS}
# ProjectSettings.phone_footprint'in taşıdığı izler (guard / policy kendi alanlarını kullanır).
OWN_POLICY_IDS: tuple[str, ...] = tuple(item.id for item in ITEMS if item.kind not in ("guard", "policy"))

_SEPARATOR = "@@opendex@@"
_USB_PROBE = "dumpsys usb | grep -E '^ *(current_functions|screen_unlocked_functions|connected)='"


def normalize_policy(raw: dict[str, Any] | None) -> dict[str, str]:
    """Kayıtlı sözlük → her iz için geçerli bir seçim (bilinmeyen anahtar atılır, eksik/bozuk değer "auto")."""
    raw = raw or {}
    return {item_id: (raw.get(item_id) if raw.get(item_id) in POLICIES else "auto") for item_id in OWN_POLICY_IDS}


def _write(knob: Knob) -> str:
    return f"settings put {knob.namespace} {knob.key} {knob.ours}"


def _guarded_delete(knob: Knob) -> str:
    """Değer hâlâ OpenDeX'inkiyse sil: kullanıcının (ya da telefonun) kendi koyduğu değere dokunulmaz."""
    return f'[ "$(settings get {knob.namespace} {knob.key})" = "{knob.ours}" ] && settings delete {knob.namespace} {knob.key}'


def apply_commands(item: FootprintItem) -> list[str]:
    commands = [_write(knob) for knob in item.knobs]
    if item.runtime_apply:
        commands.append(item.runtime_apply)
    return commands


def restore_commands(item: FootprintItem) -> list[str]:
    commands = [_guarded_delete(knob) for knob in item.knobs]
    if item.runtime_restore:
        commands.append(item.runtime_restore)
    return commands


def off_commands(item: FootprintItem) -> list[str]:
    """Telefondaki değeri ŞİMDİ kapat (kullanıcı istedi: OpenDeX'in bir hatası değeri açık bırakmış olabilir). Kira: sakladığı
    özgün değer varsa o geri yazılır ve yedek silinir, yoksa anahtar silinir (Android varsayılanı). Geçiş animasyonu: kapının
    işaret dosyasındaki değer, yoksa ve hâlâ 0'daysa Android varsayılanı. Kalıcı iz: anahtar silinir."""
    commands: list[str] = []
    if item.id == "transition_animation":
        knob = item.knobs[0]
        commands.append(
            f"f={TRANSITION_MARKER}; if [ -f $f ]; then v=$(cat $f); "
            f'if [ "$v" = null ] || [ -z "$v" ]; then settings delete {knob.namespace} {knob.key}; '
            f'else settings put {knob.namespace} {knob.key} "$v"; fi; rm -f $f; '
            f'elif [ "$(settings get {knob.namespace} {knob.key})" = "{knob.ours}" ]; then settings put {knob.namespace} {knob.key} {knob.default}; fi'
        )
        return commands
    for knob in item.knobs:
        delete = f"settings delete {knob.namespace} {knob.key}"
        if item.backup is None:
            commands.append(delete)
            continue
        b = item.backup
        commands.append(
            f'o=$(settings get {b.namespace} {b.key}); if [ "$o" != null ]; then '
            f'if [ "$o" = unset ]; then {delete}; else settings put {knob.namespace} {knob.key} "$o"; fi; '
            f"settings delete {b.namespace} {b.key}; else {delete}; fi"
        )
    if item.runtime_restore:
        commands.append(item.runtime_restore)
    return commands


def script(commands: list[str]) -> str:
    """`;` ile tek kabuk çağrısı: her komut ötekinin hatasından bağımsız; sondaki `true` korumalı silmelerin `&&`'ını yutar."""
    return "; ".join([*commands, "true"]) if commands else ""


def bind_script(policy: dict[str, str], item_ids: tuple[str, ...]) -> str:
    """Bağlanırken (ya da Workspace açılırken) çalışan tek komut: "auto" izler yazılır, "system" izlerde OpenDeX'in eski bir
    oturumdan kalmış değeri temizlenir."""
    commands: list[str] = []
    for item_id in item_ids:
        item = ITEMS_BY_ID[item_id]
        commands.extend(apply_commands(item) if policy.get(item_id, "auto") == "auto" else restore_commands(item))
    return script(commands)


BIND_ITEMS: tuple[str, ...] = ("freeform_support", "resizable_apps", "display_defaults")
WORKSPACE_ITEMS: tuple[str, ...] = ("resizable_apps", "non_resizable_multi_window")


def read_script() -> str:
    keys = {ns: sorted({k.key for item in ITEMS for k in (*item.knobs, *((item.backup,) if item.backup else ())) if k.namespace == ns})
            for ns in ("global", "secure")}
    parts = [f"settings list {ns} | grep -E '^({'|'.join(re.escape(k) for k in keys[ns])})='" for ns in ("global", "secure")]
    return f"; echo {_SEPARATOR}; ".join([*parts, _USB_PROBE]) + "; true"


def parse_read(output: str) -> tuple[dict[str, str], str]:
    """`settings list` çıktıları → {"global/key": değer}; ayrıca `dumpsys usb` satırları."""
    sections = (output or "").split(_SEPARATOR)
    values: dict[str, str] = {}
    for ns, text in zip(("global", "secure"), sections[:2]):
        for line in text.splitlines():
            key, sep, value = line.strip().partition("=")
            if sep and key:
                values[f"{ns}/{key}"] = value.strip()
    usb = sections[2] if len(sections) > 2 else ""
    return values, usb


def knob_state(item: FootprintItem, values: dict[str, str]) -> str:
    """held / ours (OpenDeX'in değeri duruyor) · default (telefonun kendi varsayılanı) · custom (başka bir değer)."""
    def is_default(knob: Knob, value: str | None) -> bool:
        return value in (None, "", "null") or (knob.default is not None and value == knob.default)

    pairs = [(knob, values.get(knob.ref)) for knob in item.knobs]
    if all(is_default(knob, value) for knob, value in pairs):
        return "default"
    if all(value == knob.ours or is_default(knob, value) for knob, value in pairs):
        return "held" if item.kind in ("lease", "moment") else "ours"
    return "custom"


@dataclass
class _Context:
    serial: str | None = None
    xiaomi: bool | None = None
    values: dict[str, str] = field(default_factory=dict)
    usb: str = ""
    read_ok: bool = False


class PhoneFootprint:
    """Tek gerçek: hangi izi kim yönetiyor (bellekteki seçim, ProjectSettings'ten) ve telefon şu an ne diyor (istek üzerine)."""

    def __init__(
        self,
        adb: Any,
        serial_getter: Callable[[], str | None],
        settings_getter: Callable[[], Awaitable[Any]],
        *,
        on_lease_policy: Callable[[], None] | None = None,
        transition_release: Callable[[], Awaitable[None]] | None = None,
        multi_focus_snapshot: Callable[[], dict[str, Any]] | None = None,
        multi_focus_set: Callable[[bool], Awaitable[Any]] | None = None,
        is_xiaomi: Callable[[Any, str], Awaitable[bool]] = android_shell.is_miui_or_hyperos,
    ) -> None:
        self._adb = adb
        self._serial = serial_getter
        self._settings = settings_getter
        self._on_lease_policy = on_lease_policy
        self._transition_release = transition_release
        self._multi_focus_snapshot = multi_focus_snapshot
        self._multi_focus_set = multi_focus_set
        self._is_xiaomi = is_xiaomi
        self._policy: dict[str, str] = normalize_policy(None)
        self._usb_guard = True
        self._multi_focus_policy = "ask"

    # ── seçim (senkron okunur: kira modülleri ve geçiş kapısı her an sorar) ─────────────────────────────────────────

    def allows(self, item_id: str) -> bool:
        """OpenDeX bu izi yönetebilir mi? (bilinmeyen kimlik: evet — eski davranış)"""
        return self._policy.get(item_id, "auto") == "auto"

    @property
    def policy(self) -> dict[str, str]:
        return dict(self._policy)

    def adopt(self, settings: Any) -> dict[str, str]:
        """ProjectSettings'ten belleğe alır; önceki seçimi döndürür."""
        previous = dict(self._policy)
        self._policy = normalize_policy(getattr(settings, "phone_footprint", None))
        self._usb_guard = bool(getattr(settings, "usb_stability_guard", True))
        self._multi_focus_policy = str(getattr(settings, "multi_audio_focus_policy", "ask"))
        return previous

    async def refresh_policy(self) -> None:
        try:
            self.adopt(await self._settings())
        except Exception as exc:  # noqa: BLE001 — okunamadıysa eldeki seçim kalır
            log.debug("[PhoneFootprint] ayarlar okunamadı: %s", exc)

    def bind_script(self) -> str:
        return bind_script(self._policy, BIND_ITEMS)

    def workspace_script(self) -> str:
        return bind_script(self._policy, WORKSPACE_ITEMS)

    # ── seçim değişti ────────────────────────────────────────────────────────────────────────────────────────────

    async def on_settings_saved(self, settings: Any) -> list[str]:
        """PUT /settings sonrası: değişen izler hemen uygulanır. Değişen kimlikleri döndürür."""
        previous = self.adopt(settings)
        changed = [item_id for item_id in OWN_POLICY_IDS if previous.get(item_id) != self._policy[item_id]]
        if not changed:
            return []
        serial = self._serial()
        commands: list[str] = []
        for item_id in changed:
            item = ITEMS_BY_ID[item_id]
            if item.kind == "persistent":
                commands.extend(apply_commands(item) if self.allows(item_id) else restore_commands(item))
        if commands and serial:
            try:
                await self._adb.shell(script(commands), serial=serial, timeout_s=6.0)
            except Exception as exc:  # noqa: BLE001 — bir sonraki bağlanmada bind_script yeniden dener
                log.warning("[PhoneFootprint] telefona uygulanamadı (%s): %s", ", ".join(changed), exc)
        if any(ITEMS_BY_ID[item_id].kind == "lease" for item_id in changed) and self._on_lease_policy is not None:
            self._on_lease_policy()
        if "transition_animation" in changed and not self.allows("transition_animation") and self._transition_release is not None:
            try:
                await self._transition_release()
            except Exception as exc:  # noqa: BLE001
                log.debug("[PhoneFootprint] geçiş kapısı açılamadı: %s", exc)
        log.info("📱 [PhoneFootprint] seçim değişti: %s", ", ".join(f"{i}={self._policy[i]}" for i in changed))
        return changed

    # ── telefondaki değeri elle aç / kapat ───────────────────────────────────────────────────────────────────────

    async def set_live(self, item_id: str, on: bool) -> dict[str, Any]:
        """Telefondaki değeri ŞİMDİ açar (OpenDeX'in değeri) ya da kapatır (kullanıcının / telefonun değeri), seçimden
        bağımsız: "auto" bir iz bir sonraki bağlanmada / pencerede yeniden uygulanır, "system" bir ize OpenDeX bir daha
        dokunmaz. KeyError: bilinmeyen iz · ValueError: elle değiştirilemez · LookupError: telefon yok."""
        item = ITEMS_BY_ID[item_id]
        if not item.toggle:
            raise ValueError("not_toggleable")
        serial = self._serial()
        if not serial:
            raise LookupError("no_device")
        if item.kind == "policy":
            if self._multi_focus_set is None:
                raise ValueError("not_toggleable")
            await self._multi_focus_set(on)
        else:
            commands = apply_commands(item) if on else off_commands(item)
            await self._adb.shell(script(commands), serial=serial, timeout_s=6.0)
        log.info("📱 [PhoneFootprint] %s telefonda elle %s", item_id, "açıldı" if on else "kapatıldı")
        return await self.snapshot()

    # ── canlı okuma ──────────────────────────────────────────────────────────────────────────────────────────────

    async def snapshot(self, *, read: bool = True) -> dict[str, Any]:
        ctx = _Context(serial=self._serial())
        if ctx.serial and read:
            try:
                ctx.xiaomi = await self._is_xiaomi(self._adb, ctx.serial)
            except Exception:  # noqa: BLE001
                ctx.xiaomi = None
            try:
                ctx.values, ctx.usb = parse_read(await self._adb.shell(read_script(), serial=ctx.serial, timeout_s=6.0))
                ctx.read_ok = True
            except Exception as exc:  # noqa: BLE001 — okunamayan durum "bilinmiyor" gösterilir, tahmin edilmez
                log.info("[PhoneFootprint] telefon okunamadı: %s", exc)
        items = [self._item_view(item, ctx) for item in ITEMS]
        return {
            "connected": bool(ctx.serial),
            "read": ctx.read_ok,
            "items": items,
            "managed": sum(1 for view in items if view["policy"] == "auto" and view["applicable"]),
            "active": sum(1 for view in items if view["state"] in ("held", "ours", "leftover") and view["applicable"]),
        }

    def _item_view(self, item: FootprintItem, ctx: _Context) -> dict[str, Any]:
        applicable = not (item.xiaomi_only and ctx.xiaomi is False)
        view: dict[str, Any] = {
            "id": item.id,
            "kind": item.kind,
            "policy": self._policy_of(item),
            "applicable": applicable,
            "advised_for": item.advised_for,
            "values": [
                {"ref": knob.ref, "value": ctx.values.get(knob.ref) if ctx.read_ok else None, "ours": knob.ours, "default": knob.default}
                for knob in item.knobs
            ],
            "original": None,
            "state": "unknown",
            "toggleable": False,
        }
        if not applicable:
            view["state"] = "unsupported"
            return view
        if item.kind == "policy":
            view["state"] = self._multi_focus_state()
            snap = self._multi_focus_snapshot() if self._multi_focus_snapshot is not None else {}
            view["toggleable"] = bool(ctx.serial and self._multi_focus_set and (snap or {}).get("can_set"))
            return view
        view["toggleable"] = bool(item.toggle and ctx.read_ok)
        if not ctx.read_ok:
            return view
        if item.kind == "guard":
            usb = parse_usb_state(ctx.usb)
            view["values"] = [
                {"ref": "usb/current_functions", "value": usb.current_functions or "none", "ours": "none", "default": "none"},
                {"ref": "usb/screen_unlocked_functions", "value": usb.screen_unlocked_functions or "none", "ours": "none", "default": "none"},
            ]
            view["state"] = "default" if not (usb.current_functions or usb.screen_unlocked_functions) else "custom"
            return view
        view["state"] = knob_state(item, ctx.values)
        if item.backup is not None:
            original = ctx.values.get(item.backup.ref)
            view["original"] = None if original in (None, "", "null") else original
            # A lease that holds the value ALWAYS keeps the user's original first (device/phone_awake.py, freeform_caption.py):
            # OpenDeX's value without that backup was left behind by an earlier session (a crash, or the pre-lease bind write).
            if view["state"] == "held" and view["original"] is None:
                view["state"] = "leftover"
        return view

    def _policy_of(self, item: FootprintItem) -> str:
        if item.kind == "guard":
            return "auto" if self._usb_guard else "system"
        if item.kind == "policy":
            return "system" if self._multi_focus_policy == "never" else "auto"
        return self._policy[item.id]

    def _multi_focus_state(self) -> str:
        snap = self._multi_focus_snapshot() if self._multi_focus_snapshot is not None else {}
        state = (snap or {}).get("state", "unknown")
        if state == "on":
            return "held" if snap.get("owner") == "opendex" else "custom"
        if state == "off":
            return "default"
        return state if state in ("unsupported", "unknown") else "unknown"
