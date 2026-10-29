import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

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

  it('upgrade.sh builds before installing and restarts only the server', () => {
    expect(git.indexOf('make -C "$SRC" deps build')).toBeGreaterThan(-1);
    expect(git.indexOf('make -C "$SRC" deps build')).toBeLessThan(git.indexOf('install PREFIX='));
    const restarted = [...git.matchAll(/systemctl\s+(?:try-)?restart\s+(\S+)/g)].map((m) => m[1]);
    expect(restarted).toEqual(['ozwell-computer.service', 'ozwell-computer-upgrade.path']);
    expect(git.split('\n').filter((l) => !l.trim().startsWith('#')).join('\n')).not.toMatch(/xvfb|session|dbus/);
  });

  it('upgrade.sh compares against the installed REVISION and skips unchanged builds', () => {
    expect(git).toContain('before=$(cat "$PREFIX/REVISION"');
    expect(git).toMatch(/if \[ "\$after" = "\$before" \]; then status unchanged; exit 0; fi/);
  });

  it('the upgrade unit takes its channel from root-owned config, not the request file', () => {
    expect(read('contrib/systemd/ozwell-computer-upgrade.service')).toMatch(/^EnvironmentFile=-\/etc\/default\/ozwell-computer$/m);
    expect(sh).not.toMatch(/(cat|\.|source)\s+"?\$STATE\/upgrade-request/);
  });

  it('make install records the source commit and keeps existing config files', () => {
    const mk = read('Makefile');
    expect(mk).toMatch(/git rev-parse --verify -q HEAD > \$\(DESTAPP\)\/REVISION/);
    expect(mk).toContain('$(call conffile,contrib/default/ozwell-computer,');
    expect(mk).toMatch(/sed 's\|@PREFIX@\|\$\(PREFIX\)\|g' contrib\/upgrade\.sh/);
  });
});
