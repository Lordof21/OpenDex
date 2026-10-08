import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { PrecisionSlider } from '../src/ui/PrecisionSlider.jsx';
import {
  ECHO_HOLDOFF_MS,
  THUMB_GRAB_RADIUS_PX,
  isThumbHit,
  snapToStep,
  stepFrom,
  valueFromDrag,
} from '../src/ui/useRelativeDrag.js';

// ───────────────────────────── saf yardımcılar ─────────────────────────────

describe('snapToStep', () => {
  it('adım ızgarasına oturtur ve [min, max] içinde tutar', () => {
    expect(snapToStep(207, 160, 340, 2)).toBe(208); // 207 → en yakın ızgara (yarım adım yukarı yuvarlanır)
    expect(snapToStep(205.4, 160, 340, 2)).toBe(206);
    expect(snapToStep(-50, 0, 100, 1)).toBe(0);
    expect(snapToStep(500, 0, 100, 1)).toBe(100);
  });

  it('ızgara max ile örtüşmüyorsa max yine ulaşılabilirdir (kelepçe)', () => {
    expect(snapToStep(100, 0, 95, 10)).toBe(95);
  });

  it('ondalık adımlarda kayan nokta artığı bırakmaz', () => {
    expect(snapToStep(0.3, 0, 1, 0.1)).toBe(0.3);
    expect(snapToStep(0.7000000001, 0, 1, 0.1)).toBe(0.7);
  });

  it('geçersiz aralıkta min döner', () => {
    expect(snapToStep(5, 10, 10, 1)).toBe(10);
  });
});

describe('valueFromDrag', () => {
  const base = { min: 0, max: 100, step: 1, width: 200 };

  it('değer, başlangıç + dx/genişlik·aralık (GÖRELİ)', () => {
    expect(valueFromDrag({ ...base, startValue: 50, dx: 20 })).toBe(60);
    expect(valueFromDrag({ ...base, startValue: 50, dx: -40 })).toBe(30);
  });

  it('uç değerlerde kelepçelenir', () => {
    expect(valueFromDrag({ ...base, startValue: 90, dx: 500 })).toBe(100);
    expect(valueFromDrag({ ...base, startValue: 10, dx: -500 })).toBe(0);
  });

  it('yarım adımdan küçük hareket başlangıç değerini korur (ızgara dışı başlangıçta sahte sıçrama yok)', () => {
    // 197, 160..340 / 2'lik ızgarada ızgara dışıdır; dx=0 → hâlâ 197 (198'e sıçramaz)
    expect(valueFromDrag({ startValue: 197, dx: 0, width: 300, min: 160, max: 340, step: 2 })).toBe(197);
    expect(valueFromDrag({ startValue: 197, dx: 1, width: 300, min: 160, max: 340, step: 2 })).toBe(197);
  });

  it('genişlik 0 ise başlangıç değeri döner', () => {
    expect(valueFromDrag({ ...base, width: 0, startValue: 42, dx: 100 })).toBe(42);
  });
});

describe('isThumbHit', () => {
  const rect = { left: 100, width: 200 };

  it('tutamaç merkezine ±yarıçap içinde → true, dışında → false', () => {
    // %50 → x = 200
    expect(isThumbHit(200, rect, 50)).toBe(true);
    expect(isThumbHit(200 + THUMB_GRAB_RADIUS_PX, rect, 50)).toBe(true);
    expect(isThumbHit(200 + THUMB_GRAB_RADIUS_PX + 1, rect, 50)).toBe(false);
    expect(isThumbHit(110, rect, 50)).toBe(false);
  });

  it('genişliği olmayan izleyicide asla yakalamaz', () => {
    expect(isThumbHit(0, { left: 0, width: 0 }, 0)).toBe(false);
  });
});

describe('stepFrom', () => {
  it('ızgaradaki değerden tam adım atar', () => {
    expect(stepFrom(206, 1, 1, 160, 340, 2)).toBe(208);
    expect(stepFrom(206, -1, 1, 160, 340, 2)).toBe(204);
    expect(stepFrom(206, 1, 5, 160, 340, 2)).toBe(216);
  });

  it('ızgara dışındaki değerden (otomatik 197) ilk adım en yakın ızgara noktasına gider', () => {
    expect(stepFrom(197, 1, 1, 140, 380, 2)).toBe(198);
    expect(stepFrom(197, -1, 1, 140, 380, 2)).toBe(196);
    expect(stepFrom(197, 1, 5, 140, 380, 2)).toBe(206); // ilk adım 198, sonraki 4 adım → 206
  });

  it('sınırda kelepçelenir', () => {
    expect(stepFrom(100, 1, 1, 0, 100, 1)).toBe(100);
    expect(stepFrom(0, -1, 5, 0, 100, 1)).toBe(0);
  });
});

