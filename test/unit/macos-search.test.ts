import { afterEach, describe, expect, it, vi } from 'vitest';
import pino from 'pino';
import { MacDesktop } from '../../src/macos/desktop.js';
import { MacA11y } from '../../src/macos/a11y.js';
import type { CuaClient, WindowInfo, WindowStateOutput } from '../../src/macos/driver.js';

const log = pino({ level: 'silent' });
const desktops: MacDesktop[] = [];
afterEach(async () => { await Promise.all(desktops.splice(0).map((desktop) => desktop.stop())); });

async function fixture() {
  const window: WindowInfo = { windowId: 42n, pid: 100, appName: 'Fixture', title: 'Editor', bounds: { x: 0, y: 0, width: 100, height: 50 }, isOnScreen: true };
  const state: WindowStateOutput = { pid: 100, windowId: 42n, snapshotId: 'search1', elementsComplete: true, images: [], elements: [
    { elementIndex: 1n, depth: 0, role: 'AXWindow', label: 'Editor' },
    { elementIndex: 2n, parentIndex: 1n, depth: 1, role: 'AXButton', valueDescription: 'Open report', enabled: true },
    { elementIndex: 3n, parentIndex: 1n, depth: 1, role: 'AXButton', label: 'Save', valueDescription: 'Save report', enabled: true },
    { elementIndex: 4n, parentIndex: 1n, depth: 1, role: 'AXButton', label: '', valueDescription: 'Open account', enabled: false },
    { elementIndex: 5n, parentIndex: 1n, depth: 1, role: 'AXLink', label: 'History', valueDescription: 'View report history' },
  ] };
  const client = {
    start: vi.fn(async () => {}), stop: vi.fn(async () => {}),
    permissions: vi.fn(async () => ({ accessibility: true, screenRecording: true })),
    screen: vi.fn(async () => ({ width: 100, height: 50, pixelWidth: 100, pixelHeight: 50, scale: 1 })),
    capture: vi.fn(async () => ({ data: Buffer.alloc(0), width: 100, height: 50, screenWidth: 100, screenHeight: 50 })),
    windows: vi.fn(async () => [window]), cursor: vi.fn(async () => ({ x: 0, y: 0 })),
    click: vi.fn(async () => {}), move: vi.fn(async () => {}), scroll: vi.fn(async () => {}),
    type: vi.fn(async () => {}), press: vi.fn(async () => {}), hotkey: vi.fn(async () => {}),
    clipboardRead: vi.fn(async () => ({ text: '' })), clipboardWrite: vi.fn(async () => {}),
    windowState: vi.fn(async () => state), pressElement: vi.fn(async () => ({ effect: 0, route: 0 })),
  } satisfies CuaClient;
  const desktop = new MacDesktop(log, client);
  desktops.push(desktop);
  await desktop.start();
  return new MacA11y('auto', log, desktop);
}

describe('macOS accessibility search filters', () => {
  it('treats an empty name as an omitted constraint and uses name_empty to find unnamed controls', async () => {
    const a11y = await fixture();
    for (const query of [{ role: 'button' }, { role: 'button', name: '' }, { role: 'button', name_empty: false }]) {
      expect((await a11y.find(query)).matches.map((node) => node.description)).toEqual(['Open report', 'Save report', 'Open account']);
    }
    expect((await a11y.find({ role: 'AXButton', name_empty: true })).matches.map((node) => node.description)).toEqual(['Open report', 'Open account']);
    expect((await a11y.find({ role: 'button', name: 'Save', name_empty: true })).total).toBe(0);
    expect((await a11y.find({ role: 'button', name: 'Save' })).matches.map((node) => node.description)).toEqual(['Save report']);
  });

  it('combines description and case-insensitive description_contains with the other filters', async () => {
    const a11y = await fixture();
    for (const query of [{ description: 'Open report' }, { description: '', description_contains: 'OPEN REPORT' }]) {
      expect((await a11y.find(query)).matches.map((node) => node.description)).toEqual(['Open report']);
    }
    const found = await a11y.find({ role: 'button', name_empty: true, description_contains: 'OPEN', states: ['enabled'] });
    expect(found.total).toBe(1);
    expect(found.matches[0]).toMatchObject({ name: '', description: 'Open report' });
    expect((await a11y.find({ description: 'Open report', description_contains: 'account' })).total).toBe(0);
    expect((await a11y.find({ role: 'link', description_contains: 'Open' })).total).toBe(0);
    expect((await a11y.find({ description: 'open report' })).total).toBe(0);
  });

  it('applies the result limit after filtering and preserves the total count', async () => {
    const a11y = await fixture();
    const found = await a11y.find({ name: '', description_contains: 'REPORT', max_results: 1 });
    expect(found.total).toBe(3);
    expect(found.matches).toHaveLength(1);
    expect(found.matches[0].description).toBe('Open report');
    expect(found.snapshot_id).toBeTruthy();
  });
});
