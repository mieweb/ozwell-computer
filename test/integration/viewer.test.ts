/**
 * Browser test of the "/" viewer with stock noVNC. Needs a Chromium:
 *   CHROME_PATH=/usr/bin/google-chrome OZ_URL=... npm run test:integration
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { chromium, type Browser, type Page } from 'playwright-core';

const URL_ = process.env.OZ_URL ?? 'http://localhost:18080';
const TOKEN = process.env.OZ_TOKEN ?? 'testtoken';
const CHROME = process.env.CHROME_PATH ?? ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find(existsSync);
const auth = { authorization: `Bearer ${TOKEN}` };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe.skipIf(!CHROME)('noVNC viewer', () => {
  let browser: Browser;
  beforeAll(async () => { browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] }); });
  afterAll(async () => { await browser?.close(); });

  async function openViewer(): Promise<Page> {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await ctx.newPage();
    page.on('pageerror', (e) => { throw e; });
    await page.goto(`${URL_}/?token=${TOKEN}`);
    expect(page.url()).toBe(`${URL_}/`); // token stripped from the address bar
    await page.waitForFunction(() => document.getElementById('status')?.textContent === 'connected', null, { timeout: 15000 });
    return page;
  }

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
    const box = (await page.locator('#screen canvas').boundingBox())!;
    // Move the mouse over the canvas; the server pointer follows (scaled).
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await sleep(500);
    const cur = await (await fetch(`${URL_}/api/v1/cursor`, { headers: auth })).json();
    expect(Math.abs(cur.x - 960)).toBeLessThan(20);
    expect(Math.abs(cur.y - 540)).toBeLessThan(20);
    await page.context().close();
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
    await b.waitForFunction(() => document.querySelectorAll('#overlay .pcursor').length >= 2, null, { timeout: 10000 });
    const namesB = await b.locator('#overlay .pcursor span').allTextContents();
    expect(namesB).toContain('test-bot');
    await a.waitForFunction(() => [...document.querySelectorAll('#overlay .pcursor span')].some((s) => s.textContent === 'test-bot'), null, { timeout: 10000 });
    const roster = await b.locator('#roster .chip').allTextContents();
    expect(roster.some((r) => r.includes('test-bot'))).toBe(true);
    await a.context().close();
    await b.context().close();
  });
});
