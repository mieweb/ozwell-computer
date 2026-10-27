import type { Frame } from './x11/capture.js';
import { bgrxToRgba } from './x11/capture.js';

export type ImageFormat = 'png' | 'jpeg' | 'webp';

let sharpMod: any | null | undefined;
async function loadSharp(): Promise<any | null> {
  if (sharpMod !== undefined) return sharpMod;
  try {
    sharpMod = (await import('sharp')).default;
    // Every screenshot is a new image, so libvips' operation cache never hits; it only
    // holds native memory. One thread per image is plenty and keeps allocator arenas down.
    sharpMod.cache(false);
    sharpMod.concurrency(1);
  } catch {
    sharpMod = null;
  }
  return sharpMod;
}

export async function imageBackend(): Promise<'sharp' | 'pngjs'> {
  return (await loadSharp()) ? 'sharp' : 'pngjs';
}

export const CONTENT_TYPES: Record<ImageFormat, string> = { png: 'image/png', jpeg: 'image/jpeg', webp: 'image/webp' };

/** Encode a canonical BGRX frame, optionally resizing to (outW, outH). */
export async function encodeFrame(frame: Frame, format: ImageFormat, opts: { quality?: number; width?: number; height?: number } = {}): Promise<{ data: Buffer; format: ImageFormat; width: number; height: number }> {
  const rgba = bgrxToRgba(frame.data);
  const outW = opts.width ?? frame.width;
  const outH = opts.height ?? frame.height;
  const sharp = await loadSharp();
  if (sharp) {
    let img = sharp(rgba, { raw: { width: frame.width, height: frame.height, channels: 4 } }).removeAlpha();
    if (outW !== frame.width || outH !== frame.height) img = img.resize(outW, outH, { fit: 'fill', kernel: 'lanczos3' });
    const q = opts.quality ?? 80;
    if (format === 'jpeg') img = img.jpeg({ quality: q, mozjpeg: false });
    else if (format === 'webp') img = img.webp({ quality: q });
    else img = img.png({ compressionLevel: 6 });
    return { data: await img.toBuffer(), format, width: outW, height: outH };
  }
  // Fallback: PNG only, nearest-neighbour resize.
  const { PNG } = await import('pngjs');
  let src = rgba, w = frame.width, h = frame.height;
  if (outW !== w || outH !== h) {
    const dst = Buffer.allocUnsafe(outW * outH * 4);
    for (let y = 0; y < outH; y++) {
      const sy = Math.min(h - 1, Math.floor((y * h) / outH));
      for (let x = 0; x < outW; x++) {
        const sx = Math.min(w - 1, Math.floor((x * w) / outW));
        rgba.copy(dst, (y * outW + x) * 4, (sy * w + sx) * 4, (sy * w + sx) * 4 + 4);
      }
    }
    src = dst; w = outW; h = outH;
  }
  const png = new PNG({ width: w, height: h });
  src.copy(png.data);
  return { data: PNG.sync.write(png), format: 'png', width: w, height: h };
}
