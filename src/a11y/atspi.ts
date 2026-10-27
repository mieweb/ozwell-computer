import dbus from 'dbus-next';
import type { Logger } from 'pino';
import { ApiError, unsupported } from '../errors.js';
import type { Desktop } from '../desktop.js';
import { getProperty, parseWindowId } from '../x11/windows.js';

const { Message } = dbus as any;

type Ref = [string, string]; // [bus name, object path]

const STATES = [
  'invalid', 'active', 'armed', 'busy', 'checked', 'collapsed', 'defunct', 'editable', 'enabled', 'expandable',
  'expanded', 'focusable', 'focused', 'has_tooltip', 'horizontal', 'iconified', 'modal', 'multi_line', 'multiselectable',
  'opaque', 'pressed', 'resizable', 'selectable', 'selected', 'sensitive', 'showing', 'single_line', 'stale', 'transient',
  'vertical', 'visible', 'manages_descendants', 'indeterminate', 'required', 'truncated', 'animated', 'invalid_entry',
  'supports_autocompletion', 'selectable_text', 'is_default', 'visited', 'checkable', 'has_popup', 'read_only',
];

/** AT-SPI role name → stable vocabulary. Unmapped roles pass through with spaces → underscores. */
const ROLE_MAP: Record<string, string> = {
  'push button': 'button', 'toggle button': 'toggle_button', 'check box': 'checkbox', 'radio button': 'radio',
  'entry': 'text_field', 'password text': 'text_field', 'text box': 'text_field', 'search box': 'text_field', 'generic': 'group', 'text': 'text', 'paragraph': 'text', 'label': 'label',
  'menu bar': 'menubar', 'menu': 'menu', 'menu item': 'menuitem', 'check menu item': 'menuitem_checkbox',
  'radio menu item': 'menuitem_radio', 'combo box': 'combobox', 'list': 'list', 'list box': 'list', 'list item': 'listitem',
  'page tab list': 'tablist', 'page tab': 'tab', 'tool bar': 'toolbar', 'tool tip': 'tooltip', 'scroll bar': 'scrollbar',
  'slider': 'slider', 'spin button': 'spinbutton', 'progress bar': 'progressbar', 'frame': 'window', 'window': 'window',
  'dialog': 'dialog', 'alert': 'alert', 'panel': 'group', 'filler': 'group', 'section': 'group', 'image': 'image',
  'icon': 'image', 'link': 'link', 'heading': 'heading', 'table': 'table', 'table cell': 'cell', 'tree': 'tree',
  'tree table': 'treegrid', 'tree item': 'treeitem', 'table row': 'row', 'column header': 'columnheader',
  'row header': 'rowheader', 'document frame': 'document', 'document web': 'document', 'application': 'application',
  'separator': 'separator', 'status bar': 'status', 'scroll pane': 'scroll_area', 'viewport': 'group',
  'split pane': 'split_group', 'canvas': 'canvas', 'terminal': 'terminal', 'desktop frame': 'desktop',
};
export const mapRole = (r: string) => ROLE_MAP[r] ?? r.replace(/\s+/g, '_');

/**
 * dbus-next opens `unix:path=`/`unix:abstract=` through the `usocket` native module,
 * which is broken on Node >= 23. Node's `net` handles both (abstract names via a
 * leading NUL), so rewrite them to `unix:socket=` which dbus-next passes to `net`.
 */
export function netBusAddress(address: string): string {
  return address
    .split(';')
    .map((a) => {
      const m = /^unix:(.*)$/.exec(a);
      if (!m) return a;
      const params = m[1].split(',');
      const kept = params.filter((p) => !/^(path|abstract)=/.test(p));
      const path = params.find((p) => p.startsWith('path='))?.slice(5);
      const abs = params.find((p) => p.startsWith('abstract='))?.slice(9);
      if (path === undefined && abs === undefined) return a;
      return `unix:socket=${path ?? '\0' + abs}${kept.length ? ',' + kept.join(',') : ''}`;
    })
    .join(';');
}

export interface A11yNode {
  element_id: string;
  parent_id: string | null;
  depth: number;
  role: string;
  native_role: string;
  name: string;
  value: string | null;
  description: string;
  bounds: { x: number; y: number; width: number; height: number } | null;
  states: string[];
  actions: string[];
  app?: string;
}

interface Snapshot { id: string; refs: Map<string, Ref>; created: number }

export interface TreeOptions { window?: string; max_depth?: number; max_nodes?: number; hidden?: boolean }
export interface FindOptions { role?: string; name?: string; name_contains?: string; value_contains?: string; states?: string[]; max_results?: number; window?: string }

