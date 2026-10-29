import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Login } from './Login';
import { Viewer } from './Viewer';
import './index.css';

type Capabilities = { display: { name: string }; features: { exec: { available: boolean }; vnc: { view_only: boolean } } };

function App() {
  const [caps, setCaps] = useState<Capabilities | 'login' | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const load = (): Promise<void> => fetch('/api/v1/capabilities', { credentials: 'same-origin' })
      .then(async (r) => {
        if (r.status === 401) return setCaps('login');
        if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
        const c: Capabilities = await r.json();
        document.title = `desktop ${c.display.name}`;
        setCaps(c);
      })
      .catch((e: Error) => {
        setError(e.message);
        setTimeout(load, 3000);
      });
    void load();
  }, []);
  if (caps === 'login') return <Login />;
  if (caps) return <Viewer serverViewOnly={caps.features.vnc.view_only} exec={caps.features.exec.available} />;
  return error && <p className="m-auto text-muted-foreground">Server unavailable ({error}), retrying…</p>;
}

createRoot(document.getElementById('root')!).render(<App />);
