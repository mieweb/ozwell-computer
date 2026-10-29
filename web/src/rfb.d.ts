// noVNC is served unmodified from /novnc and loaded at runtime, not bundled (see paths in tsconfig.json).
export default class RFB {
  constructor(target: HTMLElement, url: string, options?: { shared?: boolean });
  scaleViewport: boolean;
  resizeSession: boolean;
  viewOnly: boolean;
  focusOnClick: boolean;
  focus(): void;
  sendCtrlAltDel(): void;
  sendKey(keysym: number, code: string | null, down?: boolean): void;
  addEventListener(type: 'connect', listener: () => void): void;
  addEventListener(type: 'disconnect', listener: (e: CustomEvent<{ clean: boolean }>) => void): void;
  addEventListener(type: 'clipboard', listener: (e: CustomEvent<{ text: string }>) => void): void;
}
