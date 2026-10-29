// Telefon ayarları (DeX ayarları › Sistem): OpenDeX'in telefonda değiştirdikleri, her birinin canlı durumu ve
// "OpenDeX | Sistem" seçimi. Gerçek liste ve değerler backend'den (device/phone_footprint.py) gelir.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

vi.mock('../src/lib/api.js', () => ({
  BASE: 'http://localhost:8710',
  ApiError: class ApiError extends Error {},
  api: { get: vi.fn(), post: vi.fn(), put: vi.fn() },
  wsUrl: (p) => `ws://test${p}`,
}));
vi.mock('../src/settings/settingsApi.js', () => ({
  getSettings: vi.fn().mockResolvedValue({}),
  saveSettings: vi.fn(async (patch) => ({ ...patch })),
  subscribeSettings: vi.fn(() => () => {}),
}));

import { api } from '../src/lib/api.js';
import { saveSettings } from '../src/settings/settingsApi.js';
import { resetLiveSettingsForTests } from '../src/settings/liveSettings.js';
import { allPolicyPatch, policyPatch, usePhoneFootprintStore } from '../src/state/phoneFootprintStore.js';
import { PhoneFootprintSummary, PhoneFootprintView } from '../src/taskbar/PhoneFootprint.jsx';
import { PhoneSection } from '../src/settings/sections/phone.jsx';

const item = (id, over = {}) => ({
  id,
  kind: 'persistent',
  policy: 'auto',
  applicable: true,
  advised_for: null,
  values: [],
  original: null,
  state: 'default',
  toggleable: true,
  ...over,
});

const SNAP = {
  connected: true,
  read: true,
  managed: 3,
  active: 2,
  items: [
    item('caption', { kind: 'lease', state: 'held', original: '0', values: [{ ref: 'secure/disable_decoration_dot', value: '1', ours: '1', default: '0' }] }),
    item('stay_awake', { kind: 'lease', state: 'held' }),
    item('freeform_support', { state: 'ours', advised_for: 'workspace' }),
    item('usb_guard', { kind: 'guard', state: 'default', toggleable: false }),
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  resetLiveSettingsForTests();
  api.get.mockResolvedValue(SNAP);
  usePhoneFootprintStore.setState({ snap: SNAP, loaded: true, loading: false, saving: {}, toggling: {}, error: null });
});
afterEach(cleanup);

describe('seçim → ayar yaması', () => {
  it('kendi izleri phone_footprint sözlüğüne yazılır, ötekiler korunur', () => {
    expect(policyPatch('caption', 'system', { phone_footprint: { stay_awake: 'system' } })).toEqual({
      phone_footprint: { stay_awake: 'system', caption: 'system' },
    });
  });

  it('USB ve çoklu ses kendi eski ayarlarını kullanır', () => {
    expect(policyPatch('usb_guard', 'system', {})).toEqual({ usb_stability_guard: false });
    expect(policyPatch('usb_guard', 'auto', {})).toEqual({ usb_stability_guard: true });
    expect(policyPatch('multi_audio_focus', 'system', {})).toEqual({ multi_audio_focus_policy: 'never' });
    // OpenDeX'e geri verilince kullanıcının önceki "always" seçimi korunur; "never"dan dönüş "ask" olur.
    expect(policyPatch('multi_audio_focus', 'auto', { multi_audio_focus_policy: 'always' })).toEqual({ multi_audio_focus_policy: 'always' });
    expect(policyPatch('multi_audio_focus', 'auto', { multi_audio_focus_policy: 'never' })).toEqual({ multi_audio_focus_policy: 'ask' });
  });

  it('"tümü" tek yamada bütün izleri birlikte taşır', () => {
    const patch = allPolicyPatch([{ id: 'caption' }, { id: 'freeform_support' }, { id: 'usb_guard' }, { id: 'multi_audio_focus' }], 'system', {});
    expect(patch).toEqual({
      phone_footprint: { caption: 'system', freeform_support: 'system' },
      usb_stability_guard: false,
      multi_audio_focus_policy: 'never',
    });
  });
});

