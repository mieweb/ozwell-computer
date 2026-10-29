import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Login } from './Login';
import { Viewer } from './Viewer';
import './index.css';

type Capabilities = { display: { name: string }; features: { vnc: { view_only: boolean } } };

function App() {
  const [caps, setCaps] = useState<Capabilities | 'login' | null>(null);
  useEffect(() => {
    void fetch('/api/v1/capabilities', { credentials: 'same-origin' }).then(async (r) => {
      if (r.status === 401) return setCaps('login');
      const c: Capabilities = await r.json();
      document.title = `desktop ${c.display.name}`;
      setCaps(c);
    });
  }, []);
  if (caps === 'login') return <Login />;
  return caps && <Viewer serverViewOnly={caps.features.vnc.view_only} />;
}

createRoot(document.getElementById('root')!).render(<App />);