// ───────────────────────────── PrecisionSlider (kanca dahil) ─────────────────────────────

const TRACK = { left: 0, width: 200 }; // 0..100 aralığında 1 px = 0,5 birim; %50 tutamaç = x 100

function stubRect(el, { left, width } = TRACK) {
  vi.spyOn(el, 'getBoundingClientRect').mockReturnValue({
    left, width, right: left + width, top: 0, bottom: 32, height: 32, x: left, y: 0, toJSON() {},
  });
}

function Harness({ initial = 50, onChange, onCommit, controlled = true, ...rest }) {
  const [v, setV] = useState(initial);
  return (
    <PrecisionSlider
      value={v}
      min={0}
      max={100}
      step={1}
      label="Deneme"
      unit="u"
      onChange={onChange}
      onCommit={(x) => {
        onCommit?.(x);
        if (controlled) setV(x); // gerçek ebeveyn commit'i değere yansıtır
      }}
      {...rest}
    />
  );
}

function setup(props = {}) {
  const onChange = vi.fn();
  const onCommit = vi.fn();
  const utils = render(<Harness onChange={onChange} onCommit={onCommit} {...props} />);
  const track = utils.getByRole('slider');
  stubRect(track);
  return { ...utils, track, onChange, onCommit };
}

const down = (el, clientX, extra = {}) => fireEvent.pointerDown(el, { pointerId: 1, button: 0, clientX, ...extra });
const move = (el, clientX) => fireEvent.pointerMove(el, { pointerId: 1, clientX });
const up = (el, clientX) => fireEvent.pointerUp(el, { pointerId: 1, clientX });

