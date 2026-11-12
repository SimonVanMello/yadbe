import { createElement, useEffect, useSyncExternalStore, type ComponentType } from 'react';

/**
 * Code kept out of the startup bundle (P-01): what the first paint does not need (dialogs, tool
 * tabs, the plan tree, the formatter) is loaded on first use, and in the background once the
 * window is shown, so it is there before anyone asks for it.
 */
export interface LazyModule<T> {
  /** The loaded value, `undefined` until then. */
  current: () => T | undefined;
  load: () => Promise<T>;
  subscribe: (listener: () => void) => () => void;
}

const registry: LazyModule<unknown>[] = [];

/** `preload: false`: only on first use (the development pages). */
export function lazyModule<T>(
  importer: () => Promise<T>,
  { preload = true }: { preload?: boolean } = {},
): LazyModule<T> {
  let value: T | undefined;
  let pending: Promise<T> | undefined;
  const listeners = new Set<() => void>();
  const module: LazyModule<T> = {
    current: () => value,
    load: () => {
      pending ??= importer().then(
        (loaded) => {
          value = loaded;
          for (const listener of listeners) listener();
          return loaded;
        },
        (error: unknown) => {
          // A later use tries again (a chunk that failed to load is not cached as failed).
          pending = undefined;
          throw error;
        },
      );
      return pending;
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
  if (preload) registry.push(module);
  return module;
}

/**
 * The module's value once loaded. `load`: asks for it on first render; otherwise it comes with
 * `preloadLazyModules`.
 */
export function useLazyModule<T>(module: LazyModule<T>, load = true): T | undefined {
  const value = useSyncExternalStore(module.subscribe, module.current);
  useEffect(() => {
    if (load && value === undefined) {
      module.load().catch((error: unknown) => {
        console.warn('Could not load a part of the interface', error);
      });
    }
  }, [module, value, load]);
  return value;
}

/**
 * A component whose code is loaded on demand; renders nothing until it is there (a few
 * milliseconds the first time, nothing once `preloadLazyModules` has run).
 *
 * `onRender: false` is for what is always mounted but shows nothing at first (the dialogs): it
 * waits for `preloadLazyModules`, so the startup does not load it.
 */
export function lazyComponent<P extends object>(
  importer: () => Promise<ComponentType<P>>,
  { preload = true, onRender = true }: { preload?: boolean; onRender?: boolean } = {},
): ComponentType<P> {
  const module = lazyModule(importer, { preload });
  function LazyComponent(props: P) {
    const Component = useLazyModule(module, onRender);
    return Component ? createElement(Component, props) : null;
  }
  return LazyComponent;
}

let preloading = false;

/**
 * Loads every lazy part, one at a time between other work, once the window is shown: opening a
 * dialog or a tool tab later never waits for its code, and the first paint never waited for it.
 */
export function preloadLazyModules(): void {
  if (preloading) return;
  preloading = true;
  const idle = (next: () => void) => {
    // A load can settle after the page is gone (a test environment torn down): stop there.
    if (typeof window === 'undefined') return;
    if (typeof window.requestIdleCallback === 'function') {
      window.requestIdleCallback(next, { timeout: 50 });
    } else {
      setTimeout(next, 0);
    }
  };
  let index = 0;
  const step = () => {
    const module = registry[index++];
    if (!module) return;
    module.load().then(
      () => {
        idle(step);
      },
      () => {
        idle(step);
      },
    );
  };
  idle(step);
}

/** Every lazy part at once (tests of the whole window: the state the app is in after startup). */
export async function loadLazyModules(): Promise<void> {
  await Promise.all(registry.map((module) => module.load()));
}
