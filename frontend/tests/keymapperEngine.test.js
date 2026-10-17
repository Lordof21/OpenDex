// Tuş eşleyici motoru: klavye → telefonda sanal parmak. Asıl risk, odak kaybında "keyup"ın hiç gelmemesi: parmak telefonda
// basılı kalır ve motor W'nin hâlâ basılı olduğunu sanır — oyuncu geri döndüğünde karakter artık yönlendirilemez.
import { beforeEach, describe, expect, it } from 'vitest';
import { DPAD_POINTER_ID, FIRST_TAP_POINTER_ID, handleKeymapperInput, releaseKeymapperInput } from '../src/keymapper/keymapperEngine.js';

const W = 'win-1';
const DEVICE = { w: 1000, h: 500 };
const JOYSTICK = { id: 'j', type: 'dpad', rx: 0.2, ry: 0.6, radius: 0.1 };
const FIRE = { id: 'f', type: 'tap', key: 'f', rx: 0.8, ry: 0.5 };
const JUMP = { id: 'sp', type: 'tap', key: 'Space', rx: 0.9, ry: 0.4 };

function socket() {
  const calls = [];
  return {
    calls,
    down: (x, y, pid) => calls.push(['down', x, y, pid]),
    move: (x, y, pid) => calls.push(['move', x, y, pid]),
    up: (x, y, pid) => calls.push(['up', x, y, pid]),
  };
}

const key = (k, extra = {}) => ({ key: k, repeat: false, target: {}, preventDefault() {}, ...extra });
const press = (nodes, s, k, extra) => handleKeymapperInput(key(k, extra), true, W, nodes, s, DEVICE.w, DEVICE.h);
const lift = (nodes, s, k) => handleKeymapperInput(key(k), false, W, nodes, s, DEVICE.w, DEVICE.h);

let s;
beforeEach(() => {
  s = socket();
  releaseKeymapperInput(W, socket()); // module state is per window id: start every test from a clean slate
});

describe('handleKeymapperInput', () => {
  it('WASD holds the joystick finger down at its centre and leans it towards the pressed direction', () => {
    expect(press([JOYSTICK], s, 'w')).toBe(true);
    // centre = (0.2*1000, 0.6*500) = (200, 300); radius = 0.1 * min(1000, 500) = 50 → up = (200, 250)
    expect(s.calls).toEqual([['down', 200, 300, DPAD_POINTER_ID], ['move', 200, 250, DPAD_POINTER_ID]]);
  });

  it('lifting the last direction key lifts the finger', () => {
    press([JOYSTICK], s, 'w');
    s.calls.length = 0;
    lift([JOYSTICK], s, 'w');
    expect(s.calls).toEqual([['up', 200, 250, DPAD_POINTER_ID]]);
  });

  it('a tap key presses on keydown, ignores auto-repeat and lifts on keyup', () => {
    press([FIRE], s, 'f');
    press([FIRE], s, 'f', { repeat: true });
    lift([FIRE], s, 'f');
    expect(s.calls).toEqual([['down', 800, 250, FIRST_TAP_POINTER_ID], ['up', 800, 250, FIRST_TAP_POINTER_ID]]);
  });

  it('keys that are not mapped are not consumed', () => {
    expect(press([JOYSTICK, FIRE], s, 'q')).toBe(false);
    expect(s.calls).toEqual([]);
  });
});

