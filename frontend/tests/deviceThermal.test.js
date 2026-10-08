import { describe, expect, it } from 'vitest';
import { THERMAL_LABEL, batteryTemperatureC, formatTemperature, thermalTone } from '../src/state/deviceThermal.js';

describe('batteryTemperatureC', () => {
  it('daemon\'un temperature_c alanını (°C) okur', () => {
    expect(batteryTemperatureC({ temperature_c: 36.5 })).toBe(36.5);
  });

  it('daemon/REST okuyamadığında yolladığı 0.0 "bilinmiyor"dur — sıcaklık uydurulmaz', () => {
    expect(batteryTemperatureC({ temperature_c: 0 })).toBeNull();
    expect(batteryTemperatureC({ temperature_c: 0.0, level: 80 })).toBeNull();
  });

  it('eski `temperature` alanı onda bir °C olarak okunur; temperature_c önceliklidir', () => {
    expect(batteryTemperatureC({ temperature: 372 })).toBeCloseTo(37.2, 5);
    expect(batteryTemperatureC({ temperature_c: 30.1, temperature: 372 })).toBe(30.1);
    expect(batteryTemperatureC({ temperature_c: 0, temperature: 372 })).toBeCloseTo(37.2, 5);
  });

  it('veri yok / sayı değil / negatif → null', () => {
    expect(batteryTemperatureC(null)).toBeNull();
    expect(batteryTemperatureC(undefined)).toBeNull();
    expect(batteryTemperatureC({})).toBeNull();
    expect(batteryTemperatureC({ temperature_c: 'sıcak' })).toBeNull();
    expect(batteryTemperatureC({ temperature_c: NaN })).toBeNull();
    expect(batteryTemperatureC({ temperature_c: -5 })).toBeNull();
  });

  it('sayı olarak gelen metni de kabul eder', () => {
    expect(batteryTemperatureC({ temperature_c: '41.2' })).toBe(41.2);
  });
});

describe('formatTemperature', () => {
  it('bir ondalıkla °C, bilinmiyorsa "—"', () => {
    expect(formatTemperature(36.54)).toBe('36.5 °C');
    expect(formatTemperature(40)).toBe('40.0 °C');
    expect(formatTemperature(null)).toBe('—');
    expect(formatTemperature(undefined)).toBe('—');
    expect(formatTemperature(NaN)).toBe('—');
  });
});

describe('thermalTone / THERMAL_LABEL', () => {
  it('normalde renk yok, ısındıkça uyarı → tehlike', () => {
    expect(thermalTone('none')).toBeNull();
    expect(thermalTone(undefined)).toBeNull();
    expect(thermalTone('light')).toBe('text-warning');
    expect(thermalTone('moderate')).toBe('text-warning');
    expect(thermalTone('severe')).toBe('text-destructive');
    expect(thermalTone('critical')).toBe('text-destructive');
  });

  it('backend\'in ThermalLevel değerlerinin hepsinin Türkçe karşılığı var', () => {
    for (const level of ['none', 'light', 'moderate', 'severe', 'critical']) {
      expect(THERMAL_LABEL[level]).toBeTruthy();
    }
  });
});
