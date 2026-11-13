import { describe, expect, it } from 'vitest';
import { ComputerCache } from '../src/computer-cache.ts';
import type { Computer } from '../src/providers/types.ts';

const c = (over: Partial<Computer> = {}): Computer => ({ id: 'ozc-1', owner: 'u', status: 'running', stopped: false, internalUrl: 'http://x', token: 't', ...over });

describe('ComputerCache', () => {
  it('keeps running, reachable computers only', () => {
    const cache = new ComputerCache();
    cache.set(c());
    expect(cache.get('ozc-1')).toMatchObject({ id: 'ozc-1' });
    cache.set(c({ stopped: true }));
    expect(cache.get('ozc-1')).toBeUndefined();
    cache.set(c({ token: undefined }));
    expect(cache.get('ozc-1')).toBeUndefined();
    cache.set(c());
    cache.set(null, 'ozc-1'); // a lookup that found nothing
    expect(cache.get('ozc-1')).toBeUndefined();
  });

  it('expires entries after maxAge, and drops idle ones', () => {
    let now = 0;
    const cache = new ComputerCache({ maxAgeMs: 100, idleMs: 50, now: () => now });
    cache.set(c());
    now = 40; expect(cache.get('ozc-1')).toBeDefined(); // used: idle timer restarts
    now = 80; expect(cache.get('ozc-1')).toBeDefined();
    now = 100; expect(cache.get('ozc-1')).toBeUndefined(); // max age, though in use
    cache.set(c());
    now = 151; expect(cache.get('ozc-1')).toBeUndefined(); // idle
  });
});
