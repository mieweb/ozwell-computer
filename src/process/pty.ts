let mod: any | null | undefined;

export async function loadPty(): Promise<any | null> {
  if (mod !== undefined) return mod;
  try {
    const name = 'node-pty';
    const m: any = await import(name);
    mod = m.default ?? m;
    // Verify the native binding actually loads.
    if (typeof mod.spawn !== 'function') mod = null;
  } catch {
    mod = null;
  }
  return mod;
}

export async function ptyAvailable(): Promise<boolean> {
  return (await loadPty()) !== null;
}
