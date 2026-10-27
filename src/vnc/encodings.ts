import { constants, createDeflate, type Deflate } from 'node:zlib';

export const ENC = {
  Raw: 0,
  CopyRect: 1,
  ZRLE: 16,
  DesktopSize: -223,
  LastRect: -224,
  Cursor: -239,
  ExtendedDesktopSize: -308,
} as const;

export interface PixelFormat {
  bitsPerPixel: number;
  depth: number;
  bigEndian: boolean;
  trueColour: boolean;
  redMax: number;
  greenMax: number;
  blueMax: number;
  redShift: number;
  greenShift: number;
  blueShift: number;
}

/** Server-native format: matches the canonical BGRX capture buffer byte order. */
export const NATIVE_PF: PixelFormat = {
  bitsPerPixel: 32, depth: 24, bigEndian: false, trueColour: true,
  redMax: 255, greenMax: 255, blueMax: 255, redShift: 16, greenShift: 8, blueShift: 0,
};

export function encodePixelFormat(pf: PixelFormat): Buffer {
  const b = Buffer.alloc(16);
  b[0] = pf.bitsPerPixel; b[1] = pf.depth; b[2] = pf.bigEndian ? 1 : 0; b[3] = pf.trueColour ? 1 : 0;
  b.writeUInt16BE(pf.redMax, 4); b.writeUInt16BE(pf.greenMax, 6); b.writeUInt16BE(pf.blueMax, 8);
  b[10] = pf.redShift; b[11] = pf.greenShift; b[12] = pf.blueShift;
  return b;
}

export function decodePixelFormat(b: Buffer, off = 0): PixelFormat {
  return {
    bitsPerPixel: b[off], depth: b[off + 1], bigEndian: b[off + 2] !== 0, trueColour: b[off + 3] !== 0,
    redMax: b.readUInt16BE(off + 4), greenMax: b.readUInt16BE(off + 6), blueMax: b.readUInt16BE(off + 8),
    redShift: b[off + 10], greenShift: b[off + 11], blueShift: b[off + 12],
  };
}

export function validPixelFormat(pf: PixelFormat): boolean {
  return pf.trueColour && [8, 16, 32].includes(pf.bitsPerPixel) && pf.redMax > 0 && pf.greenMax > 0 && pf.blueMax > 0 &&
    pf.redShift < pf.bitsPerPixel && pf.greenShift < pf.bitsPerPixel && pf.blueShift < pf.bitsPerPixel;
}

/** Converts canonical BGRX uint32 values (0x00RRGGBB) to client pixels. */
export class PixelConverter {
  readonly bpp: number; // bytes per pixel on the wire
  /** Bytes per CPIXEL in ZRLE. */
  readonly cbpp: number;
  /** For 3-byte CPIXELs: true when the 3 bytes are the most significant ones. */
  private cpixelHigh = false;
  private identity: boolean;
  constructor(readonly pf: PixelFormat) {
    this.bpp = pf.bitsPerPixel / 8;
    this.identity = pf.bitsPerPixel === 32 && !pf.bigEndian && pf.redShift === 16 && pf.greenShift === 8 && pf.blueShift === 0 &&
      pf.redMax === 255 && pf.greenMax === 255 && pf.blueMax === 255;
    this.full8 = pf.redMax === 255 && pf.greenMax === 255 && pf.blueMax === 255;
    const mask = (pf.redMax << pf.redShift) | (pf.greenMax << pf.greenShift) | (pf.blueMax << pf.blueShift);
    if (pf.bitsPerPixel === 32 && pf.depth <= 24) {
      if ((mask >>> 0) <= 0xffffff) { this.cbpp = 3; this.cpixelHigh = false; }
      else if (((mask >>> 0) & 0xff) === 0) { this.cbpp = 3; this.cpixelHigh = true; }
      else this.cbpp = 4;
    } else this.cbpp = this.bpp;
  }

