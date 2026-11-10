import { useSyncExternalStore } from 'react';

const FALLBACK_PX = 28;

function readHeight(): number {
  const value = parseFloat(
    getComputedStyle(document.documentElement).getPropertyValue('--row-height'),
  );
  return Number.isFinite(value) && value > 0 ? value : FALLBACK_PX;
}

// Read once and cached: `getComputedStyle` forces a style recalculation. Only the density and
// the theme change it.
let cached: number | null = null;
const listeners = new Set<() => void>();
let observer: MutationObserver | null = null;

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (!observer && typeof MutationObserver !== 'undefined') {
    observer = new MutationObserver(() => {
      cached = null;
      for (const notify of listeners) notify();
    });
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-density', 'data-theme'],
    });
  }
  return () => {
    listeners.delete(listener);
  };
}

function snapshot(): number {
  cached ??= readHeight();
  return cached;
}

/** `--row-height` in px; follows the comfortable / compact density switch and the theme. */
export function useRowHeight(): number {
  return useSyncExternalStore(subscribe, snapshot);
}
