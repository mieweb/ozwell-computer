import { afterAll, describe, expect, it } from 'vitest';
import { resolveKeysym, charToKeysym, keysymToChar, normalizeModifier, XK } from '../../src/x11/keymap.js';
import { ScreenshotRegistry, resolvePoint, fitSize } from '../../src/coords.js';
import { loadConfig, parseArgs } from '../../src/config.js';
import { safePath, signedUrl, verifySignature, parseRange } from '../../src/fs/index.js';
import { deriveKey } from '../../src/auth/token.js';
import { addRect } from '../../src/x11/damage.js';
import { Presence, EventBus, parsePrincipal } from '../../src/presence/index.js';
import { pgm } from '../../src/ocr.js';
import { checkResult, versionTitle, type UpdateStatus } from '../../web/src/version.js';

describe('viewer version button', () => {
  const s: UpdateStatus = { supported: true, current: '1.2.3', latest: '1.2.4', available: true, checked_at: null, error: null };
  it('explains the update status in the tooltip', () => {
    expect(versionTitle(null)).toBe('Update checks unavailable: update checks are not running');
    expect(versionTitle({ supported: false, limitation: 'not a package', current: null })).toBe('Update checks unavailable: not a package');
    expect(versionTitle(s)).toBe('Not checked yet\nLatest release: 1.2.4\nClick to check for updates now.');
    expect(versionTitle({ ...s, checked_at: '2026-01-01T00:00:00Z', error: 'boom' }))
      .toMatch(/^Last checked .+\nLast check failed: boom\nClick to check for updates now\.$/);
  });
  it('summarizes a check', () => {
    expect(checkResult(s)).toBe('ozwell-computer 1.2.4 is available');
    expect(checkResult({ ...s, available: false })).toBe('Up to date');
    expect(checkResult({ ...s, error: 'offline' })).toBe('Update check failed: offline');
  });
});

describe('keymap', () => {
  it('resolves W3C codes, names, chars, keysym names, hex', () => {
    expect(resolveKeysym('KeyA')).toBe(0x61);
    expect(resolveKeysym('Enter')).toBe(XK.Return);
    expect(resolveKeysym('ctrl')).toBe(XK.Control_L);
    expect(resolveKeysym('F5')).toBe(XK.F1 + 4);
    expect(resolveKeysym('ArrowLeft')).toBe(XK.Left);
    expect(resolveKeysym('A')).toBe(0x41);
    expect(resolveKeysym('é')).toBe(0xe9);
    expect(resolveKeysym('€')).toBe(0x010020ac);
    expect(resolveKeysym('XF86AudioMute')).toBeGreaterThan(0x1000000);
    expect(resolveKeysym('0xff0d')).toBe(XK.Return);
    expect(() => resolveKeysym('NotAKey')).toThrow();
  });
  it('maps characters both ways', () => {
    expect(charToKeysym('\n')).toBe(XK.Return);
    expect(keysymToChar(0x41)).toBe('A');
    expect(keysymToChar(0x010020ac)).toBe('€');
    expect(normalizeModifier('Control')).toBe('ctrl');
    expect(normalizeModifier('cmd')).toBe('super');
  });
});

