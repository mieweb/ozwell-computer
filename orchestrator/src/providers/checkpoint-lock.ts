// SQLite's OS locks work on both macOS and Linux. Every controller talking to the
// same Docker daemon must use this same LOCAL directory (never NFS/SMB).
import { DatabaseSync } from 'node:sqlite';
import { mkdir, chmod } from 'node:fs/promises';
import { join } from 'node:path';

export class CheckpointLock {
  private db?: DatabaseSync;
  readonly directory: string;
  constructor(directory: string) { this.directory = directory; }
  async run<T>(fn: () => Promise<T>): Promise<T> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    if (!this.db) {
      const path = join(this.directory, 'coordination.sqlite');
      this.db = new DatabaseSync(path);
      this.db.exec('PRAGMA busy_timeout=0');
      await chmod(path, 0o600);
    }
    const deadline = Date.now() + 120_000;
    for (;;) {
      try { this.db.exec('BEGIN IMMEDIATE'); break; }
      catch (error) {
        if (!/database is (?:locked|busy)/i.test(String(error)) || Date.now() >= deadline) throw error;
        await new Promise((r) => setTimeout(r, 50));
      }
    }
    try { return await fn(); } finally { this.db.exec('ROLLBACK'); }
  }
}
