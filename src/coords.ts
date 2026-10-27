import { ulid } from 'ulid';
import { ApiError } from './errors.js';
import type { Bounds } from './x11/windows.js';

export type Space = 'screen' | 'window' | 'screenshot' | 'normalized';

export interface ScreenshotEntry {
  id: string;
  /** Top-left of the captured region in root coordinates. */
  origin: { x: number; y: number };
  /** Native pixels per image pixel (>= 1 when downscaled). */
  scale: number;
  imageSize: { width: number; height: number };
  nativeSize: { width: number; height: number };
  root: { width: number; height: number };
  geometryEpoch: number;
  window?: { wid: number; bounds: Bounds };
  createdAt: number;
}

export class ScreenshotRegistry {
  private map = new Map<string, ScreenshotEntry>();
  constructor(private max = 64, private ttlMs = 120_000) {}

  add(e: Omit<ScreenshotEntry, 'id' | 'createdAt'>, now = Date.now()): ScreenshotEntry {
    const entry: ScreenshotEntry = { ...e, id: ulid(now), createdAt: now };
    this.map.set(entry.id, entry);
    while (this.map.size > this.max) this.map.delete(this.map.keys().next().value!);
    return entry;
  }

  get(id: string, now = Date.now()): ScreenshotEntry {
    const e = this.map.get(id);
    if (!e) throw new ApiError('stale_geometry', `screenshot ${id} is unknown or expired; take a new screenshot`);
    if (now - e.createdAt > this.ttlMs) {
      this.map.delete(id);
      throw new ApiError('stale_geometry', `screenshot ${id} expired; take a new screenshot`);
    }
    // LRU touch
    this.map.delete(id);
    this.map.set(id, e);
    return e;
  }
}

export interface ResolveContext {
  root: { width: number; height: number };
  geometryEpoch: number;
  registry: ScreenshotRegistry;
  windowBounds?: (wid: number) => Promise<Bounds>;
}

export interface PointInput {
  x: number;
  y: number;
  space?: Space;
  screenshot_id?: string;
  window?: number;
}

const sameBounds = (a: Bounds, b: Bounds) => a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;

/** Resolve a point in any coordinate space to integer root coordinates. */
export async function resolvePoint(p: PointInput, ctx: ResolveContext): Promise<{ x: number; y: number }> {
  const space = p.space ?? (p.screenshot_id ? 'screenshot' : 'screen');
  let x: number, y: number;
  switch (space) {
    case 'screen':
      x = p.x; y = p.y;
      break;
    case 'normalized': {
      if (p.x < 0 || p.x > 1 || p.y < 0 || p.y > 1) throw new ApiError('invalid_request', 'normalized coordinates must be within [0,1]');
      let b: Bounds = { x: 0, y: 0, ...ctx.root };
      if (p.window !== undefined) b = await windowBounds(ctx, p.window);
      x = b.x + p.x * (b.width - 1);
      y = b.y + p.y * (b.height - 1);
      break;
    }
    case 'window': {
      if (p.window === undefined) throw new ApiError('invalid_request', 'space "window" requires "window"');
      const b = await windowBounds(ctx, p.window);
      x = b.x + p.x; y = b.y + p.y;
      break;
    }
    case 'screenshot': {
      if (!p.screenshot_id) throw new ApiError('invalid_request', 'space "screenshot" requires "screenshot_id"');
      const e = ctx.registry.get(p.screenshot_id);
      if (e.geometryEpoch !== ctx.geometryEpoch || e.root.width !== ctx.root.width || e.root.height !== ctx.root.height)
        throw new ApiError('stale_geometry', 'the screen geometry changed since the screenshot was taken');
      let origin = e.origin;
      if (e.window) {
        const now = await windowBounds(ctx, e.window.wid);
        if (!sameBounds(now, e.window.bounds)) throw new ApiError('stale_geometry', 'the window moved or resized since the screenshot was taken');
        origin = e.origin;
      }
      x = origin.x + p.x * (e.nativeSize.width / e.imageSize.width);
      y = origin.y + p.y * (e.nativeSize.height / e.imageSize.height);
      break;
    }
    default:
      throw new ApiError('invalid_request', `unknown coordinate space: ${space as string}`);
  }
  x = Math.round(x); y = Math.round(y);
  if (x < 0 || y < 0 || x >= ctx.root.width || y >= ctx.root.height)
    throw new ApiError('invalid_request', `point (${x},${y}) is outside the screen ${ctx.root.width}x${ctx.root.height}`);
  return { x, y };
}

async function windowBounds(ctx: ResolveContext, wid: number): Promise<Bounds> {
  if (!ctx.windowBounds) throw new ApiError('feature_unsupported', 'window coordinates are not available', { feature: 'windows' });
  try {
    return await ctx.windowBounds(wid);
  } catch (e) {
    if (e instanceof ApiError) throw e;
    throw new ApiError('target_unavailable', `window 0x${wid.toString(16)} does not exist`);
  }
}

/** Compute output size and scale for a max dimension. */
export function fitSize(width: number, height: number, maxDim?: number): { width: number; height: number; scale: number } {
  if (!maxDim || (width <= maxDim && height <= maxDim)) return { width, height, scale: 1 };
  const scale = Math.max(width, height) / maxDim;
  return { width: Math.max(1, Math.round(width / scale)), height: Math.max(1, Math.round(height / scale)), scale };
}