describe('coordinates', () => {
  const root = { width: 1920, height: 1080 };
  it('fits sizes', () => {
    expect(fitSize(1920, 1080, 1280)).toEqual({ width: 1280, height: 720, scale: 1.5 });
    expect(fitSize(800, 600, 1280).scale).toBe(1);
  });
  it('maps screenshot space with scaling to within 1px', async () => {
    const registry = new ScreenshotRegistry();
    const e = registry.add({ origin: { x: 0, y: 0 }, scale: 1.5, imageSize: { width: 1280, height: 720 }, nativeSize: root, root, geometryEpoch: 0 });
    const p = await resolvePoint({ x: 640, y: 360, screenshot_id: e.id }, { root, geometryEpoch: 0, registry });
    expect(p).toEqual({ x: 960, y: 540 });
    const q = await resolvePoint({ x: 333, y: 111, screenshot_id: e.id }, { root, geometryEpoch: 0, registry });
    expect(Math.abs(q.x - 333 * 1.5)).toBeLessThanOrEqual(1);
  });
  it('rejects stale geometry', async () => {
    const registry = new ScreenshotRegistry();
    const e = registry.add({ origin: { x: 0, y: 0 }, scale: 1, imageSize: root, nativeSize: root, root, geometryEpoch: 0 });
    await expect(resolvePoint({ x: 1, y: 1, screenshot_id: e.id }, { root, geometryEpoch: 1, registry })).rejects.toMatchObject({ reason: 'stale_geometry' });
    await expect(resolvePoint({ x: 1, y: 1, screenshot_id: 'nope' }, { root, geometryEpoch: 0, registry })).rejects.toMatchObject({ reason: 'stale_geometry' });
  });
  it('rejects moved windows', async () => {
    const registry = new ScreenshotRegistry();
    const bounds = { x: 10, y: 10, width: 100, height: 100 };
    const e = registry.add({ origin: { x: 10, y: 10 }, scale: 1, imageSize: { width: 100, height: 100 }, nativeSize: { width: 100, height: 100 }, root, geometryEpoch: 0, window: { wid: 5, bounds } });
    const ctx = { root, geometryEpoch: 0, registry, windowBounds: async () => ({ ...bounds, x: 20 }) };
    await expect(resolvePoint({ x: 1, y: 1, screenshot_id: e.id }, ctx)).rejects.toMatchObject({ reason: 'stale_geometry' });
  });
  it('maps normalized and window spaces', async () => {
    const registry = new ScreenshotRegistry();
    const ctx = { root, geometryEpoch: 0, registry, windowBounds: async () => ({ x: 100, y: 50, width: 200, height: 100 }) };
    expect(await resolvePoint({ x: 1, y: 1, space: 'normalized' }, ctx)).toEqual({ x: 1919, y: 1079 });
    expect(await resolvePoint({ x: 5, y: 5, space: 'window', window: 7 }, ctx)).toEqual({ x: 105, y: 55 });
    await expect(resolvePoint({ x: 5000, y: 5 }, ctx)).rejects.toMatchObject({ reason: 'invalid_request' });
  });
  it('expires registry entries and evicts LRU', () => {
    const r = new ScreenshotRegistry(2, 1000);
    const a = r.add({ origin: { x: 0, y: 0 }, scale: 1, imageSize: root, nativeSize: root, root, geometryEpoch: 0 }, 0);
    expect(() => r.get(a.id, 5000)).toThrow();
    const b = r.add({ origin: { x: 0, y: 0 }, scale: 1, imageSize: root, nativeSize: root, root, geometryEpoch: 0 });
    r.add({ origin: { x: 0, y: 0 }, scale: 1, imageSize: root, nativeSize: root, root, geometryEpoch: 0 });
    r.add({ origin: { x: 0, y: 0 }, scale: 1, imageSize: root, nativeSize: root, root, geometryEpoch: 0 });
    expect(() => r.get(b.id)).toThrow();
  });
});

describe('config', () => {
  it('merges env and flags', () => {
    const { config } = loadConfig({ OZWELL_COMPUTER_PORT: '9000', OZWELL_COMPUTER_EXEC: 'false' }, ['--no-auth', '--display', ':5', '--vnc-backend=external:5900']);
    expect(config.port).toBe(9000);
    expect(config.exec).toBe(false);
    expect(config.authDisabled).toBe(true);
    expect(config.display).toBe(':5');
    expect(config.vncBackend).toBe('external:5900');
    expect(parseArgs(['--no-exec']).overrides.exec).toBe(false);
    expect(() => loadConfig({}, ['--bogus'])).toThrow();
    expect(() => loadConfig({ OZWELL_COMPUTER_VNC_BACKEND: 'weird' })).toThrow();
    expect(loadConfig({ OZWELL_COMPUTER_CPUS: '1.5' }).config.cpus).toBe(1.5);
    expect(loadConfig({}, ['--cpus', '4']).config.cpus).toBe(4);
    expect(() => loadConfig({ OZWELL_COMPUTER_CPUS: '0' })).toThrow();
  });
});

