// Two-finger zoom on touch screens: take noVNC's `pinch` (and `twodrag` while zoomed) gestures and enlarge
// the #screen element noVNC scales to fit, so the canvas stays in normal layout and pointer mapping stays exact.
import { useEffect, type RefObject } from 'react';

export const MAX_ZOOM = 5;

export type View = { z: number; x: number; y: number };
/** The w×h viewport and the desktop's cw×ch size in it at 1× (letterboxed to its aspect). */
export type Size = { w: number; h: number; cw: number; ch: number };
type Gesture = { type: string; clientX: number; clientY: number; magnitudeX: number; magnitudeY: number };

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** The zoomed #screen: the desktop at z×, never smaller than the viewport (noVNC centres it inside). */
export const extent = (z: number, s: Size) => ({ w: Math.max(s.w, s.cw * z), h: Math.max(s.h, s.ch * z) });

/** Keep the zoom in range and the view inside the zoomed desktop. */
export const fit = ({ z, x, y }: View, s: Size): View => {
  const zz = clamp(z, 1, MAX_ZOOM);
  const e = extent(zz, s);
  return { z: zz, x: clamp(x, 0, e.w - s.w), y: clamp(y, 0, e.h - s.h) };
};

/** Zoom from `start` by `ratio`, keeping the desktop point at (cx, cy) in the viewport where it is. */
export const pinch = (start: View, ratio: number, cx: number, cy: number, s: Size): View => {
  const z = clamp(start.z * ratio, 1, MAX_ZOOM);
  const e0 = extent(start.z, s), e = extent(z, s);
  // The point under the centre as a fraction of the desktop, then where that lands at the new zoom.
  const u = (start.x + cx - (e0.w - s.cw * start.z) / 2) / (s.cw * start.z);
  const v = (start.y + cy - (e0.h - s.ch * start.z) / 2) / (s.ch * start.z);
  return { z, x: u * s.cw * z + (e.w - s.cw * z) / 2 - cx, y: v * s.ch * z + (e.h - s.ch * z) / 2 - cy };
};

export function usePinchZoom(wrapRef: RefObject<HTMLElement | null>, screenRef: RefObject<HTMLElement | null>, enabled: boolean, onChange: () => void) {
  useEffect(() => {
    const wrap = wrapRef.current!;
    const screen = screenRef.current!;
    let view: View = { z: 1, x: 0, y: 0 };
    let start: { view: View; d: number; cx: number; cy: number } | null = null;
    const size = (): Size => {
      const w = wrap.clientWidth, h = wrap.clientHeight;
      const c = screen.querySelector('canvas');
      const aspect = c?.width && c.height ? c.width / c.height : w / h;
      return { w, h, cw: Math.min(w, h * aspect), ch: Math.min(h, w / aspect) };
    };
    const apply = (next: View) => {
      const s = size();
      const measurable = s.w > 0 && s.h > 0;
      // Hidden (e.g. on the Jobs tab): keep the zoom for when the desktop is shown again; only a reset applies.
      if (!measurable && next.z > 1) return;
      view = measurable ? fit(next, s) : { z: 1, x: 0, y: 0 };
      const zoomed = view.z > 1;
      const e = extent(view.z, s);
      Object.assign(screen.style, {
        right: zoomed ? 'auto' : '', bottom: zoomed ? 'auto' : '',
        left: zoomed ? `${-view.x}px` : '', top: zoomed ? `${-view.y}px` : '',
        width: zoomed ? `${e.w}px` : '', height: zoomed ? `${e.h}px` : '',
      });
      onChange();
    };
    const handle = (e: Event) => {
      const g = (e as CustomEvent<Gesture>).detail;
      // At 1× a two-finger drag stays noVNC's remote scroll.
      if (g.type !== 'pinch' && !(g.type === 'twodrag' && (view.z > 1 || start))) return;
      e.stopPropagation();
      if (e.type === 'gestureend') { start = null; return; }
      const r = wrap.getBoundingClientRect();
      const cx = g.clientX - r.left, cy = g.clientY - r.top;
      if (e.type === 'gesturestart') { start = { view, d: Math.hypot(g.magnitudeX, g.magnitudeY) || 1, cx, cy }; return; }
      if (!start) return;
      apply(g.type === 'pinch'
        ? pinch(start.view, Math.hypot(g.magnitudeX, g.magnitudeY) / start.d, start.cx, start.cy, size())
        : { ...start.view, x: start.view.x - g.magnitudeX, y: start.view.y - g.magnitudeY });
    };
    apply({ z: 1, x: 0, y: 0 });
    if (!enabled) return;
    const types = ['gesturestart', 'gesturemove', 'gestureend'];
    // Capture phase: noVNC's listeners are on the canvas, below the wrapper.
    for (const t of types) wrap.addEventListener(t, handle, true);
    const resized = new ResizeObserver(() => apply(view));
    resized.observe(wrap);
    return () => {
      for (const t of types) wrap.removeEventListener(t, handle, true);
      resized.disconnect();
    };
  }, [wrapRef, screenRef, enabled, onChange]);
}
