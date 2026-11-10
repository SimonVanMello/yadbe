import { getCurrentWindow } from '@tauri-apps/api/window';

import type { Unsubscribe } from './client';

/** What the window asks before it closes (a transaction is open in one of its tabs). */
export interface CloseGuard {
  /** Whether closing would lose something: `false` lets the window close without asking. */
  hasWork: () => boolean;
  /** Asks the user; `true` lets the window close. */
  confirm: () => Promise<boolean>;
}

/**
 * Window-level integration (window buttons, title). Not part of the generated contract: these go
 * through Tauri's core window API, and degrade to browser behavior in mock mode.
 */
export interface NativeWindow {
  /** Whether the app runs in a Tauri window (overlay title bar on macOS, drawn buttons elsewhere). */
  readonly isNative: boolean;
  show: () => Promise<void>;
  minimize: () => Promise<void>;
  toggleMaximize: () => Promise<void>;
  close: () => Promise<void>;
  isMaximized: () => Promise<boolean>;
  /** Called after every resize (maximize, restore, snap…). */
  subscribeResized: (handler: () => void) => Unsubscribe;
  /** Window title (taskbar, window switcher; the macOS title bar). */
  setTitle: (title: string) => Promise<void>;
  /** Asks before the window closes, whatever closes it (button, shortcut, quit). */
  setCloseGuard: (guard: CloseGuard | null) => void;
}

let tauriGuard: CloseGuard | null = null;
let tauriGuardInstalled = false;

function installTauriCloseGuard(): void {
  if (tauriGuardInstalled) return;
  tauriGuardInstalled = true;
  let confirmed = false;
  getCurrentWindow()
    .onCloseRequested(async (event) => {
      const guard = tauriGuard;
      if (confirmed || !guard?.hasWork()) return;
      event.preventDefault();
      if (!(await guard.confirm())) return;
      // The window closes again, and this time nothing stops it.
      confirmed = true;
      await getCurrentWindow().close();
    })
    .catch((error: unknown) => {
      tauriGuardInstalled = false;
      console.warn('Could not watch the window close request', error);
    });
}

const tauriWindow: NativeWindow = {
  isNative: true,
  show: () => getCurrentWindow().show(),
  minimize: () => getCurrentWindow().minimize(),
  toggleMaximize: () => getCurrentWindow().toggleMaximize(),
  close: () => getCurrentWindow().close(),
  isMaximized: () => getCurrentWindow().isMaximized(),
  subscribeResized(handler) {
    let unlisten: (() => void) | undefined;
    let active = true;
    getCurrentWindow()
      .onResized(() => {
        handler();
      })
      .then((fn) => {
        if (active) unlisten = fn;
        else fn();
      })
      .catch((error: unknown) => {
        console.warn('Could not watch the window size', error);
      });
    return () => {
      active = false;
      unlisten?.();
    };
  },
  setTitle: (title) => getCurrentWindow().setTitle(title),
  setCloseGuard(guard) {
    tauriGuard = guard;
    if (guard) installTauriCloseGuard();
  },
};

let browserGuard: CloseGuard | null = null;

/** A browser cannot show its own dialog while unloading: it shows the browser's. */
function warnBeforeUnload(event: BeforeUnloadEvent): void {
  if (!browserGuard?.hasWork()) return;
  event.preventDefault();
}

const browserWindow: NativeWindow = {
  isNative: false,
  show: () => Promise.resolve(),
  minimize: () => Promise.resolve(),
  toggleMaximize: () => Promise.resolve(),
  close: () => Promise.resolve(),
  isMaximized: () => Promise.resolve(false),
  subscribeResized: () => () => undefined,
  // Read by the Playwright specs.
  setTitle: (title) => {
    document.title = title;
    return Promise.resolve();
  },
  setCloseGuard(guard) {
    browserGuard = guard;
    window.removeEventListener('beforeunload', warnBeforeUnload);
    if (guard) window.addEventListener('beforeunload', warnBeforeUnload);
  },
};

export const nativeWindow: NativeWindow =
  import.meta.env.VITE_MOCK === '1' ? browserWindow : tauriWindow;