describe('releaseKeymapperInput — focus left while keys were held', () => {
  it('lifts the joystick finger at the last point it was pushed to', () => {
    press([JOYSTICK], s, 'w');
    s.calls.length = 0;
    releaseKeymapperInput(W, s);
    expect(s.calls).toEqual([['up', 200, 250, DPAD_POINTER_ID]]);
  });

  it('lifts every held tap, once', () => {
    press([FIRE, JUMP], s, 'f');
    press([FIRE, JUMP], s, ' ');
    s.calls.length = 0;
    releaseKeymapperInput(W, s);
    expect(s.calls).toHaveLength(2);
    expect(s.calls).toEqual(expect.arrayContaining([['up', 800, 250, FIRST_TAP_POINTER_ID], ['up', 900, 200, FIRST_TAP_POINTER_ID + 1]]));

    s.calls.length = 0;
    releaseKeymapperInput(W, s); // idempotent
    expect(s.calls).toEqual([]);
  });

  it('forgets which direction keys were held — the joystick can be steered again afterwards', () => {
    // The bug this guards: after a missed keyup the engine kept `isDown` and W=true, so the next W press sent no `down`
    // and D alone could never recentre — the character could not be steered until the page was reloaded.
    press([JOYSTICK], s, 'w');
    releaseKeymapperInput(W, s);
    s.calls.length = 0;

    press([JOYSTICK], s, 'd');
    expect(s.calls).toEqual([['down', 200, 300, DPAD_POINTER_ID], ['move', 250, 300, DPAD_POINTER_ID]]); // a fresh press, and only D (no stale W)
  });

  it('a keyup for a press that was already released sends no stray `up`', () => {
    // Tab away with F held, come back and let go of F: that keyup must not lift a finger that is down for another reason.
    press([FIRE, JOYSTICK], s, 'f');
    releaseKeymapperInput(W, s);
    press([FIRE, JOYSTICK], s, 'w'); // the joystick finger goes down after the player returned
    s.calls.length = 0;

    lift([FIRE, JOYSTICK], s, 'f');
    expect(s.calls).toEqual([]);
  });

  it('keeps windows apart', () => {
    const other = socket();
    handleKeymapperInput(key('w'), true, 'win-2', [JOYSTICK], other, DEVICE.w, DEVICE.h);
    press([JOYSTICK], s, 'w');
    s.calls.length = 0;
    other.calls.length = 0;

    releaseKeymapperInput(W, s);
    expect(s.calls).toEqual([['up', 200, 250, DPAD_POINTER_ID]]);
    expect(other.calls).toEqual([]);
    releaseKeymapperInput('win-2', other);
  });

  it('does nothing for a window that holds nothing, or without a socket', () => {
    expect(() => releaseKeymapperInput('never-seen', s)).not.toThrow();
    press([JOYSTICK], s, 'w');
    expect(() => releaseKeymapperInput(W, null)).not.toThrow();
  });
});

describe('every held finger has its own pointer', () => {
  // Bug: the joystick and every key shared pointer 0, so the phone saw ONE finger: a second `down` replaced the first, an `up`
  // lifted the wrong finger and moves jumped between the two. Single presses worked; combinations tangled.
  it('the joystick and a tap key held together use different pointers, and each `up` names its own', () => {
    const nodes = [JOYSTICK, FIRE];
    press(nodes, s, 'w');
    press(nodes, s, 'f');
    lift(nodes, s, 'f');
    lift(nodes, s, 'w');
    const pointers = s.calls.map(([, , , pid]) => pid);
    expect(new Set(pointers)).toEqual(new Set([DPAD_POINTER_ID, FIRST_TAP_POINTER_ID]));
    expect(s.calls).toEqual([
      ['down', 200, 300, DPAD_POINTER_ID], ['move', 200, 250, DPAD_POINTER_ID],
      ['down', 800, 250, FIRST_TAP_POINTER_ID],
      ['up', 800, 250, FIRST_TAP_POINTER_ID],
      ['up', 200, 250, DPAD_POINTER_ID],
    ]);
  });

  it('two tap keys held together do not share a pointer; a freed pointer is reused', () => {
    const nodes = [FIRE, JUMP];
    press(nodes, s, 'f');
    press(nodes, s, ' ');
    expect(s.calls.map((c) => c[3])).toEqual([FIRST_TAP_POINTER_ID, FIRST_TAP_POINTER_ID + 1]);
    lift(nodes, s, 'f');
    s.calls.length = 0;
    press(nodes, s, 'f');
    expect(s.calls).toEqual([['down', 800, 250, FIRST_TAP_POINTER_ID]]);
  });

  it('keeps clear of pointer 0 (mouse) and 1 (second finger of a pinch)', () => {
    expect(DPAD_POINTER_ID).toBeGreaterThan(1);
    expect(FIRST_TAP_POINTER_ID).toBeGreaterThan(DPAD_POINTER_ID);
  });
});