describe('PrecisionSlider — göreli sürükleme', () => {
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('BOŞ track tıklaması hiçbir şey yapmaz: değer atlamaz, onChange/onCommit çağrılmaz', () => {
    const { track, onChange, onCommit } = setup();

    down(track, 20); // tutamaç x=100'de; 20 boş track
    move(track, 150);
    up(track, 150);

    expect(onChange).not.toHaveBeenCalled();
    expect(onCommit).not.toHaveBeenCalled();
    expect(track).toHaveAttribute('aria-valuenow', '50');
  });

  it('tutamaç sürüklenince değer AKICI değişir (onChange), commit YALNIZ bırakınca ve TEK kez', () => {
    const { track, onChange, onCommit } = setup();

    down(track, 100);
    move(track, 120); // +20 px = +10 birim
    expect(onChange).toHaveBeenLastCalledWith(60);
    move(track, 130);
    expect(onChange).toHaveBeenLastCalledWith(65);
    expect(onCommit).not.toHaveBeenCalled(); // sürükleme sırasında commit YOK

    up(track, 130);
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith(65);
    expect(track).toHaveAttribute('aria-valuenow', '65');
  });

  it('tutamağa merkezinden uzak (yarıçap içinde) basmak sıçrama yaratmaz: hareket GÖRELİdir', () => {
    const { track, onChange } = setup();

    down(track, 100 + THUMB_GRAB_RADIUS_PX - 2); // merkezden 16 px sağda
    expect(onChange).not.toHaveBeenCalled(); // basış anında değer değişmez
    move(track, 100 + THUMB_GRAB_RADIUS_PX - 2 + 20);
    expect(onChange).toHaveBeenLastCalledWith(60); // basılan noktaya değil, hareket miktarına göre
  });

  it('yarıçapın hemen dışına basmak sürükleme başlatmaz', () => {
    const { track, onChange } = setup();

    down(track, 100 + THUMB_GRAB_RADIUS_PX + 2);
    move(track, 180);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('Esc sürüklemeyi iptal eder: eski değere döner, commit YOK, olay dışarı sızmaz', () => {
    const { track, onChange, onCommit } = setup();
    const outsideEsc = vi.fn();
    window.addEventListener('keydown', outsideEsc); // ör. "paneli Esc ile kapat" dinleyicisi

    down(track, 100);
    move(track, 140);
    expect(onChange).toHaveBeenLastCalledWith(70);

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onChange).toHaveBeenLastCalledWith(50); // etiket eski değere döner
    expect(track).toHaveAttribute('aria-valuenow', '50');
    expect(outsideEsc).not.toHaveBeenCalled(); // önce sürükleme iptal olur, panel kapanmaz

    up(track, 140); // sonradan gelen bırakma artık bir şey yapmaz
    expect(onCommit).not.toHaveBeenCalled();
    window.removeEventListener('keydown', outsideEsc);
  });

  it('pointercancel de eski değere döndürür ve commit etmez', () => {
    const { track, onChange, onCommit } = setup();

    down(track, 100);
    move(track, 160);
    fireEvent.pointerCancel(track, { pointerId: 1 });

    expect(onChange).toHaveBeenLastCalledWith(50);
    expect(onCommit).not.toHaveBeenCalled();
    expect(track).toHaveAttribute('aria-valuenow', '50');
  });

  it('sürükleyip başlangıç değerine geri bırakmak commit ETMEZ (net değişiklik yok)', () => {
    const { track, onCommit } = setup();

    down(track, 100);
    move(track, 160);
    move(track, 100);
    up(track, 100);

    expect(onCommit).not.toHaveBeenCalled();
  });

  it('başka bir işaretçinin (ikinci parmak) olayları oturumu bozmaz', () => {
    const { track, onChange, onCommit } = setup();

    down(track, 100);
    fireEvent.pointerMove(track, { pointerId: 7, clientX: 190 }); // yabancı işaretçi
    fireEvent.pointerUp(track, { pointerId: 7, clientX: 190 });
    expect(onChange).not.toHaveBeenCalled();
    expect(onCommit).not.toHaveBeenCalled();

    move(track, 120);
    up(track, 120);
    expect(onCommit).toHaveBeenCalledWith(60);
  });

  it('sağ tuş (button≠0) sürükleme başlatmaz', () => {
    const { track, onChange } = setup();

    down(track, 100, { button: 2 });
    move(track, 150);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('yalnız onChange verilirse (onCommit yok) canlı çalışır ve hata vermez', () => {
    const onChange = vi.fn();
    const { getByRole } = render(<PrecisionSlider value={50} min={0} max={100} step={1} label="x" onChange={onChange} />);
    const track = getByRole('slider');
    stubRect(track);

    down(track, 100);
    move(track, 120);
    up(track, 120);
    expect(onChange).toHaveBeenLastCalledWith(60);
  });

  describe('klavye', () => {
    it('ok tuşları adım atar; basılı tutmada her tekrar onChange, commit yalnız keyup’ta TEK kez', () => {
      const { track, onChange, onCommit } = setup();

      fireEvent.keyDown(track, { key: 'ArrowRight' });
      fireEvent.keyDown(track, { key: 'ArrowRight' }); // tuş tekrarı
      fireEvent.keyDown(track, { key: 'ArrowRight' });
      expect(onChange.mock.calls.map((c) => c[0])).toEqual([51, 52, 53]);
      expect(onCommit).not.toHaveBeenCalled();

      fireEvent.keyUp(track, { key: 'ArrowRight' });
      expect(onCommit).toHaveBeenCalledTimes(1);
      expect(onCommit).toHaveBeenCalledWith(53);
    });

    it('Home / End / PageUp / PageDown', () => {
      const { track, onCommit } = setup();

      fireEvent.keyDown(track, { key: 'Home' });
      fireEvent.keyUp(track, { key: 'Home' });
      expect(onCommit).toHaveBeenLastCalledWith(0);

      fireEvent.keyDown(track, { key: 'End' });
      fireEvent.keyUp(track, { key: 'End' });
      expect(onCommit).toHaveBeenLastCalledWith(100);

      fireEvent.keyDown(track, { key: 'PageDown' });
      fireEvent.keyUp(track, { key: 'PageDown' });
      expect(onCommit).toHaveBeenLastCalledWith(95);
    });

    it('tuşa basılıyken odak giderse (blur) bekleyen değişiklik kaybolmaz, commit edilir', () => {
      const { track, onCommit } = setup();

      fireEvent.keyDown(track, { key: 'ArrowLeft' });
      fireEvent.blur(track);
      expect(onCommit).toHaveBeenCalledWith(49);
    });

    it('sınırda basmak değer değiştirmez → commit yok', () => {
      const { track, onCommit } = setup({ initial: 100 });

      fireEvent.keyDown(track, { key: 'ArrowRight' });
      fireEvent.keyUp(track, { key: 'ArrowRight' });
      expect(onCommit).not.toHaveBeenCalled();
    });

    it('ilgisiz tuşlar yok sayılır', () => {
      const { track, onChange } = setup();

      fireEvent.keyDown(track, { key: 'a' });
      expect(onChange).not.toHaveBeenCalled();
    });
  });

  describe('± düğmeleri', () => {
    it('tek tık: bir adım ve bırakınca TEK commit', () => {
      const { getByLabelText, onChange, onCommit } = setup();
      const plus = getByLabelText('Değeri artır');

      fireEvent.pointerDown(plus, { pointerId: 1, button: 0 });
      expect(onChange).toHaveBeenLastCalledWith(51);
      expect(onCommit).not.toHaveBeenCalled();
      fireEvent.pointerUp(plus, { pointerId: 1 });
      expect(onCommit).toHaveBeenCalledTimes(1);
      expect(onCommit).toHaveBeenCalledWith(51);
    });

    it('basılı tutunca değer İLERLER (eskiden bayat closure yüzünden ilk adımda takılıyordu) ve tek commit gider', () => {
      vi.useFakeTimers();
      const { getByLabelText, onChange, onCommit } = setup();
      const plus = getByLabelText('Değeri artır');

      fireEvent.pointerDown(plus, { pointerId: 1, button: 0 });
      act(() => {
        vi.advanceTimersByTime(300 + 75 * 3);
      });
      const values = onChange.mock.calls.map((c) => c[0]);
      expect(values.length).toBeGreaterThanOrEqual(4);
      expect(values).toEqual([...values].sort((a, b) => a - b)); // artan
      expect(new Set(values).size).toBe(values.length); // aynı değeri tekrarlamaz

      expect(onCommit).not.toHaveBeenCalled();
      fireEvent.pointerUp(plus, { pointerId: 1 });
      expect(onCommit).toHaveBeenCalledTimes(1);
      expect(onCommit).toHaveBeenCalledWith(values[values.length - 1]);
    });

    it('basılı tutma sınıra ulaşınca tekrarı kendisi bırakır', () => {
      vi.useFakeTimers();
      const { getByLabelText, onChange } = setup({ initial: 98 });
      const plus = getByLabelText('Değeri artır');

      fireEvent.pointerDown(plus, { pointerId: 1, button: 0 });
      act(() => {
        vi.advanceTimersByTime(300 + 75 * 10);
      });
      expect(onChange.mock.calls.map((c) => c[0])).toEqual([99, 100]);
    });
  });

  describe('yankı bekletmesi (holdoffMs)', () => {
    it('commit sonrası dışarıdan gelen ESKİ değer tutamağı geri sıçratmaz; süre dolunca dışarıdaki gerçek değere dönülür', () => {
      vi.useFakeTimers();
      // controlled=false: ebeveyn değeri güncellemiyor (telefondan gelen eski yankıyı simüle eder)
      const { track } = setup({ controlled: false, holdoffMs: ECHO_HOLDOFF_MS });

      down(track, 100);
      move(track, 130);
      up(track, 130);
      expect(track).toHaveAttribute('aria-valuenow', '65'); // dışarıdaki değer hâlâ 50, ama gösterilen 65

      act(() => {
        vi.advanceTimersByTime(ECHO_HOLDOFF_MS - 50);
      });
      expect(track).toHaveAttribute('aria-valuenow', '65');

      act(() => {
        vi.advanceTimersByTime(100);
      });
      expect(track).toHaveAttribute('aria-valuenow', '50'); // bekletme bitti: gerçek değer
    });

    it('bekletme yokken (varsayılan) commit sonrası hemen dışarıdaki değer gösterilir', () => {
      const { track } = setup({ controlled: false });

      down(track, 100);
      move(track, 130);
      up(track, 130);
      expect(track).toHaveAttribute('aria-valuenow', '50');
    });
  });

  it('erişilebilirlik: rol, sınırlar ve değer metni', () => {
    const { track } = setup();
    expect(track).toHaveAttribute('role', 'slider');
    expect(track).toHaveAttribute('aria-valuemin', '0');
    expect(track).toHaveAttribute('aria-valuemax', '100');
    expect(track).toHaveAttribute('aria-valuetext', '50 u');
    expect(track).toHaveAttribute('aria-label', 'Deneme');
    expect(track).toHaveAttribute('tabindex', '0');
  });
});
