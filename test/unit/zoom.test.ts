import { describe, expect, it } from 'vitest';
import { MAX_ZOOM, fit, pinch, type Size } from '../../web/src/zoom.js';

// A 400×300 viewport showing a 16:9 desktop letterboxed to 400×225.
const s: Size = { w: 400, h: 300, cw: 400, ch: 225 };
// Where the desktop point under (cx, cy) is, as a fraction of the desktop.
const at = (v: { z: number; x: number; y: number }, cx: number, cy: number) => {
  const eh = Math.max(s.h, s.ch * v.z);
  return [(v.x + cx) / (s.cw * v.z), (v.y + cy - (eh - s.ch * v.z) / 2) / (s.ch * v.z)];
};

describe('pinch zoom', () => {
  it('keeps the desktop point under the pinch centre in place', () => {
    const z1 = { z: 1, x: 0, y: 0 };
    const v = pinch(z1, 2, 100, 150, s);
    expect(v.z).toBe(2);
    expect(at(v, 100, 150).map((n) => n.toFixed(6))).toEqual(at(z1, 100, 150).map((n) => n.toFixed(6)));
    expect(fit(pinch(v, 0.5, 100, 150, s), s)).toEqual({ z: 1, x: 0, y: 0 });
  });

  it('clamps the zoom and stops panning at the desktop edges, not the letterbox', () => {
    expect(pinch({ z: 1, x: 0, y: 0 }, 100, 0, 0, s).z).toBe(MAX_ZOOM);
    expect(pinch({ z: 1, x: 0, y: 0 }, 0.1, 0, 0, s).z).toBe(1);
    // At 2× the desktop is 800×450: the view can move 400 across and 150 down.
    expect(fit({ z: 2, x: -50, y: 900 }, s)).toEqual({ z: 2, x: 0, y: 150 });
    expect(fit({ z: 1, x: 40, y: 40 }, s)).toEqual({ z: 1, x: 0, y: 0 });
  });
});