// ───────────────────────────────────────────────────────────────────────────────── kaynak noktası, fare düğmeleri, fareyle bakış
import { LOOK_POINTER_ID, handleKeymapperMouseButton, isLookHeld, lookRegion, moveLook, releaseLook } from '../src/keymapper/keymapperEngine.js';

describe('Workspace görevi: düzen görevin kutusuna yaslanır (kaynak noktası)', () => {
  const ORIGIN = { x: 100, y: 50 };

  it('joystick ve tuş, görevin sol-üst köşesine göre konumlanır', () => {
    press([JOYSTICK], s, 'w', {});
    releaseKeymapperInput(W, socket());
    s.calls.length = 0;

    handleKeymapperInput(key('w'), true, W, [JOYSTICK], s, DEVICE.w, DEVICE.h, ORIGIN);
    // merkez = (100 + 0.2*1000, 50 + 0.6*500) = (300, 350); yarıçap 50 → yukarı = (300, 300)
    expect(s.calls).toEqual([['down', 300, 350, DPAD_POINTER_ID], ['move', 300, 300, DPAD_POINTER_ID]]);

    s.calls.length = 0;
    handleKeymapperInput(key('f'), true, W, [FIRE], s, DEVICE.w, DEVICE.h, ORIGIN);
    expect(s.calls).toEqual([['down', 900, 300, FIRST_TAP_POINTER_ID]]); // 100 + 0.8*1000, 50 + 0.5*500
  });

  it('joystick görev kutusunun dışına çıkmaz', () => {
    const edge = { id: 'e', type: 'dpad', rx: 0.99, ry: 0.5, radius: 0.5 };
    handleKeymapperInput(key('d'), true, W, [edge], s, DEVICE.w, DEVICE.h, ORIGIN);
    const [, x] = s.calls.at(-1);
    expect(x).toBeLessThanOrEqual(ORIGIN.x + DEVICE.w);
  });
});

describe('fare düğmeleri tuş olarak (ateş = sol tık)', () => {
  const MOUSE_FIRE = { id: 'm', type: 'tap', key: 'MouseLeft', rx: 0.8, ry: 0.5 };

  it('bağlı düğme dokunma noktasına basar / bırakır; klavye tuşlarıyla aynı parmak havuzunu kullanır', () => {
    press([FIRE, MOUSE_FIRE], s, 'f');
    expect(handleKeymapperMouseButton(0, true, W, [FIRE, MOUSE_FIRE], s, DEVICE.w, DEVICE.h)).toBe(true);
    expect(s.calls).toEqual([['down', 800, 250, FIRST_TAP_POINTER_ID], ['down', 800, 250, FIRST_TAP_POINTER_ID + 1]]);
    expect(handleKeymapperMouseButton(0, false, W, [FIRE, MOUSE_FIRE], s, DEVICE.w, DEVICE.h)).toBe(true);
    expect(s.calls.at(-1)).toEqual(['up', 800, 250, FIRST_TAP_POINTER_ID + 1]);
  });

  it('bağlı olmayan düğme / eşlemesiz pencere false döner (çağıran başka türlü işler)', () => {
    expect(handleKeymapperMouseButton(2, true, W, [MOUSE_FIRE], s, DEVICE.w, DEVICE.h)).toBe(false);
    expect(handleKeymapperMouseButton(0, true, W, [], s, DEVICE.w, DEVICE.h)).toBe(false);
    expect(handleKeymapperMouseButton(7, true, W, [MOUSE_FIRE], s, DEVICE.w, DEVICE.h)).toBe(false);
    expect(s.calls).toEqual([]);
  });

  it('düğme basılı unutulmaz: odak kaybında bırakılır', () => {
    handleKeymapperMouseButton(0, true, W, [MOUSE_FIRE], s, DEVICE.w, DEVICE.h);
    s.calls.length = 0;
    releaseKeymapperInput(W, s);
    expect(s.calls).toEqual([['up', 800, 250, FIRST_TAP_POINTER_ID]]);
  });
});

