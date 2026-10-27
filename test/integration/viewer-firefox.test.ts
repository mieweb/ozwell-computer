/**
 * Firefox-specific viewer checks (Playwright's Firefox is installed by `npm test`).
 * Firefox prompts for every navigator.clipboard.readText(), so paste must arrive via
 * the native paste event, including Ctrl+Shift+V into terminals.
 */
import { afterAll, beforeAll, describe, expect, it, inject } from 'vitest';
import { firefox, type Browser } from 'playwright-core';

const URL_ = inject('ozUrl');
const TOKEN = inject('ozToken');
const auth = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function exec(cmd: string): Promise<string> {
  const r = await fetch(`${URL_}/api/v1/exec`, { method: 'POST', headers: auth, body: JSON.stringify({ cmd, timeout_ms: 5000 }) });
  return (await r.json()).stdout;
}

describe('noVNC viewer in Firefox', () => {
  let browser: Browser;
  beforeAll(async () => { browser = await firefox.launch(); });
  afterAll(async () => { await browser?.close(); });

  it.each(['Control+v', 'Control+Shift+V'])('%s pastes the local clipboard without readText()', async (combo) => {
    const title = `oz-ff-${combo.length}`;
    const out = `/tmp/oz-ff-${combo.length}.txt`;
    await exec(`rm -f ${out}`);
    await fetch(`${URL_}/api/v1/apps/launch`, {
      method: 'POST', headers: auth,
      body: JSON.stringify({ command: 'xfce4-terminal', args: ['--disable-server', `--title=${title}`, '--geometry=80x20+200+150'] }),
    });
    const win = await (async () => {
      for (let i = 0; i < 50; i++) {
        const w = ((await (await fetch(`${URL_}/api/v1/windows`, { headers: auth })).json()).windows as any[]).find((x) => x.title === title);
        if (w) return w;
        await sleep(200);
      }
      throw new Error('terminal did not appear');
    })();
    await fetch(`${URL_}/api/v1/windows/${win.id}/activate`, { method: 'POST', headers: auth });
    await sleep(500);

    const page = await (await browser.newContext()).newPage();
    await page.goto(`${URL_}/?token=${TOKEN}`);
    await page.waitForFunction(() => document.getElementById('status')?.textContent === 'connected', null, { timeout: 15000 });
    await page.evaluate((text) => {
      const w = window as any;
      w.readTextCalls = 0;
      const orig = navigator.clipboard.readText.bind(navigator.clipboard);
      navigator.clipboard.readText = () => { w.readTextCalls++; return orig(); };
      // A real copy puts text on Firefox's clipboard without any permission.
      const t = document.createElement('textarea');
      t.id = 'src'; t.value = text; document.body.append(t); t.select();
    }, `echo pasted ✓ > ${out}`);
    await page.keyboard.press('Control+c');
    await page.evaluate(() => document.getElementById('src')!.remove());
    await page.locator('#screen canvas').focus();

    await page.keyboard.press(combo);
    await sleep(800);
    expect(await page.evaluate(() => (window as any).readTextCalls)).toBe(0);
    expect(await page.evaluate(() => document.activeElement?.tagName)).toBe('CANVAS');

    if (combo === 'Control+Shift+V') {
      await page.keyboard.press('Enter');
      let got = '';
      for (let i = 0; i < 25 && !got; i++) { await sleep(200); got = await exec(`cat ${out} 2>/dev/null`); }
      expect(got).toBe('pasted ✓\n');
    }
    await fetch(`${URL_}/api/v1/windows/${win.id}/close`, { method: 'POST', headers: auth });
    await page.context().close();
  });
});
