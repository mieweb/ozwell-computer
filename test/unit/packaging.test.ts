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

  it('Firefox restores the previous session', () => {
    expect(JSON.parse(read('docker/firefox/policies.json')).policies.Homepage.StartPage).toBe('previous-session');
  });
});
