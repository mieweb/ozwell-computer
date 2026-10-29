import { spawn } from 'node:child_process';
import { ApiError, unsupported } from './errors.js';

/** Extract text from an encoded image with the tesseract CLI. */
export function ocr(image: Buffer): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('tesseract', ['stdin', 'stdout'], { timeout: 60_000 });
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
    child.stdin.end(image);
  });
}
