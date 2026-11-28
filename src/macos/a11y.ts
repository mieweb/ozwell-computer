import type { Logger } from 'pino';
import type { AccessibilityBackend } from '../backend.js';
import type { A11yNode, TreeOptions, FindOptions } from '../a11y/atspi.js';
import { ApiError, unsupported } from '../errors.js';
import { MacDesktop, macWindowId } from './desktop.js';
import type { WindowElement } from '@trycua/cua-driver';

const ROLES: Record<string, string> = {
  AXApplication: 'application', AXWindow: 'window', AXDialog: 'dialog', AXButton: 'button',
  AXCheckBox: 'checkbox', AXRadioButton: 'radio', AXTextField: 'text_field', AXTextArea: 'text_field',
  AXStaticText: 'text', AXMenuBar: 'menubar', AXMenu: 'menu', AXMenuItem: 'menuitem', AXPopUpButton: 'combobox',
  AXComboBox: 'combobox', AXList: 'list', AXRow: 'row', AXCell: 'cell', AXTable: 'table', AXOutline: 'tree',
  AXTabGroup: 'tablist', AXTab: 'tab', AXGroup: 'group', AXImage: 'image', AXLink: 'link', AXHeading: 'heading',
  AXScrollArea: 'scroll_area', AXScrollBar: 'scrollbar', AXSlider: 'slider', AXProgressIndicator: 'progressbar',
  AXToolbar: 'toolbar', AXSplitGroup: 'split_group', AXWebArea: 'document', AXSeparator: 'separator',
};
export const macRole = (role: string) => ROLES[role] ?? role.replace(/^AX/, '').replace(/([a-z])([A-Z])/g, '$1_$2').replace(/\s+/g, '_').toLowerCase();

interface ElementRef { pid: number; windowId: bigint; nativeSnapshotId?: string; token?: string; actions: string[] }
interface Snapshot { id: string; created: number; elements: Map<string, ElementRef> }

/** AX observations retain exact native window and element tokens; there is no visual fallback. */
export class MacA11y implements AccessibilityBackend {
  private sequence = 0;
  private snapshots: Snapshot[] = [];
  private latest = new Map<bigint, string | undefined>();

  constructor(private readonly mode: 'auto' | 'on' | 'off', private readonly log: Logger, private readonly desktop: MacDesktop) {}

  async capability() {
    if (this.mode === 'off') return { available: false, limitation: 'disabled by OZWELL_COMPUTER_A11Y=off' };
    try {
      const available = await this.desktop.accessibilityAvailable();
      return { available, limitation: available
        ? 'Native AX tree and token-based press only; coverage depends on the app. Focus, set_value, and hidden nodes are unsupported; no foreground fallback.'
        : 'Grant Accessibility permission to Cua Driver in macOS System Settings' };
    } catch (error) { return { available: false, limitation: error instanceof Error ? error.message : String(error) }; }
  }

  private async enabled() {
    if (this.mode === 'off') throw unsupported('a11y', 'accessibility is disabled (OZWELL_COMPUTER_A11Y=off)');
    if (!await this.desktop.accessibilityAvailable()) throw new ApiError('permission_denied', 'Grant Accessibility permission to Cua Driver in macOS System Settings');
  }

  private states(element: WindowElement) {
    return [element.enabled === true ? 'enabled' : null, element.selected === true ? 'selected' : null].filter((state): state is string => state !== null);
  }

  private actions(element: WindowElement) {
    return element.elementToken && element.actions?.some((action) => /^(?:AX)?(?:press|click|activate)$/i.test(action)) ? ['press'] : [];
  }