describe('fareyle bakış', () => {
  const REGION = { cx: 700, cy: 250, radius: 100 };
  const BOX = { x: 0, y: 0, w: 1000, h: 500 };

  it('bakış alanı: düğüm varsa onun merkezi, yoksa ekranın sağ yarısı', () => {
    expect(lookRegion([{ type: 'look', rx: 0.5, ry: 0.5, radius: 0.1 }], 1000, 500)).toEqual({ cx: 500, cy: 250, radius: 50 });
    expect(lookRegion([], 1000, 500)).toEqual({ cx: 720, cy: 250, radius: 90 });
    expect(lookRegion([{ type: 'look', rx: 0.5, ry: 0.5, radius: 0.1 }], 400, 200, { x: 100, y: 40 })).toEqual({ cx: 300, cy: 140, radius: 20 });
  });

  it('ilk harekette parmak merkeze basar, sonra hareket kadar kayar', () => {
    moveLook(W, s, REGION, 20, -10, BOX);
    expect(s.calls).toEqual([['down', 700, 250, LOOK_POINTER_ID], ['move', 720, 240, LOOK_POINTER_ID]]);
    expect(isLookHeld(W)).toBe(true);
  });

  it('sıfır hareket hiçbir şey göndermez', () => {
    moveLook(W, s, REGION, 0, 0, BOX);
    expect(s.calls).toEqual([]);
    expect(isLookHeld(W)).toBe(false);
  });

  // Parmağın `down`dan sonra kat ettiği toplam yol: yalnız `move`lar sayılır (kaldırıp merkeze koymak yol değildir).
  const travelled = (calls) => {
    let at = null;
    let tx = 0;
    let ty = 0;
    for (const [kind, x, y] of calls) {
      if (kind === 'down') at = [x, y];
      else if (kind === 'move') {
        tx += x - at[0];
        ty += y - at[1];
        at = [x, y];
      }
    }
    return [tx, ty];
  };

  it('yarıçap aşılınca parmak kaldırılıp merkeze yeniden konur ve hareketin KALANI oradan sürer (kayıp yok)', () => {
    moveLook(W, s, REGION, 95, 0, BOX);
    s.calls.length = 0;
    moveLook(W, s, REGION, 300, 0, BOX);
    expect(s.calls.some(([kind]) => kind === 'up')).toBe(true);
    expect(s.calls.some(([kind]) => kind === 'down')).toBe(true);
    expect(travelled([['down', 700, 250], ...s.calls])[0]).toBe(300);   // tam 300 px: eskiden yarıçapa (100) kırpılırdı
  });

  it('bir karedeki dev hareket (yarıçapın 10 katı) tek pikseli kaybetmeden iletilir; parmak hep alanın içinde kalır', () => {
    moveLook(W, s, REGION, 1000, -600, { x: -5000, y: -5000, w: 10000, h: 10000 });
    expect(travelled(s.calls)).toEqual([1000, -600]);
    for (const [kind, x, y] of s.calls) {
      if (kind === 'move') expect(Math.hypot(x - REGION.cx, y - REGION.cy)).toBeLessThanOrEqual(REGION.radius);
    }
  });

  it('kesirli hareket birikir: 300 × 0,4 px = 120 px (yuvarlama yüzünden duraksama yok)', () => {
    for (let i = 0; i < 300; i++) moveLook(W, s, REGION, 0.4, 0, BOX);
    expect(travelled(s.calls)[0]).toBe(120);
  });

  it('200 ardışık 1 px hareket tam 200 px verir', () => {
    for (let i = 0; i < 200; i++) moveLook(W, s, REGION, 1, 0, BOX);
    expect(travelled(s.calls)[0]).toBe(200);
  });

  it('parmak pencere kutusunun dışına çıkmaz', () => {
    moveLook(W, s, { cx: 990, cy: 250, radius: 400 }, 50, 0, BOX);
    expect(s.calls.at(-1)).toEqual(['move', 1000, 250, LOOK_POINTER_ID]);
  });

  it('releaseLook parmağı bir kez kaldırır; basılı değilse hiçbir şey yapmaz', () => {
    releaseLook(W, s);
    expect(s.calls).toEqual([]);
    moveLook(W, s, REGION, 10, 0, BOX);
    s.calls.length = 0;
    releaseLook(W, s);
    releaseLook(W, s);
    expect(s.calls).toEqual([['up', 710, 250, LOOK_POINTER_ID]]);
  });

  it('odak kaybında (releaseKeymapperInput) bakış parmağı da kalkar', () => {
    moveLook(W, s, REGION, 10, 0, BOX);
    s.calls.length = 0;
    releaseKeymapperInput(W, s);
    expect(s.calls).toEqual([['up', 710, 250, LOOK_POINTER_ID]]);
  });

  it('bakış parmağı joystick ve tuşlarla çakışmaz', () => {
    expect(LOOK_POINTER_ID).toBeGreaterThan(FIRST_TAP_POINTER_ID + 5);
    expect(LOOK_POINTER_ID).toBeLessThan(10); // scrcpy en çok 10 işaretçi
  });
});