export class A11y {
  private bus: any | null = null;
  private connecting: Promise<any> | null = null;
  private snapshots: Snapshot[] = [];
  private snapSeq = 0;
  private lastError: string | null = null;

  constructor(private mode: 'auto' | 'on' | 'off', private log: Logger, private desktop?: Desktop) {}

  setDesktop(d: Desktop) { this.desktop = d; }

  private async busAddress(): Promise<string | null> {
    if (process.env.AT_SPI_BUS_ADDRESS) return process.env.AT_SPI_BUS_ADDRESS;
    // at-spi-bus-launcher publishes the address on the root window.
    const s = this.desktop?.x.session;
    if (s) {
      const p = await getProperty(s, s.root, 'AT_SPI_BUS').catch(() => null);
      if (p?.data?.length) return p.data.toString('utf8').replace(/\0+$/, '');
    }
    if (process.env.DBUS_SESSION_BUS_ADDRESS) {
      try {
        const sb = dbus.sessionBus({ busAddress: netBusAddress(process.env.DBUS_SESSION_BUS_ADDRESS) } as any);
        const reply = await sb.call(new Message({ destination: 'org.a11y.Bus', path: '/org/a11y/bus', interface: 'org.a11y.Bus', member: 'GetAddress' }));
        sb.disconnect();
        return reply?.body?.[0] ?? null;
      } catch { /* none */ }
    }
    return null;
  }

  private async connect(): Promise<any> {
    if (this.mode === 'off') throw unsupported('a11y', 'accessibility is disabled (OZWELL_DESKTOP_A11Y=off)');
    if (this.bus) return this.bus;
    if (!this.connecting) {
      this.connecting = (async () => {
        const addr = await this.busAddress();
        if (!addr) throw unsupported('a11y', 'no AT-SPI bus found (AT_SPI_BUS root property or org.a11y.Bus); start at-spi2-core in the desktop session');
        const bus = dbus.sessionBus({ busAddress: netBusAddress(addr) } as any);
        bus.on('error', (e: Error) => { this.log.debug({ err: e.message }, 'a11y bus error'); this.bus = null; });
        await this.call(bus, 'org.a11y.atspi.Registry', '/org/a11y/atspi/accessible/root', 'org.a11y.atspi.Accessible', 'GetRoleName');
        this.bus = bus;
        this.lastError = null;
        return bus;
      })().catch((e) => {
        this.lastError = e.message;
        this.connecting = null;
        throw e instanceof ApiError ? e : unsupported('a11y', `cannot connect to the AT-SPI bus: ${e.message}`);
      });
    }
    return this.connecting;
  }

  async capability() {
    if (this.mode === 'off') return { available: false, limitation: 'disabled by OZWELL_DESKTOP_A11Y=off' };
    try {
      await this.connect();
      return { available: true, limitation: 'coverage depends on the toolkit; GTK/Qt/Firefox expose AT-SPI, xterm and plain X apps do not' };
    } catch (e) {
      return { available: false, limitation: (e as Error).message };
    }
  }

  private async call(bus: any, dest: string, path: string, iface: string, member: string, signature?: string, body?: unknown[]): Promise<any[]> {
    const msg = new Message({ destination: dest, path, interface: iface, member, ...(signature ? { signature, body } : {}) });
    const reply = await Promise.race([
      bus.call(msg),
      new Promise((_, rej) => setTimeout(() => rej(new Error(`timeout calling ${iface}.${member}`)), 2000)),
    ]);
    return (reply as any)?.body ?? [];
  }

  private async props(bus: any, ref: Ref, iface: string): Promise<Record<string, any>> {
    const [all] = await this.call(bus, ref[0], ref[1], 'org.freedesktop.DBus.Properties', 'GetAll', 's', [iface]);
    const out: Record<string, any> = {};
    for (const [k, v] of Object.entries(all ?? {})) out[k] = (v as any)?.value ?? v;
    return out;
  }