  async tree(options: TreeOptions = {}): Promise<{ snapshot_id: string; truncated: boolean; nodes: A11yNode[] }> {
    await this.enabled();
    if (options.hidden) throw unsupported('a11y', 'hidden-node inclusion is not implemented in the macOS pilot');
    const maxNodes = Math.min(options.max_nodes ?? 5000, 20000), maxDepth = options.max_depth ?? 64;
    if (!Number.isInteger(maxNodes) || maxNodes <= 0 || !Number.isInteger(maxDepth) || maxDepth < 0) throw new ApiError('invalid_request', 'max_nodes must be positive and max_depth must be nonnegative integers');
    return this.desktop.runInput(async () => {
      const snapshot: Snapshot = { id: `mac${++this.sequence}`, created: Date.now(), elements: new Map() };
      const nodes: A11yNode[] = [];
      let truncated = false;
      const windows = options.window
        ? [await this.desktop.nativeWindow(macWindowId(options.window))]
        : await this.desktop.nativeCall((client) => client.windows());
      for (const window of windows) {
        if (nodes.length >= maxNodes) { truncated = true; break; }
        if (window.pid === undefined) {
          if (options.window) throw new ApiError('target_unavailable', 'window has no accessible owning process');
          continue;
        }
        let state;
        try {
          state = await this.desktop.nativeCall((client) => client.windowState(window.pid!, window.windowId, { maxElements: maxNodes - nodes.length, maxDepth }));
        } catch (error) {
          if (!options.window && error instanceof ApiError && error.reason === 'target_unavailable') { truncated = true; continue; }
          throw error;
        }
        if (state.pid !== window.pid || state.windowId !== window.windowId) throw new ApiError('target_unavailable', 'Cua returned accessibility data for a different window');
        if (state.degraded && !state.elements?.length) throw unsupported('a11y', state.degradedReason ?? 'native accessibility observation is unavailable');
        this.latest.set(window.windowId, state.snapshotId);
        // Cua clamps maxDepth=0 to one. Enforce Ozwell's requested depth at
        // the adapter boundary so omitted descendants also lose action handles.
        const elements = (state.elements ?? []).filter((element) => element.depth <= maxDepth).slice(0, maxNodes - nodes.length);
        truncated ||= !!state.truncated || state.elementsComplete === false || (state.elements?.length ?? 0) > elements.length;
        const idFor = (index: bigint) => `${snapshot.id}.${window.windowId.toString(16)}.${index}`;
        const present = new Set(elements.map((element) => element.elementIndex));
        for (const element of elements) {
          const id = idFor(element.elementIndex);
          const actions = this.actions(element);
          snapshot.elements.set(id, { pid: window.pid, windowId: window.windowId, nativeSnapshotId: state.snapshotId, token: element.elementToken, actions });
          nodes.push({
            element_id: id, parent_id: element.parentIndex !== undefined && present.has(element.parentIndex) ? idFor(element.parentIndex) : null,
            depth: element.depth, role: macRole(element.role), native_role: element.role,
            name: element.label ?? '', value: element.value ?? null, description: element.valueDescription ?? '',
            // The pinned macOS AX walker stores element_screen_rect directly:
            // global logical points, independent of screenshot raster scaling.
            bounds: element.frame ? { x: element.frame.x, y: element.frame.y, width: element.frame.w, height: element.frame.h } : null,
            states: this.states(element), actions, app: state.appName ?? window.appName,
          });
        }
      }
      this.snapshots.push(snapshot);
      while (this.snapshots.length > 8) this.snapshots.shift();
      return { snapshot_id: snapshot.id, truncated, nodes };
    });
  }

  async find(options: FindOptions) {
    const { snapshot_id, nodes, truncated } = await this.tree({ window: options.window, max_nodes: 20000 });
    const name = options.name_contains?.toLowerCase(), description = options.description_contains?.toLowerCase(), value = options.value_contains?.toLowerCase();
    const matches = nodes.filter((node) =>
      (!options.role || node.role === options.role || node.native_role === options.role) &&
      (!options.name || node.name === options.name) &&
      (!options.name_empty || node.name === '') &&
      (!name || node.name.toLowerCase().includes(name)) &&
      (!options.description || node.description === options.description) &&
      (!description || node.description.toLowerCase().includes(description)) &&
      (!value || (node.value ?? '').toLowerCase().includes(value)) &&
      (!options.states || options.states.every((state) => node.states.includes(state))));
    return { snapshot_id, truncated, matches: matches.slice(0, options.max_results ?? 50), total: matches.length };
  }

  async act(snapshotId: string, elementId: string, action: string, _value?: string) {
    await this.enabled();
    return this.desktop.runInput(async () => {
      const snapshot = this.snapshots.find((candidate) => candidate.id === snapshotId);
      if (!snapshot || Date.now() - snapshot.created > 120_000) throw new ApiError('stale_snapshot', `snapshot ${snapshotId} expired; fetch the tree again`);
      const element = snapshot.elements.get(elementId);
      if (!element) throw new ApiError('target_unavailable', `element ${elementId} is not in snapshot ${snapshotId}`);
      if (!element.nativeSnapshotId || this.latest.get(element.windowId) !== element.nativeSnapshotId) throw new ApiError('stale_snapshot', 'the native accessibility snapshot was superseded; fetch the tree again');
      if (action !== 'press' || !element.actions.includes('press') || !element.token) throw unsupported('a11y', `native element does not support action "${action}"; the pilot supports AX press only`);
      const window = await this.desktop.nativeWindow(macWindowId(element.windowId));
      if (window.pid !== element.pid) throw new ApiError('stale_snapshot', 'the owning window process changed; fetch the tree again');
      await this.desktop.nativeCall((client) => client.pressElement(element.pid, element.windowId, element.token!, element.nativeSnapshotId!));
      this.latest.delete(element.windowId);
      this.log.debug({ window: String(element.windowId), snapshot: snapshotId }, 'native accessibility press delivered');
      return { ok: true, action: 'press' };
    });
  }

  async close() { this.snapshots = []; this.latest.clear(); }
}
