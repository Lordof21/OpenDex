// Telefonun sıcaklığı: tek okuma/biçim kaynağı. Taskbar'daki Cihaz Merkezi ve Hızlı Ayarlar'ın pil sayfası aynı değeri
// aynı kuralla gösterir.
//
// Kaynak: `systemStore.batteryInfo` (daemon'un `battery_update` bildirimi ya da GET /api/device/battery) ve
// `systemStore.thermalLevel` (backend'in `thermal_throttle` olayı = Android'in ısıl durumu).
//
// Ölçülemeyen değer UYDURULMAZ: daemon ve REST ucu, `dumpsys battery` okunamadığında `temperature_c: 0.0` yollar —
// bir telefonun pili gerçekte 0 °C okumaz, bu yüzden 0 (ya da sayı olmayan) "bilinmiyor"dur ve arayüzde "—" olur.
// (Eskiden Hızlı Ayarlar bu durumda "32.4 °C" gösteriyordu.)

export const THERMAL_LABEL = {
  none: 'Normal',
  light: 'Hafif ısınma',
  moderate: 'Orta ısınma',
  severe: 'Yüksek ısınma',
  critical: 'Kritik ısınma',
};

/** Pil sıcaklığı (°C) — ölçülemiyorsa null. `temperature_c` yoksa eski `temperature` (onda bir °C) alanına bakar. */
export function batteryTemperatureC(info) {
  if (!info) return null;
  const celsius = Number(info.temperature_c);
  if (Number.isFinite(celsius) && celsius > 0) return celsius;
  const tenths = Number(info.temperature);
  if (Number.isFinite(tenths) && tenths > 0) return tenths / 10;
  return null;
}

/** "36.5 °C" — bilinmiyorsa "—". */
export function formatTemperature(celsius) {
  return celsius == null || !Number.isFinite(celsius) ? '—' : `${celsius.toFixed(1)} °C`;
}

/** Android ısıl durumuna göre renk sınıfı: normalde nötr (null), orta/hafif uyarı, yüksek/kritik tehlike. */
export function thermalTone(level) {
  if (level === 'severe' || level === 'critical') return 'text-destructive';
  if (level === 'moderate' || level === 'light') return 'text-warning';
  return null;
}