  private async describe(bus: any, ref: Ref) {
    const A = 'org.a11y.atspi.Accessible';
    const [props, [roleName], [stateBits], [ifaces]] = await Promise.all([
      this.props(bus, ref, A),
      this.call(bus, ref[0], ref[1], A, 'GetRoleName'),
      this.call(bus, ref[0], ref[1], A, 'GetState'),
      this.call(bus, ref[0], ref[1], A, 'GetInterfaces').catch(() => [[]]),
    ]);
    const states: string[] = [];
    (stateBits as number[] ?? []).forEach((word: number, wi: number) => {
      for (let b = 0; b < 32; b++) if (word & (1 << b)) { const n = STATES[wi * 32 + b]; if (n) states.push(n); }
    });
    const ifs = new Set<string>(ifaces ?? []);
    let bounds = null;
    if (ifs.has('org.a11y.atspi.Component')) {
      try {
        const [ext] = await this.call(bus, ref[0], ref[1], 'org.a11y.atspi.Component', 'GetExtents', 'u', [0]);
        if (ext) bounds = { x: ext[0], y: ext[1], width: ext[2], height: ext[3] };
      } catch { /* ignore */ }
    }
    const actions: string[] = [];
    if (ifs.has('org.a11y.atspi.Action')) {
      try {
        const [list] = await this.call(bus, ref[0], ref[1], 'org.a11y.atspi.Action', 'GetActions');
        for (const a of list ?? []) actions.push(a[0]);
      } catch { /* ignore */ }
    }
    let value: string | null = null;
    if (ifs.has('org.a11y.atspi.Value')) {
      try { value = String((await this.props(bus, ref, 'org.a11y.atspi.Value')).CurrentValue); } catch { /* ignore */ }
    } else if (ifs.has('org.a11y.atspi.Text') && (states.includes('editable') || roleName === 'entry')) {
      try { const [t] = await this.call(bus, ref[0], ref[1], 'org.a11y.atspi.Text', 'GetText', 'ii', [0, -1]); value = t ?? null; } catch { /* ignore */ }
    }
    if (ifs.has('org.a11y.atspi.EditableText') && !actions.includes('set_value')) actions.push('set_value');
    if (ifs.has('org.a11y.atspi.Component')) actions.push('focus');
    return {
      native_role: String(roleName ?? ''), name: String(props.Name ?? ''), description: String(props.Description ?? ''),
      childCount: Number(props.ChildCount ?? 0), states, bounds, actions, value, ifs,
    };
  }

  private async children(bus: any, ref: Ref): Promise<Ref[]> {
    const [kids] = await this.call(bus, ref[0], ref[1], 'org.a11y.atspi.Accessible', 'GetChildren');
    return (kids ?? []).map((k: any) => [k[0], k[1]] as Ref).filter((r: Ref) => r[1] !== '/org/a11y/atspi/null');
  }

  private async appPid(bus: any, name: string): Promise<number | null> {
    try {
      const [pid] = await this.call(bus, 'org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus', 'GetConnectionUnixProcessID', 's', [name]);
      return Number(pid);
    } catch { return null; }
  }

  /** Top-level roots to walk: all apps, or the frames that belong to one X window. */
  /** Roots to walk, each with the application name its nodes belong to ('' = use the root's own name). */
  private async roots(bus: any, window?: string): Promise<Array<{ ref: Ref; app: string }>> {
    const apps = await this.children(bus, ['org.a11y.atspi.Registry', '/org/a11y/atspi/accessible/root']);
    if (!window) return apps.map((ref) => ({ ref, app: '' }));
    if (!this.desktop) throw unsupported('a11y', 'window filter requires an X connection');
    const wm = this.desktop.ctl().windows;
    const info = await wm.info(await wm.resolve(parseWindowId(window)));
    const out: Array<{ ref: Ref; app: string }> = [];
    for (const app of apps) {
      if (info.pid !== null && (await this.appPid(bus, app[0])) !== info.pid) continue;
      const appName = String((await this.props(bus, app, 'org.a11y.atspi.Accessible').catch(() => ({} as any))).Name ?? '');
      const frames = await this.children(bus, app).catch(() => []);
      for (const f of frames) {
        const p = await this.props(bus, f, 'org.a11y.atspi.Accessible').catch(() => ({} as any));
        if (!info.title || String(p.Name ?? '') === info.title) out.push({ ref: f, app: appName });
      }
      if (out.length === 0 && info.pid !== null) out.push(...frames.map((ref) => ({ ref, app: appName })));
    }
    if (out.length === 0) throw new ApiError('target_unavailable', `no accessible objects found for window ${window}`);
    return out;
  }