// ───────────────────────────────────────────────────────────────────────────────── v2: şema, yürü, bas-aç, tekerlek, canlı etkinlik
import { vi } from 'vitest';
import {
  getKeymapActivity,
  handleKeymapperWheel,
  nodesForKey,
  subscribeKeymapActivity,
} from '../src/keymapper/keymapperEngine.js';

describe('joystick şeması ve yürü', () => {
  it('ESDF şemasında E yukarı gider; W artık joystick değildir; ok tuşları her şemada çalışır', () => {
    const esdf = { ...JOYSTICK, scheme: 'esdf' };
    expect(press([esdf], s, 'e')).toBe(true);
    expect(s.calls.at(-1)).toEqual(['move', 200, 250, DPAD_POINTER_ID]);   // merkez (200, 300), yarıçap 50 → yukarı
    expect(press([esdf], s, 'w')).toBe(false);
    expect(press([esdf], s, 'ArrowDown')).toBe(true);
  });

  it('yürü tuşu basılıyken itme yarıçapı walkScale ile küçülür; bırakınca tam itmeye döner', () => {
    const walker = { ...JOYSTICK, walkKey: 'Shift', walkScale: 0.5 };
    press([walker], s, 'w');
    expect(s.calls.at(-1)).toEqual(['move', 200, 250, DPAD_POINTER_ID]);
    expect(press([walker], s, 'Shift')).toBe(true);
    expect(s.calls.at(-1)).toEqual(['move', 200, 275, DPAD_POINTER_ID]);   // 50 × 0,5 = 25 px
    lift([walker], s, 'Shift');
    expect(s.calls.at(-1)).toEqual(['move', 200, 250, DPAD_POINTER_ID]);
  });

  it('yürü tuşu tek başına (yön yokken) parmak koymaz', () => {
    const walker = { ...JOYSTICK, walkKey: 'Shift' };
    press([walker], s, 'Shift');
    expect(s.calls).toEqual([]);
  });
});

describe('bas-aç / bas-kapa tuşu', () => {
  const SPRINT = { id: 'sp', type: 'tap', key: 'Shift', mode: 'toggle', rx: 0.9, ry: 0.4 };

  it('ilk basış parmağı koyar, ikinci basış kaldırır; bırakışlar ve tekrarlar yok sayılır', () => {
    press([SPRINT], s, 'Shift');
    lift([SPRINT], s, 'Shift');
    press([SPRINT], s, 'Shift', { repeat: true });
    expect(s.calls).toEqual([['down', 900, 200, FIRST_TAP_POINTER_ID]]);
    press([SPRINT], s, 'Shift');
    expect(s.calls.at(-1)).toEqual(['up', 900, 200, FIRST_TAP_POINTER_ID]);
  });

  it('odak kaybında açık kalmış bas-aç tuşu da kalkar', () => {
    press([SPRINT], s, 'Shift');
    s.calls.length = 0;
    releaseKeymapperInput(W, s);
    expect(s.calls).toEqual([['up', 900, 200, FIRST_TAP_POINTER_ID]]);
  });
});

