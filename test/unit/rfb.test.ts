import { describe, expect, it } from 'vitest';
import { inflateSync } from 'node:zlib';
import { PixelConverter, NATIVE_PF, ZlibStream, zrleTiles, encodePixelFormat, decodePixelFormat, type PixelFormat } from '../../src/vnc/encodings.js';

/** Minimal reference ZRLE decoder (3-byte CPIXEL little-endian) for round-trip checks. */
function decodeZrle(data: Buffer, w: number, h: number, cb: number, readC: (b: Buffer, o: number) => number): number[] {
  const out = new Array(w * h).fill(-1);
  let o = 0;
  const rl = () => { let n = 1, b; do { b = data[o++]; n += b; } while (b === 255); return n; };
  for (let ty = 0; ty < h; ty += 64) for (let tx = 0; tx < w; tx += 64) {
    const tw = Math.min(64, w - tx), th = Math.min(64, h - ty);
    const set = (i: number, v: number) => { out[(ty + Math.floor(i / tw)) * w + tx + (i % tw)] = v; };
    const sub = data[o++];
    if (sub === 0) { for (let i = 0; i < tw * th; i++) { set(i, readC(data, o)); o += cb; } }
    else if (sub === 1) { const v = readC(data, o); o += cb; for (let i = 0; i < tw * th; i++) set(i, v); }
    else if (sub <= 16) {
      const pal = []; for (let i = 0; i < sub; i++) { pal.push(readC(data, o)); o += cb; }
      const bits = sub <= 2 ? 1 : sub <= 4 ? 2 : 4;
      for (let y = 0; y < th; y++) {
        let byte = 0, nb = 0;
        for (let x = 0; x < tw; x++) {
          if (nb === 0) { byte = data[o++]; nb = 8; }
          nb -= bits; set(y * tw + x, pal[(byte >> nb) & ((1 << bits) - 1)]);
        }
      }
    } else if (sub === 128) {
      let i = 0; while (i < tw * th) { const v = readC(data, o); o += cb; const n = rl(); for (let k = 0; k < n; k++) set(i++, v); }
    } else {
      const pal = []; for (let i = 0; i < sub - 128; i++) { pal.push(readC(data, o)); o += cb; }
      let i = 0; while (i < tw * th) { const b = data[o++]; const n = b & 128 ? rl() : 1; for (let k = 0; k < n; k++) set(i++, pal[b & 127]); }
    }
  }
  expect(o).toBe(data.length);
  return out;
}

const noVncPF: PixelFormat = { ...NATIVE_PF, redShift: 0, greenShift: 8, blueShift: 16 };

describe('pixel formats', () => {
  it('round-trips pixel format encoding', () => {
    expect(decodePixelFormat(encodePixelFormat(noVncPF))).toEqual(noVncPF);
  });
  it('converts to noVNC RGBX order', () => {
    const c = new PixelConverter(noVncPF);
    expect(c.cbpp).toBe(3);
    const raw = c.raw(Buffer.from([0x11, 0x22, 0x33, 0xff])); // B G R X
    expect([...raw]).toEqual([0x33, 0x22, 0x11, 0x00]);
  });
});

describe('ZRLE', () => {
  const make = (w: number, h: number, f: (x: number, y: number) => number) => {
    const px = new Uint32Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) px[y * w + x] = f(x, y) & 0xffffff;
    return px;
  };
  const cases: Array<[string, (x: number, y: number) => number]> = [
    ['solid', () => 0x123456],
    ['two colours', (x) => (x % 2 ? 0xffffff : 0)],
    ['16 colours', (x, y) => ((x + y) % 16) * 0x0f0f0f],
    ['runs', (x) => (x < 30 ? 0xff0000 : 0x00ff00)],
    ['palette rle', (x, y) => (Math.floor(x / 4) % 40) * 0x050505 + (y % 2)],
    ['noise', (x, y) => (x * 2654435761 + y * 40503) >>> 0],
  ];
  for (const [name, f] of cases) {
    it(`round-trips ${name} (odd size, multiple tiles)`, () => {
      const w = 131, h = 70;
      const px = make(w, h, f);
      const conv = new PixelConverter(noVncPF);
      const enc = zrleTiles(px, w, 0, 0, w, h, conv);
      const readC = (b: Buffer, o: number) => b[o] | (b[o + 1] << 8) | (b[o + 2] << 16);
      const dec = decodeZrle(enc, w, h, 3, readC);
      for (let i = 0; i < w * h; i++) expect(dec[i]).toBe(conv.value(px[i]));
    });
  }
  it('uses one persistent zlib stream', async () => {
    const z = new ZlibStream();
    const a = await z.compress(Buffer.from('hello'));
    const b = await z.compress(Buffer.from(' world'));
    expect(inflateSync(Buffer.concat([a, b]), { finishFlush: 2 }).toString()).toBe('hello world');
    z.close();
  });
});
