// Toolbar: container resource use (from the Prometheus endpoint) and update notices.

const MiB = (b) => `${Math.round(b / 2 ** 20)} MiB`;

/** The few series the toolbar shows, from Prometheus text format. */
export function readMetrics(text) {
  const out = {};
  for (const line of text.split('\n')) {
    if (line.startsWith('#')) continue;
    const m = /^(\w+)(\{[^}]*\})? (\S+)$/.exec(line);
    if (!m) continue;
    const [, name, labels = '', value] = m;
    const v = Number(value);
    if (name === 'ozwell_cgroup_cpu_seconds_total') out.cpu = v;
    else if (name === 'ozwell_cgroup_memory_bytes' && labels.includes('scope="container"')) out.mem = v;
    else if (name === 'ozwell_cgroup_memory_limit_bytes') out.limit = v;
    else if (name === 'ozwell_vnc_sent_bytes_total') out.vnc = v;
  }
  return out;
}

export function initPerf(el, intervalMs = 5000) {
  let prev = null;
  async function tick() {
    try {
      const res = await fetch('/api/v1/metrics', { credentials: 'same-origin' });
      if (!res.ok) throw new Error(res.statusText);
      const now = { ...readMetrics(await res.text()), t: performance.now() };
      const parts = [];
      if (prev && now.cpu !== undefined && prev.cpu !== undefined) {
        const pct = ((now.cpu - prev.cpu) / ((now.t - prev.t) / 1000)) * 100;
        parts.push(`<span class="${pct > 80 ? 'hot' : ''}">CPU ${Math.max(0, pct).toFixed(0)}%</span>`);
      }
      if (now.mem !== undefined) {
        const hot = now.limit && now.mem / now.limit > 0.85;
        parts.push(`<span class="${hot ? 'hot' : ''}">Mem ${MiB(now.mem)}${now.limit ? ` / ${MiB(now.limit)}` : ''}</span>`);
      }
      if (prev && now.vnc !== undefined && prev.vnc !== undefined) {
        const kbs = (now.vnc - prev.vnc) / ((now.t - prev.t) / 1000) / 1024;
        parts.push(`VNC ${kbs >= 1024 ? `${(kbs / 1024).toFixed(1)} MB/s` : `${kbs.toFixed(0)} KB/s`}`);
      }
      el.innerHTML = parts.join(' · ');
      prev = now;
    } catch {
      el.textContent = '';
      prev = null;
    }
  }
  tick();
  setInterval(tick, intervalMs);
}

export function initUpdate(btn, events) {
  let status = null;
  const api = (path, method = 'GET') => fetch(path, { method, credentials: 'same-origin' }).then((r) => r.json());

  function render(s) {
    status = s;
    btn.className = '';
    btn.hidden = true;
    if (!s || !s.supported) return;
    const st = s.upgrade?.state;
    if (st === 'requested' || st === 'running') {
      btn.hidden = false; btn.disabled = true; btn.className = 'busy';
      btn.textContent = 'Updating…';
      btn.title = s.upgrade.log.split('\n').filter(Boolean).slice(-3).join('\n');
    } else if (st === 'failed') {
      btn.hidden = false; btn.disabled = false; btn.className = 'failed';
      btn.textContent = 'Update failed';
      btn.title = `Click to retry.\n\n${s.upgrade.log.split('\n').filter(Boolean).slice(-8).join('\n')}`;
    } else if (s.available) {
      btn.hidden = false; btn.disabled = false;
      btn.textContent = `Update to ${s.latest}`;
      btn.title = `ozwell-computer ${s.latest} is available (installed: ${s.current}). The server restarts; open apps keep running.`;
    }
  }

  btn.onclick = async () => {
    if (!status) return;
    if (!confirm(`Upgrade ozwell-computer ${status.current} → ${status.latest ?? 'latest'}?\nThe viewer reconnects when the server restarts.`)) return;
    try { render(await api('/api/v1/update/apply', 'POST')); } catch (e) { alert(`Could not start the upgrade: ${e.message}`); }
  };

  events.addEventListener('update.status', (e) => render(JSON.parse(e.data)));
  // After an upgrade the server restarts: refresh on reconnect, and poll while busy.
  events.addEventListener('hello', () => api('/api/v1/update').then(render, () => render(null)));
  setInterval(() => {
    const st = status?.upgrade?.state;
    if (st === 'requested' || st === 'running') api('/api/v1/update').then(render, () => undefined);
  }, 3000);
}