describe('fare tekerleği', () => {
  const SWAP = { id: 'sw', type: 'tap', key: 'WheelUp', rx: 0.3, ry: 0.3 };

  it('bağlı yöndeki tekerlek kısa bir basış yapar; ters yön ve bağsız düzen false döner', () => {
    vi.useFakeTimers();
    try {
      expect(handleKeymapperWheel(-100, W, [SWAP], s, DEVICE.w, DEVICE.h)).toBe(true);
      expect(s.calls).toEqual([['down', 300, 150, FIRST_TAP_POINTER_ID]]);
      vi.advanceTimersByTime(100);
      expect(s.calls.at(-1)).toEqual(['up', 300, 150, FIRST_TAP_POINTER_ID]);
      expect(handleKeymapperWheel(100, W, [SWAP], s, DEVICE.w, DEVICE.h)).toBe(false);
      expect(handleKeymapperWheel(-100, W, [], s, DEVICE.w, DEVICE.h)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('canlı etkinlik (rozetlerin yanması)', () => {
  it('basılı düğümler kümede görünür, bırakınca çıkar; dinleyici her değişimde çağrılır; küme her seferinde yenidir', () => {
    const seen = [];
    const unsubscribe = subscribeKeymapActivity(W, () => seen.push(getKeymapActivity(W)));
    press([JOYSTICK, FIRE], s, 'f');
    press([JOYSTICK, FIRE], s, 'w');
    const [afterFire, afterW] = seen;
    expect([...getKeymapActivity(W)].sort()).toEqual(['f', 'j', 'j:up']);
    expect(afterFire).not.toBe(afterW);
    lift([JOYSTICK, FIRE], s, 'f');
    lift([JOYSTICK, FIRE], s, 'w');
    expect(getKeymapActivity(W).size).toBe(0);
    unsubscribe();
    const count = seen.length;
    press([FIRE], s, 'f');
    expect(seen.length).toBe(count);
  });

  it('releaseKeymapperInput tüm etkinliği temizler', () => {
    press([JOYSTICK, FIRE], s, 'f');
    press([JOYSTICK, FIRE], s, 'd');
    releaseKeymapperInput(W, s);
    expect(getKeymapActivity(W).size).toBe(0);
  });
});

describe('nodesForKey (test modu: telefona hiçbir şey gitmeden hangi düğüm yanar)', () => {
  it('tuşa bağlı düğümleri ve joystick yönünü bulur', () => {
    const nodes = [JOYSTICK, FIRE, { ...JUMP, key: 'Space' }];
    expect(nodesForKey(nodes, 'f').map((m) => m.node.id)).toEqual(['f']);
    expect(nodesForKey(nodes, 'space').map((m) => m.node.id)).toEqual(['sp']);
    expect(nodesForKey(nodes, 'a')).toEqual([{ node: JOYSTICK, direction: 'left' }]);
    expect(nodesForKey(nodes, 'q')).toEqual([]);
  });
});

describe('devre dışı düğümler motorda yok sayılır', () => {
  it('devre dışı tuş basışa tepki vermez ve tuşu tüketmez; devre dışı joystick yön tuşlarını bırakır', () => {
    const off = { ...FIRE, enabled: false };
    expect(press([off], s, 'f')).toBe(false);
    expect(s.calls).toEqual([]);
    expect(press([{ ...JOYSTICK, enabled: false }], s, 'w')).toBe(false);
    expect(s.calls).toEqual([]);
    expect(press([{ ...JOYSTICK, enabled: true }], s, 'w')).toBe(true);
  });

  it('fare düğmesi / tekerlek / test modu / bakış alanı da devre dışı düğümü atlar', () => {
    const mouse = { id: 'm', type: 'tap', key: 'MouseLeft', rx: 0.8, ry: 0.5, enabled: false };
    expect(handleKeymapperMouseButton(0, true, W, [mouse], s, DEVICE.w, DEVICE.h)).toBe(false);
    expect(handleKeymapperWheel(-100, W, [{ ...mouse, key: 'WheelUp' }], s, DEVICE.w, DEVICE.h)).toBe(false);
    expect(nodesForKey([{ ...FIRE, enabled: false }], 'f')).toEqual([]);
    expect(lookRegion([{ type: 'look', rx: 0.1, ry: 0.1, radius: 0.1, enabled: false }], 1000, 500)).toEqual({ cx: 720, cy: 250, radius: 90 });   // varsayılan sağ yarı
    expect(s.calls).toEqual([]);
  });
});
