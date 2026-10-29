// Light/dark: the viewer follows the desktop's GTK theme, and the toolbar toggle switches both.
// The first human viewer's prefers-color-scheme becomes the desktop default; it isn't changed after.
import { useEffect, useRef, useState } from 'react';
import { Button } from '@mieweb/ui/components/Button';
import { api } from './api';
import { useServerEvent } from './events';

type Scheme = 'light' | 'dark';
type ThemeState = { scheme: Scheme; set: boolean };

export const prefersScheme = (): Scheme => (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
export const applyScheme = (s: Scheme) => { document.documentElement.classList.toggle('dark', s === 'dark'); };

const putTheme = (body: { scheme: Scheme; if_unset?: boolean }) =>
  api<ThemeState>('/api/v1/desktop/theme', { method: 'PUT', body: JSON.stringify(body) });

/** With viewOnly, the toggle only changes this viewer and never sets the desktop's theme. */
export function ThemeToggle({ viewOnly }: { viewOnly: boolean }) {
  const [scheme, setScheme] = useState(prefersScheme);
  useEffect(() => applyScheme(scheme), [scheme]);
  // Bumped by every event and request; a response that arrives after a newer one is dropped.
  const gen = useRef(0);
  const latest = async (p: Promise<ThemeState>) => {
    const g = ++gen.current;
    const t = await p;
    if (g === gen.current) setScheme(t.scheme);
  };
  useServerEvent<ThemeState>('desktop.theme', (t) => { gen.current++; setScheme(t.scheme); });
  // On every (re)connect: the stream doesn't replay changes missed while it was down.
  useServerEvent('hello', () => {
    const g = ++gen.current;
    void api<ThemeState>('/api/v1/desktop/theme').then((t) => {
      if (g !== gen.current) return;
      if (t.set) return setScheme(t.scheme);
      if (!viewOnly) void latest(putTheme({ scheme: prefersScheme(), if_unset: true }));
    });
  });

  const next: Scheme = scheme === 'dark' ? 'light' : 'dark';
  const toggle = () => {
    if (!viewOnly) return void latest(putTheme({ scheme: next }));
    gen.current++;
    setScheme(next);
  };
  return (
    <Button id="btn-theme" size="sm" variant="outline" onClick={toggle}
      title={`Switch ${viewOnly ? 'this viewer' : 'the viewer and the desktop'} to ${next} mode`}>
      {next === 'dark' ? 'Dark' : 'Light'}
    </Button>
  );
}