describe('özet kart', () => {
  it('sayıları gösterir ve yalnız görünürken telefonu okur', async () => {
    const onOpen = vi.fn();
    const { rerender } = render(<PhoneFootprintSummary visible={false} onOpen={onOpen} />);
    expect(api.get).not.toHaveBeenCalled();
    rerender(<PhoneFootprintSummary visible onOpen={onOpen} />);
    await waitFor(() => expect(api.get).toHaveBeenCalledWith('/api/device/footprint'));
    const card = screen.getByTestId('footprint-summary');
    expect(card.textContent).toContain('Telefon ayarları');
    fireEvent.click(card);
    expect(onOpen).toHaveBeenCalled();
  });
});

describe('ayrıntı görünümü', () => {
  it('her izin durumunu ve seçimini gösterir; "Sistem" seçimi ayarı kaydedip telefonu yeniden okur', async () => {
    render(<PhoneFootprintView onBack={() => {}} />);
    const row = document.querySelector('[data-footprint="caption"]');
    expect(row.getAttribute('data-policy')).toBe('auto');
    expect(within(row).getByText('Şu an etkin')).toBeTruthy();

    fireEvent.click(within(row).getByRole('radio', { name: 'Sistem' }));
    expect(document.querySelector('[data-footprint="caption"]').getAttribute('data-policy')).toBe('system');   // anında
    await waitFor(() => expect(saveSettings).toHaveBeenCalledWith({ phone_footprint: { caption: 'system' } }));
    await waitFor(() => expect(api.get).toHaveBeenCalledWith('/api/device/footprint'));
  });

  it('ayrıntı açılınca iki seçeneğin etkisini ve telefondaki ham değeri gösterir', () => {
    render(<PhoneFootprintView onBack={() => {}} />);
    const row = document.querySelector('[data-footprint="caption"]');
    fireEvent.click(within(row).getByRole('button', { name: 'Ayrıntıları göster' }));
    expect(within(row).getByText('secure/disable_decoration_dot')).toBeTruthy();
    expect(within(row).getByText('OpenDeX yönetirse')).toBeTruthy();
    expect(within(row).getByText('Sisteme bırakırsan')).toBeTruthy();
  });

  it('Workspace için gerekli bir iz sisteme bırakılınca uyarı görünür', () => {
    act(() => usePhoneFootprintStore.setState({ snap: { ...SNAP, items: [item('freeform_support', { policy: 'system', advised_for: 'workspace' })] } }));
    render(<PhoneFootprintView onBack={() => {}} />);
    const row = document.querySelector('[data-footprint="freeform_support"]');
    fireEvent.click(within(row).getByRole('button', { name: 'Ayrıntıları göster' }));
    expect(within(row).getByText(/Workspace için önerilir/)).toBeTruthy();
  });

  it('"Tümünü telefona bırak" önce onay ister, onayda hepsi tek kayıtta sisteme geçer', async () => {
    render(<PhoneFootprintView onBack={() => {}} />);
    fireEvent.click(screen.getByTestId('footprint-restore-all'));
    expect(saveSettings).not.toHaveBeenCalled();
    fireEvent.click(await screen.findByRole('button', { name: 'Telefona bırak' }));   // şerit, düğmenin çıkışından sonra girer
    await waitFor(() => expect(saveSettings).toHaveBeenCalledTimes(1));
    expect(saveSettings.mock.calls[0][0]).toEqual({
      phone_footprint: { caption: 'system', stay_awake: 'system', freeform_support: 'system' },
      usb_stability_guard: false,
    });
  });

  it('bu telefonda olmayan iz seçim sunmaz', () => {
    act(() => usePhoneFootprintStore.setState({ snap: { ...SNAP, items: [item('caption', { applicable: false, state: 'unsupported' })] } }));
    render(<PhoneFootprintView onBack={() => {}} />);
    const row = document.querySelector('[data-footprint="caption"]');
    expect(within(row).queryByRole('radio')).toBeNull();
    expect(within(row).getByText('Bu telefonda yok')).toBeTruthy();
  });
});

