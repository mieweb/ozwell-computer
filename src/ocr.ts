import { spawn } from 'node:child_process';
import { ApiError, unsupported } from './errors.js';
import type { Frame } from './x11/capture.js';

/** A BGRX frame as binary PGM: tesseract works in grayscale, and PNM needs no compression. */
export function pgm({ width, height, data }: Frame): Buffer {
  const header = Buffer.from(`P5\n${width} ${height}\n255\n`, 'ascii');
  const out = Buffer.allocUnsafe(header.length + width * height);
  header.copy(out);
  for (let i = 0, o = header.length; i < data.length; i += 4, o++) out[o] = (data[i] * 29 + data[i + 1] * 150 + data[i + 2] * 77) >> 8;
  return out;
}

/** Extract text from a captured frame with the tesseract CLI. */
export function ocr(frame: Frame): Promise<string> {
  return new Promise((resolve, reject) => {
    // OpenMP threads busy-wait: ~3.5x the CPU for no faster result on a screenshot.
    const child = spawn('tesseract', ['stdin', 'stdout'], { timeout: 60_000, env: { ...process.env, OMP_THREAD_LIMIT: '1' } });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on('data', (b: Buffer) => out.push(b));
    child.stderr.on('data', (b: Buffer) => err.push(b));
    // EPIPE when tesseract is missing or exits early; the 'error'/'close' handlers report it.
    child.stdin.on('error', () => undefined);
    child.once('error', (e: NodeJS.ErrnoException) =>
      reject(e.code === 'ENOENT' ? unsupported('ocr', 'tesseract is not installed (Debian package tesseract-ocr)') : e));
    child.once('close', (code) => {
      if (code === 0) return resolve(Buffer.concat(out).toString('utf8').trim());
      reject(new ApiError('internal', `tesseract failed: ${Buffer.concat(err).toString('utf8').trim() || `exit ${code}`}`));
    });
    child.stdin.end(pgm(frame));
  });
}