describe('fs helpers', () => {
  it('blocks traversal outside the root', () => {
    expect(safePath('/srv', 'a/b')).toBe('/srv/a/b');
    expect(safePath('/srv', '/a/../b')).toBe('/srv/b');
    expect(() => safePath('/srv', '../etc')).toThrow();
    expect(safePath('/', '/etc/passwd')).toBe('/etc/passwd');
    expect(() => safePath('/srv', 'a\0b')).toThrow();
  });
  it('signs and verifies URLs; a new token invalidates them', () => {
    const k = deriveKey('tok', 'files');
    const s = signedUrl(k, 'GET', '/tmp/a b.txt', 60, 1_000_000);
    const u = new URL(s.url, 'http://x');
    expect(u.pathname).toBe('/files/tmp/a%20b.txt');
    const exp = Number(u.searchParams.get('exp'));
    const sig = u.searchParams.get('sig')!;
    expect(verifySignature(k, 'GET', '/tmp/a b.txt', exp, sig, 1_000_000)).toBe(true);
    expect(verifySignature(k, 'PUT', '/tmp/a b.txt', exp, sig, 1_000_000)).toBe(false);
    expect(verifySignature(k, 'GET', '/tmp/a b.txt', exp, sig, 1_000_000 + 61_000)).toBe(false);
    expect(verifySignature(deriveKey('other', 'files'), 'GET', '/tmp/a b.txt', exp, sig, 1_000_000)).toBe(false);
  });
  it('parses ranges', () => {
    expect(parseRange('bytes=0-9', 100)).toEqual({ start: 0, end: 9 });
    expect(parseRange('bytes=90-', 100)).toEqual({ start: 90, end: 99 });
    expect(parseRange('bytes=-10', 100)).toEqual({ start: 90, end: 99 });
    expect(parseRange('bytes=200-', 100)).toBe('invalid');
    expect(parseRange(undefined, 100)).toBeNull();
  });
});

describe('damage rect merging', () => {
  it('absorbs contained rects and collapses long lists', () => {
    let l = addRect([], { x: 0, y: 0, w: 10, h: 10 });
    l = addRect(l, { x: 2, y: 2, w: 2, h: 2 });
    expect(l).toHaveLength(1);
    for (let i = 0; i < 40; i++) l = addRect(l, { x: i * 20, y: 0, w: 5, h: 5 });
    expect(l.length).toBeLessThanOrEqual(32);
  });
});

describe('presence', () => {
  it('joins, moves cursors, leaves, and dedupes by key', () => {
    const bus = new EventBus();
    const events: string[] = [];
    bus.subscribe((e) => events.push(e.type));
    const p = new Presence(bus);
    const a = p.join({ name: 'bot', kind: 'agent', key: 'k' });
    expect(p.join({ key: 'k' }).participant_id).toBe(a.participant_id);
    expect(p.cursor(a.participant_id, 2, -1)).toBe(true);
    expect(p.get(a.participant_id)!.cursor).toEqual({ x: 1, y: 0, visible: true });
    expect(p.leave(a.participant_id)).toBe(true);
    expect(events).toEqual(['presence.joined', 'presence.cursor', 'presence.left']);
    expect(parsePrincipal('{"id":"a","kind":"agent"}')).toEqual({ id: 'a', name: undefined, kind: 'agent' });
    expect(parsePrincipal('nope')).toBeNull();
    p.dispose();
  });
});

import { netBusAddress, mapRole } from '../../src/a11y/atspi.js';
describe('a11y helpers', () => {
  it('rewrites D-Bus unix addresses for node net', () => {
    expect(netBusAddress('unix:abstract=/tmp/dbus-X,guid=abc')).toBe('unix:socket=\0/tmp/dbus-X,guid=abc');
    expect(netBusAddress('unix:path=/run/user/1/bus')).toBe('unix:socket=/run/user/1/bus');
    expect(netBusAddress('tcp:host=a,port=1')).toBe('tcp:host=a,port=1');
  });
  it('maps roles', () => {
    expect(mapRole('push button')).toBe('button');
    expect(mapRole('some new role')).toBe('some_new_role');
  });
});

import { runCommand } from '../../src/process/exec.js';
describe('exec', () => {
  it('runs commands with and without a shell', async () => {
    expect((await runCommand({ cmd: 'echo', args: ['a b'] }, ':0')).stdout).toBe('a b\n');
    const r = await runCommand({ cmd: 'echo $DISPLAY; exit 3' }, ':7');
    expect(r).toMatchObject({ stdout: ':7\n', exit_code: 3 });
  });
  it('times out and does not hang on background children holding pipes', async () => {
    const t = Date.now();
    const r = await runCommand({ cmd: 'sleep 30 & sleep 30', timeout_ms: 200 }, ':0');
    expect(r.timed_out).toBe(true);
    expect(Date.now() - t).toBeLessThan(3000);
    const r2 = await runCommand({ cmd: '(sleep 30 &) ; echo done' }, ':0');
    expect(r2.stdout).toBe('done\n');
  });
  it('reports missing commands', async () => {
    await expect(runCommand({ cmd: 'definitely-not-a-cmd-xyz', args: [] }, ':0')).rejects.toMatchObject({ reason: 'path_not_found' });
  });
});