  /** 0x00RRGGBB → client pixel value. Hot path: called per pixel. */
  value(rgb: number): number {
    if (this.identity) return rgb & 0xffffff;
    const pf = this.pf;
    const r = (rgb >>> 16) & 255, g = (rgb >>> 8) & 255, b = rgb & 255;
    if (this.full8) return ((r << pf.redShift) | (g << pf.greenShift) | (b << pf.blueShift)) >>> 0;
    return ((((r * pf.redMax + 127) / 255) | 0) << pf.redShift | (((g * pf.greenMax + 127) / 255) | 0) << pf.greenShift |
      (((b * pf.blueMax + 127) / 255) | 0) << pf.blueShift) >>> 0;
  }
  private full8: boolean;

  writePixel(buf: Buffer, off: number, v: number): number {
    const pf = this.pf;
    switch (this.bpp) {
      case 4: pf.bigEndian ? buf.writeUInt32BE(v, off) : buf.writeUInt32LE(v, off); return off + 4;
      case 2: pf.bigEndian ? buf.writeUInt16BE(v & 0xffff, off) : buf.writeUInt16LE(v & 0xffff, off); return off + 2;
      default: buf[off] = v & 0xff; return off + 1;
    }
  }

  writeCPixel(buf: Buffer, off: number, v: number): number {
    if (this.cbpp !== 3) return this.writePixel(buf, off, v);
    // 3-byte CPIXEL keeps the pixel's byte order minus the unused byte.
    const val = this.cpixelHigh ? v >>> 8 : v;
    if (this.pf.bigEndian) { buf[off] = (val >>> 16) & 255; buf[off + 1] = (val >>> 8) & 255; buf[off + 2] = val & 255; }
    else { buf[off] = val & 255; buf[off + 1] = (val >>> 8) & 255; buf[off + 2] = (val >>> 16) & 255; }
    return off + 3;
  }

  /** Convert a canonical BGRX buffer of w*h pixels to Raw encoding bytes. */
  raw(src: Buffer): Buffer {
    if (this.identity) return src;
    const n = src.length / 4;
    const out = Buffer.allocUnsafe(n * this.bpp);
    const px = new Uint32Array(src.buffer, src.byteOffset, n);
    let o = 0;
    for (let i = 0; i < n; i++) o = this.writePixel(out, o, this.value(px[i]));
    return out;
  }
}

/** View a canonical BGRX buffer as 0x00RRGGBB uint32 values (little-endian hosts). */
export function pixelsOf(buf: Buffer): Uint32Array {
  if (buf.byteOffset % 4 !== 0) {
    const copy = Buffer.allocUnsafeSlow(buf.length);
    buf.copy(copy);
    buf = copy;
  }
  return new Uint32Array(buf.buffer, buf.byteOffset, buf.length / 4);
}

class ByteWriter {
  buf: Buffer;
  pos = 0;
  constructor(size = 65536) { this.buf = Buffer.allocUnsafe(size); }
  ensure(n: number) {
    if (this.pos + n <= this.buf.length) return;
    const nb = Buffer.allocUnsafe(Math.max(this.buf.length * 2, this.pos + n));
    this.buf.copy(nb, 0, 0, this.pos);
    this.buf = nb;
  }
  u8(v: number) { this.ensure(1); this.buf[this.pos++] = v; }
  runLength(len: number) {
    let n = len - 1;
    this.ensure(Math.ceil((n + 1) / 255) + 1);
    while (n >= 255) { this.buf[this.pos++] = 255; n -= 255; }
    this.buf[this.pos++] = n;
  }
  result() { return this.buf.subarray(0, this.pos); }
}

/**
 * Encode one rectangle's ZRLE tile stream (before zlib). `px` is the full
 * frame (stride `stride` pixels); the rect is at (rx, ry, rw, rh) within it.
 */
