import { spawn } from 'node:child_process';
import { ApiError } from '../errors.js';

export function launchDetached(display: string | undefined, command: string, args: string[] = [], env: Record<string, string> = {}, cwd?: string) {
  return new Promise<{ pid: number }>((resolve, reject) => {
    const child = spawn(command, args, {
      detached: true, stdio: 'ignore', cwd: cwd || process.env.HOME || '/',
      env: { ...process.env, ...(display ? { DISPLAY: display } : {}), ...env },
    });
    child.once('error', (e: NodeJS.ErrnoException) =>
      reject(e.code === 'ENOENT' ? new ApiError('path_not_found', `command not found: ${command}`) : e));
    child.once('spawn', () => { child.unref(); resolve({ pid: child.pid! }); });
  });
}