  async tree(opts: TreeOptions = {}): Promise<{ snapshot_id: string; truncated: boolean; nodes: A11yNode[] }> {
    const bus = await this.connect();
    const maxNodes = Math.min(opts.max_nodes ?? 5000, 20000);
    const maxDepth = opts.max_depth ?? 64;
    const snap: Snapshot = { id: `s${++this.snapSeq}`, refs: new Map(), created: Date.now() };
    const nodes: A11yNode[] = [];
    let truncated = false;
    let seq = 0;
    const walk = async (ref: Ref, parent: string | null, depth: number, app: string) => {
      if (nodes.length >= maxNodes) { truncated = true; return; }
      let d;
      try { d = await this.describe(bus, ref); } catch { return; }
      if (!opts.hidden && parent !== null && depth > 1 && !(d.states.includes('showing') || d.states.includes('visible'))) return;
      const id = `${snap.id}.${++seq}`;
      snap.refs.set(id, ref);
      const appName = app || d.name;
      nodes.push({
        element_id: id, parent_id: parent, depth, role: mapRole(d.native_role), native_role: d.native_role, name: d.name,
        value: d.value, description: d.description, bounds: d.bounds, states: d.states, actions: d.actions, app: appName,
      });
      if (depth >= maxDepth) { if (d.childCount) truncated = true; return; }
      if (d.childCount > 2000) { truncated = true; return; }
      const kids = await this.children(bus, ref).catch(() => []);
      for (const k of kids) {
        if (nodes.length >= maxNodes) { truncated = true; return; }
        await walk(k, id, depth + 1, appName);
      }
    };
    const roots = await this.roots(bus, opts.window);
    for (const r of roots) await walk(r.ref, null, 0, r.app);
    this.snapshots.push(snap);
    while (this.snapshots.length > 8) this.snapshots.shift();
    return { snapshot_id: snap.id, truncated, nodes };
  }

  async find(o: FindOptions) {
    const { snapshot_id, nodes, truncated } = await this.tree({ window: o.window, max_nodes: 20000 });
    const max = o.max_results ?? 50;
    const nc = o.name_contains?.toLowerCase();
    const vc = o.value_contains?.toLowerCase();
    const matches = nodes.filter((n) =>
      (!o.role || n.role === o.role || n.native_role === o.role) &&
      (o.name === undefined || n.name === o.name) &&
      (!nc || n.name.toLowerCase().includes(nc)) &&
      (!vc || (n.value ?? '').toLowerCase().includes(vc)) &&
      (!o.states || o.states.every((s) => n.states.includes(s))),
    );
    return { snapshot_id, truncated, matches: matches.slice(0, max), total: matches.length };
  }

  async act(snapshotId: string, elementId: string, action: string, value?: string) {
    const bus = await this.connect();
    const snap = this.snapshots.find((s) => s.id === snapshotId);
    if (!snap) throw new ApiError('stale_snapshot', `snapshot ${snapshotId} expired; fetch the tree again`);
    const ref = snap.refs.get(elementId);
    if (!ref) throw new ApiError('target_unavailable', `element ${elementId} is not in snapshot ${snapshotId}`);
    let d;
    try { d = await this.describe(bus, ref); } catch { throw new ApiError('stale_snapshot', 'the element no longer exists'); }
    if (d.states.includes('defunct')) throw new ApiError('stale_snapshot', 'the element no longer exists');
    switch (action) {
      case 'focus': {
        const [ok] = await this.call(bus, ref[0], ref[1], 'org.a11y.atspi.Component', 'GrabFocus');
        return { ok: !!ok };
      }
      case 'set_value': {
        if (value === undefined) throw new ApiError('invalid_request', 'set_value requires value');
        if (d.ifs.has('org.a11y.atspi.EditableText')) {
          const [ok] = await this.call(bus, ref[0], ref[1], 'org.a11y.atspi.EditableText', 'SetTextContents', 's', [value]);
          return { ok: !!ok };
        }
        if (d.ifs.has('org.a11y.atspi.Value')) {
          const n = Number(value);
          if (!Number.isFinite(n)) throw new ApiError('invalid_request', 'value must be numeric for this element');
          await this.call(bus, ref[0], ref[1], 'org.freedesktop.DBus.Properties', 'Set', 'ssv', ['org.a11y.atspi.Value', 'CurrentValue', new (dbus as any).Variant('d', n)]);
          return { ok: true };
        }
        throw unsupported('a11y', 'element does not support set_value');
      }
      default: {
        const names = d.actions.filter((a) => a !== 'focus' && a !== 'set_value');
        const lower = names.map((a) => a.toLowerCase());
        let idx = lower.indexOf(action.toLowerCase());
        if (idx < 0 && action === 'press') idx = lower.findIndex((a) => ['click', 'press', 'activate', 'toggle', 'jump'].includes(a));
        if (idx < 0) throw unsupported('a11y', `element does not support action "${action}" (available: ${d.actions.join(', ') || 'none'})`);
        const [ok] = await this.call(bus, ref[0], ref[1], 'org.a11y.atspi.Action', 'DoAction', 'i', [idx]);
        return { ok: !!ok, action: names[idx] };
      }
    }
  }

  async close() {
    try { this.bus?.disconnect(); } catch { /* ignore */ }
    this.bus = null;
  }
}