describe('Sistem seçilince: telefonda Açık | Kapalı', () => {
  const withPolicy = (id, policy) =>
    act(() => usePhoneFootprintStore.setState({ snap: { ...SNAP, items: SNAP.items.map((i) => (i.id === id ? { ...i, policy } : i)) } }));

  it('OpenDeX yönetirken elle Açık | Kapalı yoktur; Sistem seçilince belirir ve telefondaki değer işaretlidir', async () => {
    render(<PhoneFootprintView onBack={() => {}} />);
    const row = () => document.querySelector('[data-footprint="caption"]');
    expect(within(row()).queryByRole('radio', { name: 'Açık' })).toBeNull();

    // Backend, kaydedilen seçimi sonraki okumada döndürür.
    api.get.mockResolvedValue({ ...SNAP, items: SNAP.items.map((i) => (i.id === 'caption' ? { ...i, policy: 'system' } : i)) });
    fireEvent.click(within(row()).getByRole('radio', { name: 'Sistem' }));
    await waitFor(() => expect(usePhoneFootprintStore.getState().saving).toEqual({}));
    const onButton = within(row()).getByRole('radio', { name: 'Açık' });
    expect(onButton.getAttribute('aria-checked')).toBe('true');                       // başlık çubuğu şu an gizli
    expect(within(row()).getByRole('radio', { name: 'Kapalı' }).getAttribute('aria-checked')).toBe('false');
  });

  it('Kapalı seçilince telefondaki değer kim yönettiğine dokunmadan hemen yazılır ve yeni okuma gösterilir', async () => {
    withPolicy('caption', 'system');
    const after = { ...SNAP, items: SNAP.items.map((i) => (i.id === 'caption' ? { ...i, policy: 'system', state: 'default' } : i)) };
    api.put.mockResolvedValue(after);
    render(<PhoneFootprintView onBack={() => {}} />);
    const row = () => document.querySelector('[data-footprint="caption"]');

    fireEvent.click(within(row()).getByRole('radio', { name: 'Kapalı' }));
    expect(row().getAttribute('data-live')).toBe('off');                                  // anında
    await waitFor(() => expect(api.put).toHaveBeenCalledWith('/api/device/footprint/caption', { on: false }));
    expect(saveSettings).not.toHaveBeenCalled();
    await waitFor(() => expect(within(row()).getByText('Telefon varsayılanı')).toBeTruthy());
    expect(within(row()).getByRole('radio', { name: 'Kapalı' }).getAttribute('aria-checked')).toBe('true');
  });

  it('sisteme bırakılmış ama telefonda açık kalmış bir değer (eski bir hatadan) Açık işaretli gösterilir; Kapalı tek tık uzakta', () => {
    act(() => usePhoneFootprintStore.setState({ snap: { ...SNAP, items: [item('stay_awake', { kind: 'lease', policy: 'system', state: 'leftover' })] } }));
    render(<PhoneFootprintView onBack={() => {}} />);
    const row = document.querySelector('[data-footprint="stay_awake"]');
    expect(within(row).getByRole('radio', { name: 'Açık' }).getAttribute('aria-checked')).toBe('true');
    expect(within(row).getByRole('radio', { name: 'Kapalı' })).toBeTruthy();
    // "Sistem"de değer kullanıcınındır: uyarı yok, hap düz "Açık".
    expect(within(row).queryByText(/açık kalmış/i)).toBeNull();
    expect(row.querySelector('[data-state="on_manual"]')).toBeTruthy();
  });

  it('yazılamazsa hata gösterilir ve telefon yeniden okunur', async () => {
    withPolicy('stay_awake', 'system');
    api.put.mockRejectedValue(new Error('boom'));
    render(<PhoneFootprintView onBack={() => {}} />);
    fireEvent.click(within(document.querySelector('[data-footprint="stay_awake"]')).getByRole('radio', { name: 'Kapalı' }));
    expect(await screen.findByRole('alert')).toBeTruthy();
    await waitFor(() => expect(api.get).toHaveBeenCalledWith('/api/device/footprint'));
  });

  it('elle değiştirilemeyen iz (USB) Sistem seçili olsa da Açık | Kapalı sunmaz, nedeni ayrıntıda yazar', () => {
    withPolicy('usb_guard', 'system');
    render(<PhoneFootprintView onBack={() => {}} />);
    const row = document.querySelector('[data-footprint="usb_guard"]');
    expect(within(row).queryByRole('radio', { name: 'Kapalı' })).toBeNull();
    fireEvent.click(within(row).getByRole('button', { name: 'Ayrıntıları göster' }));
    expect(within(row).getByText(/kablosuz bağlantıyı koparır/)).toBeTruthy();
  });
});

