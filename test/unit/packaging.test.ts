import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { readInstalled } from '../../src/update.js';

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
        revision: readFileSync(join(dir, 'prefix/REVISION'), 'utf8').trim(),
        calls: readFileSync(join(dir, 'calls'), 'utf8').split('\n').filter((l) => /^(make|systemctl)/.test(l)),
      };
    }
    function sandbox() {
      const dir = mkdtempSync(join(tmpdir(), 'oz-upgrade-'));
      for (const d of ['state', 'prefix', 'src/.git', 'bin']) mkdirSync(join(dir, d), { recursive: true });
      writeFileSync(join(dir, 'prefix/REVISION'), 'old\n');
      writeFileSync(join(dir, 'prefix/package.json'), '{"version":"1.0.0"}');
      writeFileSync(join(dir, 'upgrade'), sh.replace(/^STATE=.*$/m, `STATE=${dir}/state`).replace('@PREFIX@', `${dir}/prefix`).replace(/^SRC=.*$/m, `SRC=${dir}/src`));
      for (const c of ['git', 'make', 'systemctl', 'node', 'sleep']) {
        writeFileSync(join(dir, 'bin', c), `#!/bin/sh
echo "${c} $*" >> ${dir}/calls
case "${c} $*" in $FAIL_ON) exit 1 ;; esac
case "${c} $*" in "git -C ${dir}/src rev-parse"*) echo new ;; "make -C ${dir}/src -o build -o system-deps install"*) echo new > ${dir}/prefix/REVISION ;; esac
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
        'make -C /src system-deps',
        'systemctl stop ozwell-computer.service',
        `make -C /src -o build -o system-deps install PREFIX=${dir}/prefix`,
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

    it('a failed system package install leaves the server and the install alone', () => {
      const r = run(fresh(), 'make*system-deps');
      expect(r).toMatchObject({ status: 'failed', revision: 'old' });
      expect(r.calls.some((l) => l.startsWith('systemctl'))).toBe(false);
    });

    it.each(['make*install*', 'systemctl daemon-reload', 'systemctl start*', 'node*', 'systemctl try-restart*'])(
      'when %s fails it reports failed, restarts the server onto the marker, and a retry reinstalls',
      async (failOn) => {
        const dir = fresh();
        const r = run(dir, failOn);
        expect(r.status).toBe('failed');
        expect(r.revision).toBe('0'.repeat(40));
        // Still a valid install to the server, so it keeps offering the update.
        expect(await readInstalled(join(dir, 'prefix'))).toEqual({ version: '1.0.0', revision: '0'.repeat(40) });
        expect(r.calls.at(-1)).toBe('systemctl restart ozwell-computer.service');
        const retry = run(dir);
        expect(retry).toMatchObject({ status: 'succeeded', revision: 'new' });
        expect(retry.calls).toContain('systemctl stop ozwell-computer.service');
      },
    );
  });

  it('make installs the .fpm packages for a real install (older updaters run it), not for a staged one', () => {
    const dry = (...args: string[]) => spawnSync('make', ['-n', ...args], { cwd: new URL('../..', import.meta.url), encoding: 'utf8' }).stdout;
    expect(dry('system-deps')).toMatch(/apt-get .*install -y --no-install-recommends/);
    expect(dry('-o', 'build', 'install', 'DESTDIR=/')).toContain('apt-get');
    expect(dry('-o', 'build', 'install', 'DESTDIR=/tmp/oz-stage')).not.toContain('apt-get');
  });

  it('the upgrade unit takes its channel from root-owned config, not the request file', () => {
    expect(read('contrib/systemd/ozwell-computer-upgrade.service')).toMatch(/^EnvironmentFile=-\/etc\/default\/ozwell-computer$/m);
    expect(sh).not.toMatch(/(cat|\.|source)\s+"?\$STATE\/upgrade-request/);
  });

  it('make install records the source commit last and keeps existing config files', () => {
    const mk = read('Makefile');
    const recipe = /^install: .*\n((?:\t.*\n)+)/m.exec(mk)?.[1].trimEnd().split('\n') ?? [];
    expect(recipe.at(-1)).toMatch(/^\trev=\$\$\(git rev-parse --verify -q HEAD .*then echo "\$\$rev" > \$\(DESTAPP\)\/REVISION; else rm -f/);
    // From the source checkout: the installed tree (e.g. /opt) has no git history.
    expect(mk).toContain('npm pkg set version="$$(cd "$(CURDIR)" && ./package-version node)"');
    expect(mk).toContain('$(call conffile,contrib/default/ozwell-computer,');
    expect(mk).toMatch(/sed 's\|@PREFIX@\|\$\(PREFIX\)\|g' contrib\/upgrade\.sh/);
  });
});

describe('desktop session', () => {
  const unit = (u: string) => read(`contrib/systemd/${u}.service`);

  // Restarting the server (upgrades, crashes, `systemctl restart`) must not take the
  // desktop down with it; the session Requires= the bus and Xvfb.
  it.each(['ozwell-computer-dbus', 'ozwell-computer-xvfb', 'ozwell-computer-session'])('%s is not bound to the server', (u) => {
    expect(unit(u)).not.toMatch(/^(PartOf|BindsTo|Requires|Requisite)=.*ozwell-computer\.service/m);
  });

  it('postinst restarts only the server on upgrade', () => {
    const restarts = [...read('contrib/postinst').matchAll(/systemctl (?:try-)?restart (.*)/g)].map((m) => m[1]);
    expect(restarts).toEqual(['ozwell-computer.service', 'ozwell-computer-upgrade.path']);
  });

  it('xfce4-session restores the saved session, and starts the default apps only without one', () => {
    const sh = read('contrib/xfce/session.sh');
    expect(sh).toMatch(/^exec xfce4-session$/m);
    expect(sh).not.toMatch(/^\s*(xfwm4|xfce4-panel|xfce4-terminal)\b/m);
    const xml = read('contrib/xfce/xfce4-session.xml');
    expect(xml).toMatch(/name="SaveOnExit" type="bool" value="true"/);
    const failsafe = /name="FailsafeSessionName" type="string" value="(\w+)"/.exec(xml)![1];
    expect(xml).toMatch(new RegExp(`name="${failsafe}" type="empty">\\s*<property name="IsFailsafe" type="bool" value="true"/>`));
    expect(unit('ozwell-computer-session')).toMatch(/^ExecStop=.*ozwell-computer-session stop$/m);
  });

  it('xfconfd reads the session config from where make install puts it', () => {
    expect(unit('ozwell-computer-dbus')).toMatch(/^Environment=XDG_CONFIG_DIRS=@PREFIX@\/xdg:\/etc\/xdg$/m);
    expect(read('Makefile')).toMatch(/^APP_XFCONF := \$\(DESTAPP\)\/xdg\/xfce4\/xfconf\/xfce-perchannel-xml$/m);
    expect(read('.fpm')).toMatch(/^--depends xfce4-session$/m);
  });

  it('the default GTK and xfwm4 themes are the installed light Greybird', () => {
    expect(read('.fpm')).toMatch(/^--depends greybird-gtk-theme$/m);
    expect(read('.fpm')).not.toMatch(/xsettingsd/);
    expect(read('contrib/xfce/xsettings.xml')).toMatch(/<property name="ThemeName" type="string" value="Greybird"\/>/);
    expect(read('contrib/xfce/xfconf/xfwm4.xml')).toMatch(/<property name="theme" type="string" value="Greybird"\/>/);
    // Not /etc/xdg: xfce4-settings owns that xsettings.xml.
    expect(read('Makefile')).toMatch(/^\t\$\(INSTALL_DATA\) .*contrib\/xfce\/xsettings\.xml .*\$\(APP_XFCONF\)\/$/m);
  });

  it('Firefox restores the previous session', () => {
    expect(JSON.parse(read('docker/firefox/policies.json')).policies.Homepage.StartPage).toBe('previous-session');
  });
});
