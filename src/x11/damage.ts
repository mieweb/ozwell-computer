import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import type { XSession } from './connection.js';
import { captureRect, type Rect } from './capture.js';

const TILE = 64;
const POLL_MS = 100;

/** Merge a rectangle into a list, collapsing to a bounding box when it gets long. */
export function addRect(list: Rect[], r: Rect, maxRects = 32): Rect[] {
  if (r.w <= 0 || r.h <= 0) return list;
  // Drop if contained; absorb contained ones.
  for (const o of list) if (r.x >= o.x && r.y >= o.y && r.x + r.w <= o.x + o.w && r.y + r.h <= o.y + o.h) return list;
  const out = list.filter((o) => !(o.x >= r.x && o.y >= r.y && o.x + o.w <= r.x + r.w && o.y + o.h <= r.y + r.h));
  out.push(r);
  if (out.length > maxRects) return [boundingBox(out)];
  return out;
}

export function boundingBox(list: Rect[]): Rect {
  let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
  for (const r of list) {
    x1 = Math.min(x1, r.x); y1 = Math.min(y1, r.y);
    x2 = Math.max(x2, r.x + r.w); y2 = Math.max(y2, r.y + r.h);
  }
  return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
}

/**
 * Emits 'damage' (Rect[]) for changed screen areas. Uses DAMAGE + XFIXES regions
 * when available, else polls with 64×64 tile hashing. Only active while it has
 * subscribers (acquire/release).
 */
export class DamageTracker extends EventEmitter {
  private refs = 0;
  private damageId = 0;
  private regionId = 0;
  private fetching = false;
  private again = false;
  private pollTimer: NodeJS.Timeout | null = null;
  private tileHashes: Map<number, string> = new Map();
  readonly mode: 'damage' | 'poll';
  private onEvent = (ev: any) => {
    if (ev.name === 'DamageNotify' && ev.damage === this.damageId) this.fetch();
  };

  constructor(private s: XSession) {
    super();
    this.setMaxListeners(100);
    this.mode = s.ext.damage && s.ext.fixes ? 'damage' : 'poll';
  }

  acquire() {
    if (this.refs++ > 0) return;
    if (this.mode === 'damage') {
      const D = this.s.ext.damage, F = this.s.ext.fixes;
      this.damageId = this.s.allocId();
      this.regionId = this.s.allocId();
      F.CreateRegion(this.regionId, []);
      D.Create(this.damageId, this.s.root, 3 /* NonEmpty */);
      this.s.on('xevent', this.onEvent);
    } else {
      this.tileHashes.clear();
      this.pollTimer = setInterval(() => void this.poll(), POLL_MS);
    }
  }

  release() {
    if (--this.refs > 0) return;
    this.refs = 0;
    if (this.mode === 'damage') {
      this.s.off('xevent', this.onEvent);
      if (!this.s.closed) {
        try { this.s.ext.damage.Destroy(this.damageId); this.s.ext.fixes.DestroyRegion(this.regionId); } catch { /* ignore */ }
      }
    } else if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  private fetch() {
    if (this.fetching) { this.again = true; return; }
    this.fetching = true;
    // Move accumulated damage into our region (re-arms NonEmpty reporting), then read it.
    this.s.ext.damage.Subtract(this.damageId, 0, this.regionId);
    this.s.ext.fixes.FetchRegion(this.regionId, (err: unknown, reg: any) => {
      this.fetching = false;
      if (!err && reg?.rectangles?.length) {
        this.emit('damage', reg.rectangles.map((r: any) => ({ x: r.x, y: r.y, w: r.width, h: r.height })));
      }
      if (this.again) { this.again = false; this.fetch(); }
    });
  }

  private polling = false;
  private async poll() {
    if (this.polling || this.s.closed) return;
    this.polling = true;
    try {
      const f = await captureRect(this.s);
      const rects: Rect[] = [];
      const cols = Math.ceil(f.width / TILE), rows = Math.ceil(f.height / TILE);
      for (let ty = 0; ty < rows; ty++) {
        for (let tx = 0; tx < cols; tx++) {
          const x = tx * TILE, y = ty * TILE, w = Math.min(TILE, f.width - x), h = Math.min(TILE, f.height - y);
          const hash = createHash('sha1');
          for (let r = 0; r < h; r++) {
            const o = ((y + r) * f.width + x) * 4;
            hash.update(f.data.subarray(o, o + w * 4));
          }
          const d = hash.digest('base64');
          const key = ty * 65536 + tx;
          if (this.tileHashes.get(key) !== d) {
            this.tileHashes.set(key, d);
            rects.push({ x, y, w, h });
          }
        }
      }
      if (rects.length) this.emit('damage', rects.length > 64 ? [boundingBox(rects)] : rects);
    } catch { /* display gone */ } finally {
      this.polling = false;
    }
  }
}