describe('OpenDeX Ayarları › Telefon ayarları', () => {
  it('aynı liste geniş hâliyle gösterilir ve açılınca telefon okunur', async () => {
    render(<PhoneSection />);
    expect(screen.getByRole('heading', { name: 'Telefon ayarları' })).toBeTruthy();
    expect(document.querySelector('[data-setting-id="phoneFootprint"] [data-footprint="caption"]')).toBeTruthy();
    await waitFor(() => expect(api.get).toHaveBeenCalledWith('/api/device/footprint'));
  });
});

describe('DeX paneli ⟷ OpenDeX Ayarları', () => {
  it('ikisi aynı kaynağı gösterir: birinde yapılan seçim ve aç/kapat ötekinde anında görünür', async () => {
    api.put.mockImplementation(() => new Promise(() => {}));   // yanıt beklenirken bile ikisi aynı
    render(
      <>
        <div data-testid="dex"><PhoneFootprintView onBack={() => {}} /></div>
        <div data-testid="settings"><PhoneSection /></div>
      </>,
    );
    const row = (panel, id) => within(screen.getByTestId(panel)).getByTestId('footprint-view').querySelector(`[data-footprint="${id}"]`);

    // Backend, kaydedilen seçimi sonraki okumada döndürür.
    api.get.mockResolvedValue({ ...SNAP, items: SNAP.items.map((i) => (i.id === 'caption' ? { ...i, policy: 'system' } : i)) });
    fireEvent.click(within(row('settings', 'caption')).getByRole('radio', { name: 'Sistem' }));
    expect(row('dex', 'caption').getAttribute('data-policy')).toBe('system');
    await waitFor(() => expect(usePhoneFootprintStore.getState().saving).toEqual({}));
    fireEvent.click(within(row('dex', 'caption')).getByRole('radio', { name: 'Kapalı' }));
    expect(row('settings', 'caption').getAttribute('data-live')).toBe('off');
  });
});

describe('yarış: eski bir okuma tıklamayı geri almaz', () => {
  it('yazılmakta olan satır, o sırada gelen eski okumada kullanıcının seçtiği hâlde kalır', async () => {
    let resolvePut;
    api.put.mockImplementation(() => new Promise((resolve) => { resolvePut = resolve; }));
    const store = usePhoneFootprintStore.getState();
    const pending = store.setLive('caption', false);
    expect(usePhoneFootprintStore.getState().snap.items[0].state).toBe('default');
    await usePhoneFootprintStore.getState().load();                                    // eski: caption hâlâ "held"
    expect(usePhoneFootprintStore.getState().snap.items[0].state).toBe('default');
    resolvePut({ ...SNAP, items: SNAP.items.map((i) => (i.id === 'caption' ? { ...i, state: 'default' } : i)) });
    await pending;
    expect(usePhoneFootprintStore.getState().toggling).toEqual({});
  });
});

describe('önceki oturumdan açık kalmış değer', () => {
  it('"Açık kalmış" olarak, nasıl kapatılacağını söyleyen bir uyarıyla gösterilir ve etkin sayılır', () => {
    act(() => usePhoneFootprintStore.setState({ snap: { ...SNAP, items: [item('stay_awake', { kind: 'lease', state: 'leftover' })] } }));
    render(<PhoneFootprintView onBack={() => {}} />);
    const row = document.querySelector('[data-footprint="stay_awake"]');
    expect(row.getAttribute('data-live')).toBe('on');
    expect(within(row).getByText('Açık kalmış')).toBeTruthy();
    expect(within(row).getByText(/Önceki bir oturumdan açık kalmış/)).toBeTruthy();
  });
});