export function zrleTiles(px: Uint32Array, stride: number, rx: number, ry: number, rw: number, rh: number, conv: PixelConverter): Buffer {
  const w = new ByteWriter(rw * rh * conv.cbpp + 1024);
  const tile = new Uint32Array(64 * 64);
  const palette = new Map<number, number>();
  for (let ty = 0; ty < rh; ty += 64) {
    const th = Math.min(64, rh - ty);
    for (let tx = 0; tx < rw; tx += 64) {
      const tw = Math.min(64, rw - tx);
      const n = tw * th;
      // Gather tile pixels in client value space; count colours (cap 128) and runs.
      palette.clear();
      let runs = 0, prev = -1;
      for (let y = 0; y < th; y++) {
        const base = (ry + ty + y) * stride + rx + tx;
        for (let x = 0; x < tw; x++) {
          const v = conv.value(px[base + x]);
          tile[y * tw + x] = v;
          if (v !== prev) {
            runs++;
            prev = v;
            if (palette.size <= 127 && !palette.has(v)) palette.set(v, palette.size);
          }
        }
      }
      const colours = palette.size;
      const cb = conv.cbpp;
      if (colours === 1) {
        w.u8(1);
        w.ensure(cb);
        w.pos = conv.writeCPixel(w.buf, w.pos, tile[0]);
        continue;
      }
      // Estimate sizes.
      const rawSize = n * cb;
      const bits = colours <= 2 ? 1 : colours <= 4 ? 2 : colours <= 16 ? 4 : 0;
      const packedSize = bits ? colours * cb + Math.ceil((tw * bits) / 8) * th : Infinity;
      const plainRleSize = runs * (cb + 1);
      const paletteRleSize = colours <= 127 ? colours * cb + runs * 2 : Infinity;
      const best = Math.min(rawSize, packedSize, plainRleSize, paletteRleSize);
      if (best === rawSize) {
        w.u8(0);
        w.ensure(rawSize);
        for (let i = 0; i < n; i++) w.pos = conv.writeCPixel(w.buf, w.pos, tile[i]);
      } else if (best === packedSize) {
        w.u8(colours);
        w.ensure(packedSize);
        for (const c of palette.keys()) w.pos = conv.writeCPixel(w.buf, w.pos, c);
        let lastV = -1, lastIdx = 0;
        for (let y = 0; y < th; y++) {
          let byte = 0, nbits = 0;
          for (let x = 0; x < tw; x++) {
            const v = tile[y * tw + x];
            if (v !== lastV) { lastV = v; lastIdx = palette.get(v)!; }
            byte = (byte << bits) | lastIdx;
            nbits += bits;
            if (nbits === 8) { w.buf[w.pos++] = byte; byte = 0; nbits = 0; }
          }
          if (nbits > 0) w.buf[w.pos++] = (byte << (8 - nbits)) & 0xff;
        }
      } else if (best === paletteRleSize) {
        w.u8(128 + colours);
        w.ensure(colours * cb);
        for (const c of palette.keys()) w.pos = conv.writeCPixel(w.buf, w.pos, c);
        let i = 0;
        while (i < n) {
          const v = tile[i];
          let j = i + 1;
          while (j < n && tile[j] === v) j++;
          const idx = palette.get(v)!;
          if (j - i === 1) w.u8(idx);
          else { w.u8(idx | 128); w.runLength(j - i); }
          i = j;
        }
      } else {
        w.u8(128);
        let i = 0;
        while (i < n) {
          const v = tile[i];
          let j = i + 1;
          while (j < n && tile[j] === v) j++;
          w.ensure(cb);
          w.pos = conv.writeCPixel(w.buf, w.pos, v);
          w.runLength(j - i);
          i = j;
        }
      }
    }
  }
  return w.result();
}

/** One persistent zlib stream per RFB connection, as ZRLE requires. */
export class ZlibStream {
  private z: Deflate;
  private chunks: Buffer[] = [];
  constructor(level = 1) {
    this.z = createDeflate({ level, memLevel: 9 });
    this.z.on('data', (c: Buffer) => this.chunks.push(c));
  }
  compress(data: Buffer): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      this.z.write(data, (err) => {
        if (err) return reject(err);
        this.z.flush(constants.Z_SYNC_FLUSH, () => {
          const out = Buffer.concat(this.chunks);
          this.chunks = [];
          resolve(out);
        });
      });
    });
  }
  close() { this.z.close(); }
}

export function rectHeader(x: number, y: number, w: number, h: number, enc: number): Buffer {
  const b = Buffer.allocUnsafe(12);
  b.writeUInt16BE(x, 0); b.writeUInt16BE(y, 2); b.writeUInt16BE(w, 4); b.writeUInt16BE(h, 6); b.writeInt32BE(enc, 8);
  return b;
}
