// "İkisi" ince ayarı + durum satırı (taskbar/SyncFineTune.jsx) ve rota sözlüğü (ui/audioRouting.jsx).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

vi.mock('../src/lib/api.js', () => ({
  api: { get: vi.fn().mockResolvedValue(null), put: vi.fn().mockResolvedValue({}), post: vi.fn().mockResolvedValue({}) },
  wsUrl: (p) => `ws://test${p}`,
}));
vi.mock('../src/settings/settingsApi.js', () => ({
  getSettings: vi.fn().mockResolvedValue({ audio_sync_offset_ms: 0 }),
  saveSettings: vi.fn().mockResolvedValue({}),
  subscribeSettings: vi.fn(() => () => {}),
}));

vi.mock('../src/media/syncCalibration.js', async (importOriginal) => ({
  ...(await importOriginal()),
  runCalibration: vi.fn(),
}));

import SyncFineTune, { syncStatus } from '../src/taskbar/SyncFineTune.jsx';
import { runCalibration } from '../src/media/syncCalibration.js';
import { saveSettings } from '../src/settings/settingsApi.js';
import { ROUTE_OPTIONS, RouteSelector, routeOption } from '../src/ui/audioRouting.jsx';
import { resetLiveSettingsForTests } from '../src/settings/liveSettings.js';
import { useAudioMixerStore } from '../src/state/audioMixerStore.js';
import { useSystemStore } from '../src/state/systemStore.js';

beforeEach(() => {
  resetLiveSettingsForTests();
  useAudioMixerStore.getState().reset();
});
afterEach(cleanup);

const both = (over = {}) => ({ package: 'com.a', route: 'both', live_route: 'both', synced: true, target_ms: 160, ...over });

describe('syncStatus', () => {
  it('says what the alignment is doing', () => {
    expect(syncStatus({ supported: true }, {}).tone).toBe('idle');
    expect(syncStatus({ supported: true }, { a: both() })).toEqual({
      tone: 'ok', text: 'Telefon ve DeX aynı anda çalıyor (ortak gecikme ≈ 160 ms).',
    });
    expect(syncStatus({ supported: true }, { a: both({ synced: false, target_ms: null }) }).tone).toBe('warn');
  });

  it('an old phone helper is named as the reason, whatever the apps do', () => {
    const status = syncStatus({ supported: false }, { a: both() });
    expect(status.tone).toBe('warn');
    expect(status.text).toMatch(/build\.py/);
  });
});

describe('SyncFineTune', () => {
  it('shows the fine tune with its status line', () => {
    useAudioMixerStore.setState({ apps: { 'com.a': both() }, sync: { supported: true, offset_ms: 0 } });
    render(<SyncFineTune />);
    expect(screen.getByRole('slider', { name: 'Telefon–DeX ince ayarı' })).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('aynı anda çalıyor');
  });
});

