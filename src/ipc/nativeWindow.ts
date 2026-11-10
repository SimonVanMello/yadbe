import { getCurrentWindow } from '@tauri-apps/api/window';

import type { Unsubscribe } from './client';

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
};

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
};

export const nativeWindow: NativeWindow =
  import.meta.env.VITE_MOCK === '1' ? browserWindow : tauriWindow;
