// Light/dark: the viewer follows the desktop's GTK theme, and the toolbar toggle switches both.
// The first human viewer's prefers-color-scheme becomes the desktop default; it isn't changed after.
import { useEffect, useState } from 'react';
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
  useServerEvent<ThemeState>('desktop.theme', (t) => setScheme(t.scheme));
  useEffect(() => {
    void api<ThemeState>('/api/v1/desktop/theme').then(async (t) => {
      if (t.set) return setScheme(t.scheme);
      if (!viewOnly) setScheme((await putTheme({ scheme: prefersScheme(), if_unset: true })).scheme);
    });
  }, []);

  const next: Scheme = scheme === 'dark' ? 'light' : 'dark';
  const toggle = async () => setScheme(viewOnly ? next : (await putTheme({ scheme: next })).scheme);
  return (
    <Button id="btn-theme" size="sm" variant="outline" onClick={toggle}
      title={`Switch ${viewOnly ? 'this viewer' : 'the viewer and the desktop'} to ${next} mode`}>
      {next === 'dark' ? 'Dark' : 'Light'}
    </Button>
  );
}
