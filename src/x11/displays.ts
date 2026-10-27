import type { XSession } from './connection.js';

export interface DisplayInfo {
  id: string;
  name: string;
  primary: boolean;
  bounds: { x: number; y: number; width: number; height: number };
  scale: 1;
}

const p = <T>(fn: (cb: (err: unknown, res: T) => void) => void) =>
  new Promise<T>((resolve, reject) => fn((err, res) => (err ? reject(err) : resolve(res))));

export async function listDisplays(s: XSession): Promise<DisplayInfo[]> {
  const root: DisplayInfo = {
    id: 'root', name: 'root', primary: true, scale: 1,
    bounds: { x: 0, y: 0, width: s.width, height: s.height },
  };
  const rr = s.ext.randr;
  if (!rr) return [root];
  try {
    const res: any = await p((cb) => rr.GetScreenResourcesCurrent ? rr.GetScreenResourcesCurrent(s.root, cb) : rr.GetScreenResources(s.root, cb));
    const out: DisplayInfo[] = [];
    for (const output of res.outputs ?? []) {
      const info: any = await p((cb) => rr.GetOutputInfo(output, res.config_timestamp ?? 0, cb));
      if (!info.crtc) continue;
      const crtc: any = await p((cb) => rr.GetCrtcInfo(info.crtc, res.config_timestamp ?? 0, cb));
      if (!crtc.width || !crtc.height) continue;
      out.push({
        id: String(output), name: String(info.name ?? output), primary: out.length === 0, scale: 1,
        bounds: { x: crtc.x, y: crtc.y, width: crtc.width, height: crtc.height },
      });
    }
    return out.length ? out : [root];
  } catch {
    return [root];
  }
}
