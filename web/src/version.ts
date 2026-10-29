// Text for the toolbar's version button, from GET /api/v1/update (kept DOM-free for unit tests).
export type UpdateStatus = {
  supported: boolean;
  limitation?: string;
  available?: boolean;
  current: string | null;
  latest?: string | null;
  checked_at?: string | null;
  error?: string | null;
  upgrade?: { state: string; log: string };
};

export function versionTitle(s: UpdateStatus | null): string {
  if (!s?.supported) return `Update checks unavailable: ${s?.limitation ?? 'update checks are not running'}`;
  return [
    s.checked_at ? `Last checked ${new Date(s.checked_at).toLocaleString()}` : 'Not checked yet',
    s.error ? `Last check failed: ${s.error}` : s.latest && `Latest release: ${s.latest}`,
    'Click to check for updates now.',
  ].filter(Boolean).join('\n');
}

export const checkResult = (s: UpdateStatus) =>
  s.error ? `Update check failed: ${s.error}` : s.available ? `ozwell-computer ${s.latest} is available` : 'Up to date';
