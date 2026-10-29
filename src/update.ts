// Update check and upgrade.
//
// Two channels, picked by OZWELL_COMPUTER_UPDATE_URL ("off" disables):
// - apt (release images): the installed version comes from dpkg; the latest from the
//   `Packages` index of the flat APT repository attached to GitHub releases.
// - git (`git+https://<repo>#<branch>`, :main images): the installed commit is the
//   REVISION file `make install` writes; the latest is the branch head (git ls-remote).
// Upgrading is privileged, so the server only drops a request file into its state
// directory; the packaged ozwell-computer-upgrade.path unit (root) sees it and runs
// ozwell-computer-upgrade, which writes upgrade.status / upgrade.log back here.
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
// The installed app (PREFIX): this file is PREFIX/dist/update.js.
const APP_DIR = fileURLToPath(new URL('..', import.meta.url));
const APT_CHECK_INTERVAL_MS = 6 * 3600_000;
// git ls-remote is cheap, so a push to the branch is offered within a minute.
const GIT_CHECK_INTERVAL_MS = 60_000;
const SHA = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
const GIT_URL = /^git\+(https:\/\/[^#\s]+)#([\w./-]+)$/;

export type UpdateSource = { kind: 'apt'; url: string } | { kind: 'git'; repo: string; branch: string };

export const isGitUpdateUrl = (url: string) => GIT_URL.test(url);

/** `git+https://<repo>#<branch>` builds that branch from git; anything else is an APT `Packages` index. */
export function parseUpdateSource(url: string): UpdateSource {
  const m = GIT_URL.exec(url);
  return m ? { kind: 'git', repo: m[1], branch: m[2] } : { kind: 'apt', url };
}

/** The commit `ref` points at in `git ls-remote` output. */
export function parseLsRemote(text: string, ref: string): string | null {
  return text.split('\n').map((l) => l.trim().split(/\s+/)).find(([sha, name]) => name === ref && SHA.test(sha))?.[0] ?? null;
}

/** Version and source commit of an app installed by `make install` from a git checkout. */
export async function readInstalled(appDir: string): Promise<{ version: string; revision: string } | null> {
  const revision = (await readFile(join(appDir, 'REVISION'), 'utf8').catch(() => '')).trim();
  if (!SHA.test(revision)) return null;
  const { version } = JSON.parse(await readFile(join(appDir, 'package.json'), 'utf8')) as { version: string };
  return { version, revision };
}

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
  /** git channel only: installed and branch-head commits. */
  revision?: { current: string; latest: string | null };
  upgrade: { state: UpgradeState; at: string | null; log: string };
}

export class Updater {
  private source: UpdateSource | null;
  private current: string | null = null;
  private currentRev: string | null = null;
  private arch = 'all';
  private latest: string | null = null;
  private latestRev: string | null = null;
  private checkedAt: Date | null = null;
  private error: string | null = null;
  private limitation: string | null = null;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private url: string | null,
    private log: Logger,
    private onChange: (s: UpdateStatus) => void = () => undefined,
    private stateDir = STATE_DIR,
    private appDir = APP_DIR,
  ) {
    this.source = url ? parseUpdateSource(url) : null;
  }

  private lt = async (a: string, b: string) => {
    try { await run('dpkg', ['--compare-versions', a, 'lt', b]); return true; } catch { return false; }
  };

  async start() {
    if (!this.source) { this.limitation = 'update checks are disabled (OZWELL_COMPUTER_UPDATE_URL=off)'; return; }
    this.limitation = this.source.kind === 'git' ? await this.detectBuild() : await this.detectPackage();
    if (this.limitation) return;
    if (!existsSync(PATH_UNIT)) this.limitation = 'the ozwell-computer-upgrade.path unit is not installed';
    await this.check().catch(() => undefined);
    const every = this.source.kind === 'git' ? GIT_CHECK_INTERVAL_MS : APT_CHECK_INTERVAL_MS;
    this.timer = setInterval(() => void this.check().catch(() => undefined), every);
    this.timer.unref();
  }

  stop() { if (this.timer) clearInterval(this.timer); }

  /** Installed package version; a limitation if not installed from the package. */
  private async detectPackage(): Promise<string | null> {
    try {
      this.current = (await run('dpkg-query', ['-W', '-f=${Version}', PACKAGE])).stdout.trim() || null;
      this.arch = (await run('dpkg', ['--print-architecture'])).stdout.trim();
      return null;
    } catch {
      return `not installed from the ${PACKAGE} Debian package`;
    }
  }

  /** Installed version and commit; a limitation if not installed from a git checkout. */
  private async detectBuild(): Promise<string | null> {
    const installed = await readInstalled(this.appDir);
    if (!installed) return `${join(this.appDir, 'REVISION')} is missing: not installed by make install from a git checkout`;
    this.current = installed.version;
    this.currentRev = installed.revision;
    return null;
  }

  protected async lsRemote(repo: string, ref: string): Promise<string> {
    const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
    return (await run('git', ['ls-remote', repo, ref], { timeout: 15_000, env })).stdout;
  }

  /** Check the source for something newer. Errors are recorded in the status, not thrown. */
  async check(): Promise<UpdateStatus> {
    if (!this.source || this.current === null) return this.status();
    const before = this.latest;
    try {
      if (this.source.kind === 'git') await this.checkGit(this.source.repo, this.source.branch);
      else await this.checkPackages(this.source.url);
    } catch (e) {
      this.error = (e as Error).message;
    }
    this.checkedAt = new Date();
    const s = await this.status();
    if (s.latest !== before || this.error) this.log.info({ current: s.current, latest: s.latest, error: this.error }, 'update check');
    this.onChange(s);
    return s;
  }

  private async checkPackages(url: string) {
    let text: string;
    if (url.startsWith('file://')) {
      text = await readFile(fileURLToPath(url), 'utf8'); // local/offline mirrors
    } else {
      const res = await fetch(url, { signal: AbortSignal.timeout(15_000), redirect: 'follow' });
      if (!res.ok) throw new Error(`${url} returned HTTP ${res.status}`);
      text = await res.text();
    }
    this.latest = await newest(parsePackages(text), this.arch, this.lt);
    this.error = this.latest ? null : `${url} lists no ${PACKAGE} package for ${this.arch}`;
  }

  private async checkGit(repo: string, branch: string) {
    const ref = `refs/heads/${branch}`;
    const sha = parseLsRemote(await this.lsRemote(repo, ref), ref);
    if (!sha) throw new Error(`${repo} has no branch ${branch}`);
    this.latestRev = sha;
    this.latest = `${branch}@${sha.slice(0, 7)}`;
    this.error = null;
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
    const available = this.currentRev
      ? this.latestRev !== null && this.latestRev !== this.currentRev
      : this.current !== null && this.latest !== null && await this.lt(this.current, this.latest);
    return {
      supported,
      ...(this.limitation ? { limitation: this.limitation } : {}),
      url: this.url,
      current: this.current,
      latest: this.latest,
      available,
      checked_at: this.checkedAt?.toISOString() ?? null,
      error: this.error,
      ...(this.currentRev ? { revision: { current: this.currentRev, latest: this.latestRev } } : {}),
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
