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
