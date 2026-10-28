// Update check and package upgrade.
//
// The installed version comes from dpkg; the latest from the `Packages` index of the
// flat APT repository attached to GitHub releases (OZWELL_COMPUTER_UPDATE_URL overrides
// it, "off" disables). Upgrading is privileged, so the server only drops a request file
// into its state directory; the packaged ozwell-computer-upgrade.path unit (root) sees it
// and runs ozwell-computer-upgrade, which writes upgrade.status / upgrade.log back here.
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import type { Logger } from 'pino';
import { ApiError } from './errors.js';

const run = promisify(execFile);

export const DEFAULT_UPDATE_URL = 'https://github.com/mieweb/ozwell-computer/releases/latest/download/Packages';
export const PACKAGE = 'ozwell-computer';
const STATE_DIR = '/var/lib/ozwell-computer';
const PATH_UNIT = '/usr/lib/systemd/system/ozwell-computer-upgrade.path';
const CHECK_INTERVAL_MS = 6 * 3600_000;

export interface PackageEntry { version: string; architecture: string }

/** Versions of `name` listed in an APT `Packages` index. */
export function parsePackages(text: string, name = PACKAGE): PackageEntry[] {
  const out: PackageEntry[] = [];
  for (const stanza of text.split(/\n\s*\n/)) {
    const field = (f: string) => new RegExp(`^${f}:\\s*(.+)$`, 'mi').exec(stanza)?.[1]?.trim();
    if (field('Package') !== name) continue;
    const version = field('Version');
    if (version) out.push({ version, architecture: field('Architecture') ?? 'all' });
  }
  return out;
}

/** Newest entry for this architecture, given a dpkg-style "a < b" comparison. */
export async function newest(entries: PackageEntry[], arch: string, lt: (a: string, b: string) => Promise<boolean>): Promise<string | null> {
  let best: string | null = null;
  for (const e of entries) {
    if (e.architecture !== arch && e.architecture !== 'all') continue;
    if (best === null || (await lt(best, e.version))) best = e.version;
  }
  return best;
}

export type UpgradeState = 'idle' | 'requested' | 'running' | 'succeeded' | 'unchanged' | 'failed';

export interface UpdateStatus {
  supported: boolean;
  limitation?: string;
  url: string | null;
  current: string | null;
  latest: string | null;
  available: boolean;
  checked_at: string | null;
  error: string | null;
  upgrade: { state: UpgradeState; at: string | null; log: string };
}

export class Updater {
  private current: string | null = null;
  private arch = 'all';
  private latest: string | null = null;
  private checkedAt: Date | null = null;
  private error: string | null = null;
  private limitation: string | null = null;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private url: string | null,
    private log: Logger,
    private onChange: (s: UpdateStatus) => void = () => undefined,
    private stateDir = STATE_DIR,
  ) {}

  private lt = async (a: string, b: string) => {
    try { await run('dpkg', ['--compare-versions', a, 'lt', b]); return true; } catch { return false; }
  };

  async start() {
    if (!this.url) { this.limitation = 'update checks are disabled (OZWELL_COMPUTER_UPDATE_URL=off)'; return; }
    try {
      this.current = (await run('dpkg-query', ['-W', '-f=${Version}', PACKAGE])).stdout.trim() || null;
      this.arch = (await run('dpkg', ['--print-architecture'])).stdout.trim();
    } catch {
      this.limitation = `not installed from the ${PACKAGE} Debian package`;
      return;
    }
    if (!existsSync(PATH_UNIT)) this.limitation = 'the ozwell-computer-upgrade.path unit is not installed';
    await this.check().catch(() => undefined);
    this.timer = setInterval(() => void this.check().catch(() => undefined), CHECK_INTERVAL_MS);
    this.timer.unref();
  }

  stop() { if (this.timer) clearInterval(this.timer); }

  /** Fetch the release index and compare. Errors are recorded in the status, not thrown. */
  async check(): Promise<UpdateStatus> {
    if (!this.url || this.current === null) return this.status();
    const before = this.latest;
    try {
      let text: string;
      if (this.url.startsWith('file://')) {
        text = await readFile(fileURLToPath(this.url), 'utf8'); // local/offline mirrors
      } else {
        const res = await fetch(this.url, { signal: AbortSignal.timeout(15_000), redirect: 'follow' });
        if (!res.ok) throw new Error(`${this.url} returned HTTP ${res.status}`);
        text = await res.text();
      }
      this.latest = await newest(parsePackages(text), this.arch, this.lt);
      this.error = this.latest ? null : `${this.url} lists no ${PACKAGE} package for ${this.arch}`;
    } catch (e) {
      this.error = (e as Error).message;
    }
    this.checkedAt = new Date();
    const s = await this.status();
    if (s.latest !== before || this.error) this.log.info({ current: s.current, latest: s.latest, error: this.error }, 'update check');
    this.onChange(s);
    return s;
  }

  private async upgradeState(): Promise<UpdateStatus['upgrade']> {
    const [statusText, logText, requested] = await Promise.all([
      readFile(join(this.stateDir, 'upgrade.status'), 'utf8').catch(() => ''),
      readFile(join(this.stateDir, 'upgrade.log'), 'utf8').catch(() => ''),
      stat(join(this.stateDir, 'upgrade-request')).then(() => true, () => false),
    ]);
    let [state, at] = statusText.trim().split(/\s+/);
    let log = logText;
    // "running" with no upgrade service running means the run was interrupted
    // (container stopped, service killed); the next run repairs dpkg first.
    if (state === 'running' && !requested && !(await this.upgradeUnitActive())) {
      state = 'failed';
      log += '\n(interrupted: the upgrade stopped before finishing; retry to complete it)\n';
    }
    return {
      state: requested ? 'requested' : (['running', 'succeeded', 'unchanged', 'failed'].includes(state) ? state as UpgradeState : 'idle'),
      at: at ? new Date(Number(at) * 1000).toISOString() : null,
      log: log.slice(-4000),
    };
  }

  private async upgradeUnitActive(): Promise<boolean> {
    try {
      const { stdout } = await run('systemctl', ['is-active', 'ozwell-computer-upgrade.service']);
      return ['active', 'activating', 'reloading'].includes(stdout.trim());
    } catch (e) {
      // is-active exits non-zero when inactive; anything else (no systemctl): assume running
      const out = String((e as { stdout?: string }).stdout ?? '').trim();
      return !['inactive', 'failed', 'unknown'].includes(out);
    }
  }

  async status(): Promise<UpdateStatus> {
    const supported = this.limitation === null && this.current !== null;
    let available = false;
    if (this.current && this.latest) available = await this.lt(this.current, this.latest);
    return {
      supported,
      ...(this.limitation ? { limitation: this.limitation } : {}),
      url: this.url,
      current: this.current,
      latest: this.latest,
      available,
      checked_at: this.checkedAt?.toISOString() ?? null,
      error: this.error,
      upgrade: supported ? await this.upgradeState() : { state: 'idle', at: null, log: '' },
    };
  }

  /** Ask the root upgrade unit to upgrade the package. */
  async apply(): Promise<UpdateStatus> {
    const s = await this.status();
    if (!s.supported) throw new ApiError('feature_unsupported', `upgrades are unavailable: ${s.limitation}`, { feature: 'update' });
    if (s.upgrade.state === 'requested' || s.upgrade.state === 'running') return s;
    await writeFile(join(this.stateDir, 'upgrade-request'), `${new Date().toISOString()}\n`);
    this.log.info({ current: s.current, latest: s.latest }, 'upgrade requested');
    const next = await this.status();
    this.onChange(next);
    return next;
  }
}
