/**
 * Browser tests of the "/" viewer with stock noVNC, in Playwright's Chromium
 * (installed by `npm test`). Set CHROME_PATH to use another Chrome build.
 */
import { afterAll, beforeAll, describe, expect, it, inject } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright-core';

const URL_ = inject('ozUrl');
const TOKEN = inject('ozToken');
const CHROME = process.env.CHROME_PATH || undefined;
const auth = { authorization: `Bearer ${TOKEN}` };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('noVNC viewer', () => {
  let browser: Browser;
  beforeAll(async () => { browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] }); });
  afterAll(async () => { await browser?.close(); });

  async function openViewer(colorScheme: 'light' | 'dark' = 'light'): Promise<Page> {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, colorScheme, permissions: ['clipboard-read', 'clipboard-write'] });
    const page = await ctx.newPage();
    page.on('pageerror', (e) => { throw e; });
    await page.goto(`${URL_}/?token=${TOKEN}`);
    expect(page.url()).toBe(`${URL_}/`); // token stripped from the address bar
    await page.waitForFunction(() => document.getElementById('status')?.textContent === 'connected', null, { timeout: 15000 });
    expect(await page.title()).toMatch(/^desktop \S/);
    return page;
  }

  it('without a token shows the login view, which signs in and opens the viewer', async () => {
    const ctx = await browser.newContext({ colorScheme: 'dark' });
    const page = await ctx.newPage();
    await page.goto(`${URL_}/?token=wrong`);
    await page.getByText('That token was not accepted.').waitFor();
    expect(await page.evaluate(() => document.documentElement.classList.contains('dark'))).toBe(true); // follows the browser
    await page.fill('input[name=token]', TOKEN);
    await page.click('button[type=submit]');
    await page.waitForURL(`${URL_}/`);
    await page.waitForFunction(() => document.getElementById('status')?.textContent === 'connected', null, { timeout: 15000 });
    await ctx.close();
  });

  it('connects through /?token=, renders the desktop, and forwards input', async () => {
    const page = await openViewer();
    // Canvas has non-background pixels (the desktop was drawn).
    await page.waitForFunction(() => {
      const c = document.querySelector('#screen canvas') as HTMLCanvasElement | null;
      if (!c || c.width < 100) return false;
      const d = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data;
      let nonBlack = 0;
      for (let i = 0; i < d.length; i += 4 * 97) if (d[i] + d[i + 1] + d[i + 2] > 30) nonBlack++;
      return nonBlack > 100;
    }, null, { timeout: 15000 });
    // Toolbar resource readout from /api/v1/metrics (CPU appears after the second sample).
    await page.waitForFunction(() => /CPU \d+%.*Mem \d+ MiB/.test(document.getElementById('perf')?.textContent ?? ''), null, { timeout: 15000 });
    // Shown iff the server reports something to act on (on the git channel main may have moved).
    const u = await (await fetch(`${URL_}/api/v1/update`, { headers: auth })).json();
    const shown = u.supported && (u.available || ['requested', 'running', 'failed'].includes(u.upgrade.state));
    await page.waitForFunction((v) => !!document.getElementById('btn-update') === v, shown, { timeout: 5000 });
    // The installed version is always shown; clicking it checks for an update now.
    await page.waitForFunction((v) => document.getElementById('btn-version')?.textContent === `v${v}`, u.current, { timeout: 10000 });
    await page.locator('#btn-version').click();
    await page.waitForFunction(() => /Up to date|is available|Update check failed/.test(document.getElementById('toast')?.textContent ?? ''), null, { timeout: 20000 });
    expect(await page.locator('#btn-version').getAttribute('title')).toContain('Last checked');
    const box = (await page.locator('#screen canvas').boundingBox())!;
    // Move the mouse over the canvas; the server pointer follows (scaled).
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await sleep(500);
    const cur = await (await fetch(`${URL_}/api/v1/cursor`, { headers: auth })).json();
    expect(Math.abs(cur.x - 960)).toBeLessThan(20);
    expect(Math.abs(cur.y - 540)).toBeLessThan(20);
    await page.context().close();
  });

  it('a ?token= link followed from another site opens the viewer, not the login page', async () => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    // localhost and 127.0.0.1 are different sites, so this click is a cross-site navigation.
    await page.goto(URL_.replace('127.0.0.1', 'localhost') + '/static/none');
    await page.setContent(`<a id="l" href="${URL_}/?token=${TOKEN}">open</a>`);
    await page.click('#l');
    await page.waitForURL(`${URL_}/`);
    await page.waitForFunction(() => document.getElementById('status')?.textContent === 'connected', null, { timeout: 15000 });
    expect(await page.locator('input[type=password]').count()).toBe(0);
    await ctx.close();
  });

  it('two tabs and an API agent see each other\'s cursors', async () => {
    const a = await openViewer();
    const b = await openViewer();
    const boxA = (await a.locator('#screen canvas').boundingBox())!;
    await a.mouse.move(boxA.x + 100, boxA.y + 100);
    await a.mouse.move(boxA.x + 120, boxA.y + 110);
    await fetch(`${URL_}/api/v1/input/pointer`, {
      method: 'POST', headers: { ...auth, 'content-type': 'application/json', 'x-principal': JSON.stringify({ id: 'viewer-test-bot', name: 'test-bot', kind: 'agent' }) },
      body: JSON.stringify({ action: 'move', x: 1500, y: 800 }),
    });
    // Tab B sees tab A's cursor and the agent's cursor; tab A sees the agent's.
    await b.waitForFunction(() => document.querySelectorAll('#overlay [data-participant]').length >= 2, null, { timeout: 10000 });
    const namesB = await b.locator('#overlay [data-participant] span').allTextContents();
    expect(namesB).toContain('test-bot');
    await a.waitForFunction(() => [...document.querySelectorAll('#overlay [data-participant] span')].some((s) => s.textContent === 'test-bot'), null, { timeout: 10000 });
    const roster = await b.locator('#roster [data-participant]').allTextContents();
    expect(roster.some((r) => r.includes('test-bot'))).toBe(true);
    await a.context().close();
    await b.context().close();
  });

  it('the first viewer\'s prefers-color-scheme sets the desktop theme once; the toggle switches every viewer', async () => {
    const exec = (cmd: string) => fetch(`${URL_}/api/v1/exec`, {
      method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ cmd, timeout_ms: 5000 }),
    });
    const theme = async () => (await fetch(`${URL_}/api/v1/desktop/theme`, { headers: auth })).json();
    await exec('rm -f ~/.xsettingsd');
    const isDark = (dark: boolean) => document.documentElement.classList.contains('dark') === dark;
    const dark = await openViewer('dark');
    await expect.poll(theme, { timeout: 5000 }).toEqual({ scheme: 'dark', set: true });
    expect(await dark.evaluate(isDark, true)).toBe(true);
    const light = await openViewer('light');
    await light.waitForFunction(isDark, true, { timeout: 5000 });
    expect(await theme()).toEqual({ scheme: 'dark', set: true });
    await light.click('#btn-theme');
    await dark.waitForFunction(isDark, false, { timeout: 5000 });
    expect(await theme()).toEqual({ scheme: 'light', set: true });
    await dark.context().close();
    await light.context().close();
    await exec('rm -f ~/.xsettingsd');
  });

  it('the jobs panel streams a background command\'s output and cancels it', async () => {
    const start = await (await fetch(`${URL_}/api/v1/exec`, {
      method: 'POST', headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ cmd: 'echo first; sleep 1; echo second >&2; sleep 60', wait_ms: 0 }),
    })).json();
    const page = await openViewer();
    await page.locator('#btn-jobs').waitFor({ state: 'visible', timeout: 10000 });
    await page.click('#btn-jobs');
    await page.waitForFunction(() => document.getElementById('jobs-cmd')?.textContent?.includes('sleep 60'), null, { timeout: 10000 });
    expect(await page.locator('#jobs-list li.sel button').getAttribute('aria-pressed')).toBe('true');
    await page.waitForFunction(() => {
      const out = document.getElementById('jobs-out')!;
      return out.textContent!.includes('first') && out.querySelector('.err')?.textContent === 'second\n';
    }, null, { timeout: 10000 });
    page.once('dialog', (d) => d.accept());
    await page.click('#jobs-cancel');
    await page.waitForFunction(() => document.getElementById('jobs-state')?.textContent === 'cancelled', null, { timeout: 10000 });
    expect(await page.locator('#jobs-cancel').isHidden()).toBe(true);
    const v = await (await fetch(`${URL_}/api/v1/exec/jobs/${start.job_id}`, { headers: auth })).json();
    expect(v.state).toBe('cancelled');
    await page.context().close();
  });

  it('shares the local clipboard: Ctrl+V pastes local text, Ctrl+C copies desktop text locally', async () => {
    const page = await openViewer();
    expect(await page.locator('#btn-clip').isHidden()).toBe(true); // localhost is a secure context
    const exec = async (cmd: string) => (await (await fetch(`${URL_}/api/v1/exec`, {
      method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ cmd, timeout_ms: 5000 }),
    })).json()).stdout as string;
    await exec('rm -f /tmp/oz-clip-entry.txt');
    await fetch(`${URL_}/api/v1/apps/launch`, {
      method: 'POST', headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ command: 'sh', args: ['-c', 'zenity --entry --text=clip > /tmp/oz-clip-entry.txt'] }),
    });
    await sleep(2500); // zenity's entry has focus
    const canvas = page.locator('#screen canvas');
    await canvas.focus();

    // local → desktop, via the native paste event (no readText(), so no Firefox/Safari prompt)
    await page.evaluate(() => {
      const w = window as any;
      w.readTextCalls = 0;
      const orig = navigator.clipboard.readText.bind(navigator.clipboard);
      navigator.clipboard.readText = () => { w.readTextCalls++; return orig(); };
      return navigator.clipboard.writeText('from local ✓ ünï');
    });
    await page.keyboard.press('Control+v');
    await sleep(1000);
    expect(await page.evaluate(() => (window as any).readTextCalls)).toBe(0);

    // desktop → local: select the entry's text and copy it
    await page.evaluate(() => navigator.clipboard.writeText('stale'));
    await page.keyboard.press('Control+a');
    await page.keyboard.press('Control+c');
    let local = 'stale';
    for (let i = 0; i < 25 && local === 'stale'; i++) { await sleep(200); local = await page.evaluate(() => navigator.clipboard.readText()); }
    expect(local).toBe('from local ✓ ünï');
    expect(await page.locator('#toast').textContent()).toContain('Copied');

    await page.keyboard.press('Enter');
    await sleep(800);
    expect(await exec('cat /tmp/oz-clip-entry.txt')).toBe('from local ✓ ünï\n');
    await page.context().close();
  });
});
