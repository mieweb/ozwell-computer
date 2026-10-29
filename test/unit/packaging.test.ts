import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

describe('git update channel', () => {
  const sh = read('contrib/upgrade.sh');
  const git = /^from_git\(\) \{\n([\s\S]*?)\n\}$/m.exec(sh)?.[1] ?? '';

  it('upgrade.sh builds, then stops only the server while installing and starts it again', () => {
    const order = ['make -C "$SRC" deps build', 'systemctl stop ozwell-computer.service', 'install PREFIX=', 'systemctl start ozwell-computer.service && healthy'];
    const at = order.map((s) => git.indexOf(s));
    expect(at.every((i) => i > -1)).toBe(true);
    expect(at).toEqual([...at].sort((a, b) => a - b));
    const units = [...git.matchAll(/systemctl\s+(?:stop|start|try-restart|restart)\s+([\w.-]+)/g)].map((m) => m[1]);
    expect(new Set(units)).toEqual(new Set(['ozwell-computer.service', 'ozwell-computer-upgrade.path']));
    expect(git.split('\n').filter((l) => !l.trim().startsWith('#')).join('\n')).not.toMatch(/xvfb|session|dbus/);
  });

  it('upgrade.sh compares against the installed REVISION and skips unchanged builds', () => {
    expect(git).toContain('before=$(cat "$PREFIX/REVISION"');
    expect(git).toMatch(/if \[ "\$after" = "\$before" \]; then status unchanged; exit 0; fi/);
  });

  describe('upgrade.sh in a sandbox (fake git, make, systemctl and node)', () => {
    // Runs the script with FAIL_ON (a `case` pattern over "<command> <args>") failing; returns the outcome.
    function run(dir: string, failOn = '__none__') {
      writeFileSync(join(dir, 'calls'), '');
      spawnSync('sh', [join(dir, 'upgrade')], { env: { ...process.env, PATH: `${dir}/bin:${process.env.PATH}`, FAIL_ON: failOn, OZWELL_COMPUTER_UPDATE_URL: 'git+https://example.invalid/repo#main' }, stdio: 'ignore' });
      return {
        status: readFileSync(join(dir, 'state/upgrade.status'), 'utf8').split(' ')[0],
        revision: existsSync(join(dir, 'prefix/REVISION')) ? readFileSync(join(dir, 'prefix/REVISION'), 'utf8').trim() : null,
        calls: readFileSync(join(dir, 'calls'), 'utf8').split('\n').filter((l) => /^(make|systemctl)/.test(l)),
      };
    }
    function sandbox() {
      const dir = mkdtempSync(join(tmpdir(), 'oz-upgrade-'));
      for (const d of ['state', 'prefix', 'src/.git', 'bin']) mkdirSync(join(dir, d), { recursive: true });
      writeFileSync(join(dir, 'prefix/REVISION'), 'old\n');
      writeFileSync(join(dir, 'upgrade'), sh.replace(/^STATE=.*$/m, `STATE=${dir}/state`).replace('@PREFIX@', `${dir}/prefix`).replace(/^SRC=.*$/m, `SRC=${dir}/src`));
      for (const c of ['git', 'make', 'systemctl', 'node', 'sleep']) {
        writeFileSync(join(dir, 'bin', c), `#!/bin/sh
echo "${c} $*" >> ${dir}/calls
case "${c} $*" in $FAIL_ON) exit 1 ;; esac
case "${c} $*" in "git -C ${dir}/src rev-parse"*) echo new ;; "make -C ${dir}/src install"*) echo new > ${dir}/prefix/REVISION ;; esac
`, { mode: 0o755 });
      }
      return dir;
    }
    const dirs: string[] = [];
    afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
    const fresh = () => { const d = sandbox(); dirs.push(d); return d; };

    it('installs with the server stopped, checks it came back, and then reports unchanged', () => {
      const dir = fresh();
      const r = run(dir);
      expect(r).toMatchObject({ status: 'succeeded', revision: 'new' });
      expect(r.calls.map((l) => l.replace(dir, ''))).toEqual([
        'make -C /src deps build',
        'systemctl stop ozwell-computer.service',
        `make -C /src install PREFIX=${dir}/prefix`,
        'systemctl daemon-reload',
        'systemctl start ozwell-computer.service',
        'systemctl try-restart ozwell-computer-upgrade.path',
      ]);
      expect(readFileSync(join(dir, 'calls'), 'utf8')).toContain('/health');
      expect(run(dir)).toMatchObject({ status: 'unchanged', revision: 'new', calls: [] });
    });

    it('a failed build leaves the server and the install alone', () => {
      const r = run(fresh(), 'make*deps*');
      expect(r).toMatchObject({ status: 'failed', revision: 'old', calls: [expect.stringContaining('deps build')] });
    });

    it.each(['make*install*', 'systemctl daemon-reload', 'systemctl start*', 'node*', 'systemctl try-restart*'])(
      'when %s fails it reports failed, starts the server again, and a retry reinstalls',
      (failOn) => {
        const dir = fresh();
        const r = run(dir, failOn);
        expect(r.status).toBe('failed');
        expect(r.revision).toBeNull();
        expect(r.calls.at(-1)).toBe('systemctl start ozwell-computer.service');
        const retry = run(dir);
        expect(retry).toMatchObject({ status: 'succeeded', revision: 'new' });
        expect(retry.calls).toContain('systemctl stop ozwell-computer.service');
      },
    );
  });

  it('the upgrade unit takes its channel from root-owned config, not the request file', () => {
    expect(read('contrib/systemd/ozwell-computer-upgrade.service')).toMatch(/^EnvironmentFile=-\/etc\/default\/ozwell-computer$/m);
    expect(sh).not.toMatch(/(cat|\.|source)\s+"?\$STATE\/upgrade-request/);
  });

  it('make install records the source commit last and keeps existing config files', () => {
    const mk = read('Makefile');
    const recipe = /^install: .*\n((?:\t.*\n)+)/m.exec(mk)?.[1].trimEnd().split('\n') ?? [];
    expect(recipe.at(-1)).toMatch(/^\tgit rev-parse --verify -q HEAD > \$\(DESTAPP\)\/REVISION/);
    // Cleared first, so a partial install never carries the marker.
    expect(recipe.findIndex((l) => l.includes('rm -f $(DESTAPP)/REVISION'))).toBeLessThan(recipe.findIndex((l) => l.includes('cp -a dist')));
    // From the source checkout: the installed tree (e.g. /opt) has no git history.
    expect(mk).toContain('npm pkg set version="$$(cd "$(CURDIR)" && ./package-version node)"');
    expect(mk).toContain('$(call conffile,contrib/default/ozwell-computer,');
    expect(mk).toMatch(/sed 's\|@PREFIX@\|\$\(PREFIX\)\|g' contrib\/upgrade\.sh/);
  });
});
