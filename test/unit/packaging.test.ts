import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

const read = (p: string) => readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');

describe('maintainer scripts', () => {
  // In-app upgrades run dpkg inside ozwell-computer-upgrade.service; stopping or
  // restarting it from a maintainer script would kill the upgrade halfway.
  it.each(['contrib/postinst', 'contrib/prerm', 'contrib/postrm'])('%s never stops or restarts the upgrade service', (f) => {
    const code = read(f).split('\n').filter((l) => !l.trim().startsWith('#')).join('\n');
    const units = /^UNITS="([^"]*)"/m.exec(code)?.[1] ?? '';
    expect(units).not.toContain('ozwell-computer-upgrade.service');
    expect(code).not.toMatch(/systemctl[^\n]*(stop|restart|kill|disable)[^\n]*ozwell-computer-upgrade\.service/);
  });

  it('postinst restarts the upgrade watcher on upgrade so a new .path takes effect', () => {
    expect(read('contrib/postinst')).toMatch(/try-restart ozwell-computer-upgrade\.path/);
  });

  it('the upgrade service cannot time out mid-transaction, and the script recovers and waits for locks', () => {
    expect(read('contrib/systemd/ozwell-computer-upgrade.service')).toMatch(/^TimeoutStartSec=infinity$/m);
    const sh = read('contrib/upgrade.sh');
    expect(sh).toContain('dpkg --configure -a');
    expect(sh).toContain('DPkg::Lock::Timeout');
  });
});

describe('package-version', () => {
  const script = fileURLToPath(new URL('../../package-version', import.meta.url));
  const repo = mkdtempSync(join(tmpdir(), 'oz-pkgver-'));
  const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgSign=false', '-c', 'tag.gpgSign=false', ...args], { cwd: repo, encoding: 'utf8' }).trim();
  const version = (fmt: string) => execFileSync(script, [fmt], { cwd: repo, encoding: 'utf8' }).trim();
  afterAll(() => rmSync(repo, { recursive: true, force: true }));

  it('ignores the rolling nightly tag, so main builds get growing snapshot versions', () => {
    git('init', '-q');
    git('commit', '-q', '--allow-empty', '-m', 'a');
    git('tag', 'v1.2.3');
    git('commit', '-q', '--allow-empty', '-m', 'b');
    git('commit', '-q', '--allow-empty', '-m', 'c');
    git('tag', 'nightly');
    const hash = git('rev-parse', '--short', 'HEAD');
    expect(version('deb')).toBe(`1.2.3+2.g${hash}`);
    expect(version('node')).toBe(`1.2.3+2.g${hash}`);
  });
});
