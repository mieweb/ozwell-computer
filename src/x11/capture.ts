import { call, type XSession } from './connection.js';

/** Canonical frame: 32bpp, bytes B,G,R,X per pixel, stride = width*4. */
export interface Frame {
  width: number;
  height: number;
  data: Buffer;
}

export interface Rect { x: number; y: number; w: number; h: number }

const ZPixmap = 2;
const STRIP_BYTES = 4 * 1024 * 1024;

function isCanonical(s: XSession): boolean {
  const p = s.pixel;
  return p.bitsPerPixel === 32 && !p.bigEndian && p.redShift === 16 && p.greenShift === 8 && p.blueShift === 0 && p.redMax === 255;
}

/** Convert one server-native ZPixmap strip into canonical BGRX. */
function convertStrip(s: XSession, src: Buffer, w: number, h: number, dst: Buffer, dstOffset: number) {
  const p = s.pixel;
  const bpp = p.bitsPerPixel;
  const pad = 32; // scanline pad for ZPixmap on all practical servers
  const srcStride = Math.ceil((w * bpp) / pad) * (pad / 8);
  if (isCanonical(s)) {
    if (srcStride === w * 4) src.copy(dst, dstOffset, 0, w * h * 4);
    else for (let y = 0; y < h; y++) src.copy(dst, dstOffset + y * w * 4, y * srcStride, y * srcStride + w * 4);
    return;
  }
  const scale = (v: number, max: number) => (max === 255 ? v : Math.round((v * 255) / (max || 1)));
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let px: number;
      const o = y * srcStride + (x * bpp) / 8;
      if (bpp === 32) px = p.bigEndian ? src.readUInt32BE(o) : src.readUInt32LE(o);
      else if (bpp === 16) px = p.bigEndian ? src.readUInt16BE(o) : src.readUInt16LE(o);
      else if (bpp === 24) px = p.bigEndian ? (src[o] << 16) | (src[o + 1] << 8) | src[o + 2] : src[o] | (src[o + 1] << 8) | (src[o + 2] << 16);
      else px = src[o];
      const d = dstOffset + (y * w + x) * 4;
      dst[d] = scale((px >>> p.blueShift) & p.blueMax, p.blueMax);
      dst[d + 1] = scale((px >>> p.greenShift) & p.greenMax, p.greenMax);
      dst[d + 2] = scale((px >>> p.redShift) & p.redMax, p.redMax);
      dst[d + 3] = 255;
    }
  }
}

export function clampRect(r: Rect, width: number, height: number): Rect | null {
  const x = Math.max(0, Math.floor(r.x));
  const y = Math.max(0, Math.floor(r.y));
  const x2 = Math.min(width, Math.ceil(r.x + r.w));
  const y2 = Math.min(height, Math.ceil(r.y + r.h));
  if (x2 <= x || y2 <= y) return null;
  return { x, y, w: x2 - x, h: y2 - y };
}

/** Grab a region of the root window. Large regions are fetched in strips. */
export async function captureRect(s: XSession, rect?: Rect): Promise<Frame & { x: number; y: number }> {
  const r = clampRect(rect ?? { x: 0, y: 0, w: s.width, h: s.height }, s.width, s.height);
  if (!r) throw new RangeError('capture region is outside the screen');
  const out = Buffer.allocUnsafeSlow(r.w * r.h * 4); // unpooled: 4-byte aligned for Uint32Array views
  const rowsPerStrip = Math.max(1, Math.floor(STRIP_BYTES / (r.w * 4)));
  const strips: Promise<void>[] = [];
  for (let y = 0; y < r.h; y += rowsPerStrip) {
    const h = Math.min(rowsPerStrip, r.h - y);
    const off = y * r.w * 4;
    strips.push(
      call<any>(s.X, 'GetImage', ZPixmap, s.root, r.x, r.y + y, r.w, h, 0xffffffff).then((img) => {
        convertStrip(s, img.data, r.w, h, out, off);
      }),
    );
  }
  await Promise.all(strips);
  return { x: r.x, y: r.y, width: r.w, height: r.h, data: out };
}

export interface CursorImage {
  x: number; y: number; width: number; height: number; xhot: number; yhot: number; serial: number;
  /** Premultiplied ARGB32 (native uint32 per pixel). */
  argb: Buffer;
}

export async function getCursorImage(s: XSession): Promise<CursorImage | null> {
  if (!s.ext.fixes) return null;
  const img = await new Promise<any>((resolve, reject) =>
    s.ext.fixes.GetCursorImage((err: unknown, res: any) => (err ? reject(err) : resolve(res))),
  );
  return {
    x: img.x, y: img.y, width: img.width, height: img.height, xhot: img.xhot, yhot: img.yhot,
    serial: img.cursorSerial, argb: img.cursorImage,
  };
}

/** Alpha-blend a premultiplied ARGB cursor into a canonical BGRX frame positioned at (fx, fy). */
export function compositeCursor(frame: Frame & { x: number; y: number }, c: CursorImage): void {
  const ox = c.x - c.xhot - frame.x;
  const oy = c.y - c.yhot - frame.y;
  for (let cy = 0; cy < c.height; cy++) {
    const fy = oy + cy;
    if (fy < 0 || fy >= frame.height) continue;
    for (let cx = 0; cx < c.width; cx++) {
      const fx = ox + cx;
      if (fx < 0 || fx >= frame.width) continue;
      const px = c.argb.readUInt32LE((cy * c.width + cx) * 4);
      const a = px >>> 24;
      if (a === 0) continue;
      const d = (fy * frame.width + fx) * 4;
      const inv = 255 - a;
      frame.data[d] = Math.min(255, (px & 0xff) + ((frame.data[d] * inv) / 255) | 0);
      frame.data[d + 1] = Math.min(255, ((px >>> 8) & 0xff) + ((frame.data[d + 1] * inv) / 255) | 0);
      frame.data[d + 2] = Math.min(255, ((px >>> 16) & 0xff) + ((frame.data[d + 2] * inv) / 255) | 0);
    }
  }
}

/** Convert canonical BGRX to RGBA (alpha 255) for image encoders. */
export function bgrxToRgba(src: Buffer): Buffer {
  const out = Buffer.allocUnsafe(src.length);
  for (let i = 0; i < src.length; i += 4) {
    out[i] = src[i + 2];
    out[i + 1] = src[i + 1];
    out[i + 2] = src[i];
    out[i + 3] = 255;
  }
  return out;
}