describe('startup link config', () => {
  it('parses --public-url and --open', () => {
    const { config } = loadConfig({ OZWELL_COMPUTER_PUBLIC_URL: 'http://localhost:18080' }, ['--open']);
    expect(config.publicUrl).toBe('http://localhost:18080');
    expect(config.open).toBe(true);
    expect(loadConfig({}, []).config.open).toBe(false);
    expect(() => loadConfig({ OZWELL_COMPUTER_PUBLIC_URL: 'not a url' })).toThrow();
  });
});

describe('frame ancestors config', () => {
  it('parses and validates origins', () => {
    expect(loadConfig({}).config.frameAncestors).toEqual([]);
    const env = { OZWELL_COMPUTER_FRAME_ANCESTORS: 'https://app.ozwell.ai, https://*.example.com:8443  http://localhost:*' };
    expect(loadConfig(env).config.frameAncestors).toEqual(['https://app.ozwell.ai', 'https://*.example.com:8443', 'http://localhost:*']);
    expect(loadConfig({}, ['--frame-ancestors', 'https://a.test']).config.frameAncestors).toEqual(['https://a.test']);
    for (const bad of ['*', "'none'", 'app.ozwell.ai', 'https://a.test/path', 'https://a.test; script-src *', 'javascript:x']) {
      expect(() => loadConfig({ OZWELL_COMPUTER_FRAME_ANCESTORS: bad }), bad).toThrow();
    }
  });
});

