import type { Desktop, ScreenshotOptions, ScreenshotResult, PointerRequest, KeyboardRequest, InputResult } from './desktop.js';
import type { WindowManager } from './x11/windows.js';
import type { Clipboard } from './x11/clipboard.js';
import type { A11y } from './a11y/atspi.js';
import type { Principal } from './presence/index.js';

export interface Feature { available: boolean; limitation?: string }
export interface DesktopStatus {
  display: { name: string; connected: boolean; width?: number; height?: number; depth?: number; geometry_epoch?: number; error?: string | null };
  extensions: string[];
  features: Record<'screenshot' | 'input' | 'damage' | 'clipboard' | 'clipboard_events' | 'windows' | 'background_delivery' | 'vnc', Feature>;
}
export type WindowController = Pick<WindowManager, 'list' | 'resolve' | 'info' | 'bounds' | 'setBounds' | 'activate' | 'minimize' | 'maximize' | 'restore' | 'close'> & {
  hasWindowManager?: WindowManager['hasWindowManager'];
};
export type ClipboardController = Pick<Clipboard, 'read' | 'write'>;
export interface AccessibilityBackend extends Pick<A11y, 'tree' | 'find' | 'act' | 'close'> {
  capability(): Promise<Feature>;
}

/** Platform boundary used by HTTP and MCP. X11-specific VNC stays behind its own guard. */
export interface DesktopBackend {
  readonly kind: 'x11' | 'macos';
  readonly displayName: string;
  readonly bus: Desktop['bus'];
  readonly presence: Desktop['presence'];
  readonly registry: Desktop['registry'];
  start(): Promise<void>;
  stop(): Promise<void>;
  status(): DesktopStatus;
  ctl(): { windows: WindowController; clipboard: ClipboardController };
  displays(): ReturnType<Desktop['displays']>;
  screenshot(options: ScreenshotOptions): Promise<ScreenshotResult>;
  cursor(): ReturnType<Desktop['cursor']>;
  pointerAction(request: PointerRequest, principal?: Principal | null): Promise<InputResult>;
  keyboardAction(request: KeyboardRequest, principal?: Principal | null): Promise<InputResult>;
  launchApp(command: string, args?: string[], env?: Record<string, string>, cwd?: string): Promise<{ pid: number }>;
  open(target: string): Promise<{ pid: number }>;
}
