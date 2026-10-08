// Tuş eşleyici motoru: klavye → telefonda sanal parmak. Asıl risk, odak kaybında "keyup"ın hiç gelmemesi: parmak telefonda
// basılı kalır ve motor W'nin hâlâ basılı olduğunu sanır — oyuncu geri döndüğünde karakter artık yönlendirilemez.
import { beforeEach, describe, expect, it } from 'vitest';
import { handleKeymapperInput, releaseKeymapperInput } from '../src/keymapper/keymapperEngine.js';

const W = 'win-1';
const DEVICE = { w: 1000, h: 500 };
const JOYSTICK = { id: 'j', type: 'dpad', rx: 0.2, ry: 0.6, radius: 0.1 };
const FIRE = { id: 'f', type: 'tap', key: 'f', rx: 0.8, ry: 0.5 };
const JUMP = { id: 'sp', type: 'tap', key: 'Space', rx: 0.9, ry: 0.4 };

function socket() {
  const calls = [];
  return {
    calls,
    down: (x, y) => calls.push(['down', x, y]),
    move: (x, y) => calls.push(['move', x, y]),
    up: (x, y) => calls.push(['up', x, y]),
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
    expect(s.calls).toEqual([['down', 200, 300], ['move', 200, 250]]);
  });

  it('lifting the last direction key lifts the finger', () => {
    press([JOYSTICK], s, 'w');
    s.calls.length = 0;
    lift([JOYSTICK], s, 'w');
    expect(s.calls).toEqual([['up', 200, 250]]);
  });

  it('a tap key presses on keydown, ignores auto-repeat and lifts on keyup', () => {
    press([FIRE], s, 'f');
    press([FIRE], s, 'f', { repeat: true });
    lift([FIRE], s, 'f');
    expect(s.calls).toEqual([['down', 800, 250], ['up', 800, 250]]);
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
    expect(s.calls).toEqual([['up', 200, 250]]);
  });

  it('lifts every held tap, once', () => {
    press([FIRE, JUMP], s, 'f');
    press([FIRE, JUMP], s, ' ');
    s.calls.length = 0;
    releaseKeymapperInput(W, s);
    expect(s.calls).toHaveLength(2);
    expect(s.calls).toEqual(expect.arrayContaining([['up', 800, 250], ['up', 900, 200]]));

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
    expect(s.calls).toEqual([['down', 200, 300], ['move', 250, 300]]); // a fresh press, and only D (no stale W)
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
    expect(s.calls).toEqual([['up', 200, 250]]);
    expect(other.calls).toEqual([]);
    releaseKeymapperInput('win-2', other);
  });

  it('does nothing for a window that holds nothing, or without a socket', () => {
    expect(() => releaseKeymapperInput('never-seen', s)).not.toThrow();
    press([JOYSTICK], s, 'w');
    expect(() => releaseKeymapperInput(W, null)).not.toThrow();
  });
});