import { parsePackages, newest, parseUpdateSource, parseLsRemote, isDevelopmentVersion } from '../../src/update.js';
describe('update check', () => {
  const index = `Package: ozwell-computer
Version: 1.2.0
Architecture: amd64
Filename: ./ozwell-computer_1.2.0_amd64.deb

Package: other
Version: 9.9.9
Architecture: amd64

Package: ozwell-computer
Version: 1.10.0~rc1
Architecture: amd64

Package: ozwell-computer
Version: 1.3.0
Architecture: arm64
`;
  // Enough of dpkg's ordering for these cases: numeric fields, and "~" sorts first.
  const key = (v: string) => v.split(/[.~]/).map((x, i, a) => (v.includes('~') && i === a.length - 1 ? -1 : Number(x)));
  const lt = async (a: string, b: string) => {
    const [x, y] = [key(a), key(b)];
    for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) < (y[i] ?? 0);
    return false;
  };
  it('parses only this package', () => {
    expect(parsePackages(index).map((e) => e.version)).toEqual(['1.2.0', '1.10.0~rc1', '1.3.0']);
  });
  it('picks the newest for this architecture', async () => {
    expect(await newest(parsePackages(index), 'amd64', lt)).toBe('1.10.0~rc1');
    expect(await newest(parsePackages(index), 'arm64', lt)).toBe('1.3.0');
    expect(await newest([], 'amd64', lt)).toBeNull();
  });
  it('accepts an update URL or off', () => {
    expect(loadConfig({ OZWELL_COMPUTER_UPDATE_URL: 'off' }).config.updateUrl).toBe('off');
    expect(loadConfig({}, ['--update-url', 'file:///srv/repo/Packages']).config.updateUrl).toBe('file:///srv/repo/Packages');
    expect(() => loadConfig({ OZWELL_COMPUTER_UPDATE_URL: 'nope' })).toThrow();
  });
  it('accepts git+https://<repo>#<branch> only', () => {
    const url = 'git+https://github.com/mieweb/ozwell-computer.git#main';
    expect(loadConfig({ OZWELL_COMPUTER_UPDATE_URL: url }).config.updateUrl).toBe(url);
    for (const bad of ['git+http://example.com/r.git#main', 'git+ssh://git@github.com/r.git#main', 'git+https://github.com/r.git', 'git+https://github.com/r.git#a;b'])
      expect(() => loadConfig({ OZWELL_COMPUTER_UPDATE_URL: bad }), bad).toThrow();
  });
  it('picks the channel from the URL', () => {
    expect(parseUpdateSource('git+https://github.com/mieweb/ozwell-computer.git#release/1.x'))
      .toEqual({ kind: 'git', repo: 'https://github.com/mieweb/ozwell-computer.git', branch: 'release/1.x' });
    expect(parseUpdateSource('https://example.com/Packages')).toEqual({ kind: 'apt', url: 'https://example.com/Packages' });
  });
  it('reads the branch head from git ls-remote output', () => {
    const a = 'a'.repeat(40), b = 'b'.repeat(40);
    const out = `${a}\trefs/heads/main-old\n${b}\trefs/heads/main\n`;
    expect(parseLsRemote(out, 'refs/heads/main')).toBe(b);
    expect(parseLsRemote(out, 'refs/heads/dev')).toBeNull();
    expect(parseLsRemote('', 'refs/heads/main')).toBeNull();
  });
  it('treats untagged 0.0.0 builds as development versions', () => {
    for (const v of ['0.0.0', '0.0.0+12.gabc1234', '0.0.0~dev']) expect(isDevelopmentVersion(v), v).toBe(true);
    for (const v of ['0.0.1', '0.0.10', '1.0.0', '2026.10.2', '10.0.0+1.gabc1234', '0.0.01']) expect(isDevelopmentVersion(v), v).toBe(false);
  });
});

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import { readInstalled, Updater } from '../../src/update.js';
describe('git update channel', () => {
  const dir = mkdtempSync(join(tmpdir(), 'oz-update-'));
  const installed = 'c'.repeat(40);
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  class FakeRemote extends Updater {
    head = installed;
    protected override async lsRemote(_repo: string, ref: string) { return `${this.head}\t${ref}\n`; }
  }

  it('reads the version and REVISION that make install wrote', async () => {
    expect(await readInstalled(dir)).toBeNull();
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ version: '1.2.3+4.gccccccc' }));
    writeFileSync(join(dir, 'REVISION'), 'not a sha\n');
    expect(await readInstalled(dir)).toBeNull();
    writeFileSync(join(dir, 'REVISION'), `${installed}\n`);
    expect(await readInstalled(dir)).toEqual({ version: '1.2.3+4.gccccccc', revision: installed });
  });

  it('offers an update when the branch head differs from the installed commit', async () => {
    const u = new FakeRemote('git+https://github.com/mieweb/ozwell-computer.git#main', pino({ level: 'silent' }), undefined, dir, dir);
    await u.start();
    u.stop();
    expect(await u.status()).toMatchObject({ current: '1.2.3+4.gccccccc', latest: 'main@ccccccc', available: false, error: null, revision: { current: installed, latest: installed } });
    u.head = 'd'.repeat(40);
    expect(await u.check()).toMatchObject({ latest: 'main@ddddddd', available: true, revision: { current: installed, latest: u.head } });
  });

  it('keeps re-reading a requested upgrade until it ends, so the cached status recovers from a failed install', async () => {
    const state = mkdtempSync(join(tmpdir(), 'oz-update-state-'));
    writeFileSync(join(dir, 'upgrade.path'), '');
    const changes: string[] = [];
    class Watched extends FakeRemote { protected override upgradePollMs = 20; }
    const u = new Watched('git+https://github.com/mieweb/ozwell-computer.git#main', pino({ level: 'silent' }), (s) => changes.push(s.upgrade.state), state, dir, join(dir, 'upgrade.path'));
    await u.start();
    writeFileSync(join(state, 'upgrade-request'), '');
    expect((await u.status()).upgrade.state).toBe('requested');
    // the root unit takes the request, then fails without restarting the server
    rmSync(join(state, 'upgrade-request'));
    writeFileSync(join(state, 'upgrade.status'), `failed ${Math.floor(Date.now() / 1000)}\n`);
    for (let i = 0; i < 50 && u.cached()?.upgrade.state !== 'failed'; i++) await new Promise((r) => setTimeout(r, 20));
    u.stop();
    rmSync(state, { recursive: true, force: true });
    expect(u.cached()?.upgrade.state).toBe('failed');
    expect(changes.at(-1)).toBe('failed');
  });
});

describe('ocr', () => {
  it('converts a BGRX frame to grayscale PGM', () => {
    // white, black, pure red, pure blue (BGRX)
    const data = Buffer.from([255, 255, 255, 0, 0, 0, 0, 0, 0, 0, 255, 0, 255, 0, 0, 0]);
    const out = pgm({ width: 2, height: 2, data });
    const header = 'P5\n2 2\n255\n';
    expect(out.subarray(0, header.length).toString('ascii')).toBe(header);
    expect([...out.subarray(header.length)]).toEqual([255, 0, 76, 28]);
  });
});
