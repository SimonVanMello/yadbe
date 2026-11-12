import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

// The app reads its language's catalog before the first render; tests switch languages freely.
if (typeof window !== 'undefined') {
  const { loadLocale, locales } = await import('../i18n/i18n');
  await Promise.all(locales.map(loadLocale));
}

afterEach(() => {
  cleanup();
});

// jsdom does not implement scrollIntoView either.
if (typeof Element !== 'undefined') {
  Element.prototype.scrollIntoView = () => undefined;
}

// jsdom does not implement ResizeObserver (Radix and the shell measure with it).
if (typeof window !== 'undefined' && !('ResizeObserver' in window)) {
  class ResizeObserverStub {
    observe(): void {
      // Nothing resizes in jsdom.
    }
    unobserve(): void {
      // See observe.
    }
    disconnect(): void {
      // See observe.
    }
  }
  Object.defineProperty(window, 'ResizeObserver', { writable: true, value: ResizeObserverStub });
  Object.defineProperty(globalThis, 'ResizeObserver', {
    writable: true,
    value: ResizeObserverStub,
  });
}

// jsdom does not implement matchMedia (setup also runs for `node` environment tests).
if (typeof window !== 'undefined') {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: (query: string): MediaQueryList => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
    }),
  });
}