describe('SyncFineTune: automatic calibration', () => {
  const click = () => fireEvent.click(screen.getByTestId('audio-sync-auto'));

  it('measures, writes the fine tune it found and says what it heard', async () => {
    useAudioMixerStore.setState({ apps: {}, sync: { supported: true, offset_ms: 0 } });
    runCalibration.mockImplementationOnce(async ({ onPhase }) => {
      onPhase('listen');
      return { ok: true, offsetMs: 14, previousMs: 0, gapMs: -14, spreadMs: 0.4, pairs: 6 };
    });
    render(<SyncFineTune />);
    click();
    await waitFor(() => expect(saveSettings).toHaveBeenCalledWith(expect.objectContaining({ audio_sync_offset_ms: 14 })));
    await waitFor(() => expect(screen.getByTestId('audio-sync-auto-status')).toHaveTextContent('Telefon DeX\'ten ≈ 14 ms önde duyuluyordu'));
    expect(screen.getByTestId('audio-sync-auto-status')).toHaveTextContent('+14 ms yapıldı');
    expect(screen.getByTestId('audio-sync-auto')).not.toBeDisabled();
  });

  it('is busy while it listens (no second run) and shows the phase', async () => {
    useAudioMixerStore.setState({ apps: {}, sync: { supported: true, offset_ms: 0 } });
    let finish;
    runCalibration.mockImplementationOnce(({ onPhase }) => new Promise((resolve) => { onPhase('listen'); finish = resolve; }));
    render(<SyncFineTune />);
    click();
    await waitFor(() => expect(screen.getByTestId('audio-sync-auto')).toBeDisabled());
    expect(screen.getByTestId('audio-sync-auto-status')).toHaveTextContent('Dinleniyor');
    await act(async () => { finish({ ok: false, reason: 'too_quiet' }); });
    await waitFor(() => expect(screen.getByTestId('audio-sync-auto')).not.toBeDisabled());
  });

  it('writes nothing when the measurement fails and says why', async () => {
    saveSettings.mockClear();
    useAudioMixerStore.setState({ apps: {}, sync: { supported: true, offset_ms: 0 } });
    runCalibration.mockResolvedValueOnce({ ok: false, reason: 'mic_denied' });
    render(<SyncFineTune />);
    click();
    await waitFor(() => expect(screen.getByTestId('audio-sync-auto-status')).toHaveTextContent('Mikrofon izni verilmedi'));
    expect(saveSettings).not.toHaveBeenCalled();
  });

  it('is off on a phone helper that cannot align (the status line already says so)', () => {
    useAudioMixerStore.setState({ apps: {}, sync: { supported: false } });
    render(<SyncFineTune />);
    expect(screen.getByTestId('audio-sync-auto')).toBeDisabled();
  });

  it('cancels immediately on click and informs via toast', async () => {
    useAudioMixerStore.setState({ apps: {}, sync: { supported: true, offset_ms: 0 } });
    useSystemStore.setState({ toasts: [] });
    let passedSignal;
    runCalibration.mockImplementationOnce(({ onPhase, signal }) => {
      passedSignal = signal;
      onPhase('listen');
      return new Promise(() => {}); // never finishes until aborted
    });
    render(<SyncFineTune />);
    click();
    await waitFor(() => expect(screen.getByTestId('audio-sync-auto-cancel')).toBeInTheDocument());
    expect(screen.getByTestId('audio-sync-auto')).toBeDisabled();
    expect(passedSignal.aborted).toBe(false);

    fireEvent.click(screen.getByTestId('audio-sync-auto-cancel'));

    // UI immediately returns to idle
    expect(screen.getByTestId('audio-sync-auto')).not.toBeDisabled();
    expect(screen.queryByTestId('audio-sync-auto-cancel')).toBeNull();
    expect(passedSignal.aborted).toBe(true);
    expect(screen.getByTestId('audio-sync-auto-status')).toHaveTextContent('iptal edildi');

    // Toast pushed
    const toasts = useSystemStore.getState().toasts;
    expect(toasts.some((t) => t.message.includes('iptal edildi'))).toBe(true);
  });

  it('pushes start and result toasts during calibration', async () => {
    useAudioMixerStore.setState({ apps: {}, sync: { supported: true, offset_ms: 0 } });
    useSystemStore.setState({ toasts: [] });
    runCalibration.mockResolvedValueOnce({ ok: true, offsetMs: 25, previousMs: 0, gapMs: -25, spreadMs: 0.5, pairs: 5 });
    render(<SyncFineTune />);
    click();
    await waitFor(() => expect(screen.getByTestId('audio-sync-auto')).not.toBeDisabled());
    const toasts = useSystemStore.getState().toasts;
    expect(toasts.some((t) => t.message.includes('Ses hizalandı'))).toBe(true);
  });
});

describe('route words', () => {
  it('are Telefon, DeX, İkisi everywhere — one list, in that order', () => {
    expect(ROUTE_OPTIONS.map((r) => [r.value, r.label])).toEqual([['phone', 'Telefon'], ['pc', 'DeX'], ['both', 'İkisi']]);
    expect(routeOption('pc').label).toBe('DeX');
    expect(routeOption('mystery').label).toBe('Telefon');     // unknown reads as where sound is by default
  });

  it('the selector offers exactly those and reports the wire value', () => {
    const onChange = vi.fn();
    render(<RouteSelector value="pc" onChange={onChange} label="Ses çıkışı" />);
    expect(screen.getAllByRole('radio').map((r) => r.textContent)).toEqual(['Telefon', 'DeX', 'İkisi']);
    fireEvent.click(screen.getByRole('radio', { name: 'İkisi' }));
    expect(onChange).toHaveBeenCalledWith('both');
  });
});
