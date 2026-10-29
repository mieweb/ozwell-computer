import { describe, expect, it } from 'vitest';
import { createCapsLockRemap, type KeyLike } from '../../web/src/keyboard.js';

const NONE = { ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, repeat: false };
const CODES: Record<string, string> = { Control: 'ControlLeft', Shift: 'ShiftLeft', Alt: 'AltLeft', AltGraph: 'AltRight', Meta: 'MetaLeft', CapsLock: 'CapsLock' };
const ev = (type: string, key: string, mods: Partial<KeyLike>): KeyLike => ({ ...NONE, type, key, code: CODES[key] ?? `Key${key.toUpperCase()}`, ...mods });
const down = (key: string, mods: Partial<KeyLike> = {}) => ev('keydown', key, mods);
const up = (key: string, mods: Partial<KeyLike> = {}) => ev('keyup', key, mods);

/** Feeds events; returns what was sent ourselves and which events were left for noVNC. */
function run(events: KeyLike[]) {
  const sent: string[] = [];
  const remap = createCapsLockRemap((keysym, _code, d) => sent.push(`${keysym.toString(16)}${d === undefined ? ' tap' : d ? ' down' : ' up'}`));
  const passed = events.filter((e) => !remap.handle(e)).map((e) => `${e.type} ${e.key}`);
  return { sent, passed, remap };
}

describe('Caps Lock remaps', () => {
  it('passes keys whose keysym already reflects the remap (ctrl:nocaps) straight to noVNC', () => {
    // key "Control" with code "CapsLock": noVNC sends Control_L from event.key.
    const { sent, passed } = run([down('Control', { ctrlKey: true }), down('c', { ctrlKey: true }), up('c', { ctrlKey: true }), up('Control')]);
    expect(sent).toEqual([]);
    expect(passed).toEqual(['keydown Control', 'keydown c', 'keyup c', 'keyup Control']);
  });

  it('sends Control for Caps Lock acting as Ctrl (Chrome: flag shows on the next key)', () => {
    const { sent, passed } = run([down('CapsLock'), down('c', { ctrlKey: true }), up('c', { ctrlKey: true }), up('CapsLock', { ctrlKey: true })]);
    expect(sent).toEqual(['ffe3 down', 'ffe3 up']);
    expect(passed).toEqual(['keydown c', 'keyup c']);
  });

  it('sends Control for Caps Lock acting as Ctrl (Firefox: flag set on the press itself)', () => {
    const { sent } = run([down('CapsLock', { ctrlKey: true }), down('c', { ctrlKey: true }), up('c', { ctrlKey: true }), up('CapsLock')]);
    expect(sent).toEqual(['ffe3 down', 'ffe3 up']);
  });

  it('taps Control when the remapped key is pressed alone', () => {
    expect(run([down('CapsLock'), up('CapsLock', { ctrlKey: true })]).sent).toEqual(['ffe3 tap']);
  });

  it('sends a plain Caps Lock as Caps_Lock', () => {
    expect(run([down('CapsLock'), up('CapsLock')]).sent).toEqual(['ffe5 tap']);
    const typed = run([down('CapsLock'), down('a'), up('a'), up('CapsLock')]);
    expect(typed.sent).toEqual(['ffe5 tap']);
    expect(typed.passed).toEqual(['keydown a', 'keyup a']);
  });

  it('does not mistake a real held modifier for the remap', () => {
    const { sent, passed } = run([
      down('Control', { ctrlKey: true }), down('CapsLock', { ctrlKey: true }), up('CapsLock', { ctrlKey: true }), up('Control'),
      down('Shift', { shiftKey: true }), up('Shift'),
      down('AltGraph'), down('@'), up('@'), up('AltGraph'),
    ]);
    expect(sent).toEqual(['ffe5 tap']);
    expect(passed).toEqual(['keydown Control', 'keyup Control', 'keydown Shift', 'keyup Shift', 'keydown AltGraph', 'keydown @', 'keyup @', 'keyup AltGraph']);
  });

  it('a real modifier pressed after Caps Lock resolves it as Caps_Lock', () => {
    expect(run([down('CapsLock'), down('Shift', { shiftKey: true }), up('Shift'), up('CapsLock')]).sent).toEqual(['ffe5 tap']);
  });

  it('releases the remapped modifier when focus is lost', () => {
    const { sent, remap } = run([down('CapsLock', { ctrlKey: true })]);
    remap.reset();
    expect(sent).toEqual(['ffe3 down', 'ffe3 up']);
  });

  it('ignores auto-repeat of the remapped key', () => {
    const { sent } = run([down('CapsLock', { ctrlKey: true }), down('CapsLock', { ctrlKey: true, repeat: true }), up('CapsLock')]);
    expect(sent).toEqual(['ffe3 down', 'ffe3 up']);
  });

  it('keeps Control down remotely while either Caps Lock or the physical Left Ctrl is held', () => {
    const C = { ctrlKey: true };
    // Caps first, then physical Ctrl: Caps Lock's release leaves it to the physical key.
    const a = run([down('CapsLock', C), down('Control', C), up('CapsLock', C), up('Control')]);
    expect(a.sent).toEqual(['ffe3 down']);
    expect(a.passed).toEqual(['keydown Control', 'keyup Control']);
    // Physical Ctrl released while Caps Lock still holds Ctrl: that release is held back until Caps Lock's.
    const b = run([down('CapsLock', C), down('Control', C), up('Control', C), down('c', C), up('CapsLock', C)]);
    expect(b.sent).toEqual(['ffe3 down', 'ffe3 up']);
    expect(b.passed).toEqual(['keydown Control', 'keydown c']);
    // Right Ctrl is a different keysym, so both are sent as usual.
    const c = run([down('CapsLock', C), down('Control', { ...C, code: 'ControlRight' }), up('Control', { ...C, code: 'ControlRight' }), up('CapsLock')]);
    expect(c.sent).toEqual(['ffe3 down', 'ffe3 up']);
    expect(c.passed).toEqual(['keydown Control', 'keyup Control']);
  });

  it('tracks left and right Shift separately', () => {
    const S = { shiftKey: true };
    const { sent } = run([
      down('Shift', S), down('Shift', { ...S, code: 'ShiftRight' }), up('Shift', { ...S, code: 'ShiftRight' }),
      down('CapsLock', S), up('CapsLock', S), up('Shift'),
    ]);
    expect(sent).toEqual(['ffe5 tap']);
  });

  it('does not mistake the Ctrl+Alt flags of a held AltGr for the remap', () => {
    const G = { ctrlKey: true, altKey: true };
    expect(run([down('AltGraph', G), down('CapsLock', G), up('CapsLock', G), up('AltGraph')]).sent).toEqual(['ffe5 tap']);
  });

  it('settles a pending Caps Lock from a pointer event before noVNC sends the click', () => {
    const { sent, remap } = run([down('CapsLock')]);
    remap.pointer({ ...NONE, ctrlKey: true });
    expect(sent).toEqual(['ffe3 down']);
    remap.handle(up('CapsLock', { ctrlKey: true }));
    expect(sent).toEqual(['ffe3 down', 'ffe3 up']);
  });
});
