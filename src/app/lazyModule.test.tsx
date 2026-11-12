import { act, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { lazyComponent, lazyModule, loadLazyModules, preloadLazyModules } from './lazyModule';

function Hello({ name }: { name: string }) {
  return <p>Hello {name}</p>;
}

describe('lazyModule', () => {
  it('imports once, however often it is asked for', async () => {
    const importer = vi.fn(() => Promise.resolve(42));
    const module = lazyModule(importer);
    expect(module.current()).toBeUndefined();
    await Promise.all([module.load(), module.load()]);
    await module.load();
    expect(importer).toHaveBeenCalledTimes(1);
    expect(module.current()).toBe(42);
  });

  it('tries again after a failed import', async () => {
    const importer = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce('ok');
    const module = lazyModule(importer);
    await expect(module.load()).rejects.toThrow('offline');
    await expect(module.load()).resolves.toBe('ok');
    expect(module.current()).toBe('ok');
  });

  it('tells its subscribers when it is loaded', async () => {
    const module = lazyModule(() => Promise.resolve('x'));
    const listener = vi.fn();
    const off = module.subscribe(listener);
    await module.load();
    expect(listener).toHaveBeenCalledTimes(1);
    off();
  });
});

describe('lazyComponent', () => {
  it('renders nothing, then the component with its props once loaded', async () => {
    const Lazy = lazyComponent(() => Promise.resolve(Hello));
    const { container } = render(<Lazy name="Ana" />);
    expect(container).toBeEmptyDOMElement();
    expect(await screen.findByText('Hello Ana')).toBeInTheDocument();
  });

  it('waits for the background load when it is not loaded on render', async () => {
    const importer = vi.fn(() => Promise.resolve(Hello));
    const Lazy = lazyComponent(importer, { onRender: false });
    const { container } = render(<Lazy name="Bo" />);
    await act(() => Promise.resolve());
    expect(importer).not.toHaveBeenCalled();
    expect(container).toBeEmptyDOMElement();
    await act(() => loadLazyModules());
    expect(screen.getByText('Hello Bo')).toBeInTheDocument();
  });

  it('is loaded by the background preload, except the development pages', async () => {
    vi.useFakeTimers();
    try {
      const wanted = vi.fn(() => Promise.resolve(Hello));
      const skipped = vi.fn(() => Promise.resolve(Hello));
      lazyComponent(wanted);
      lazyComponent(skipped, { preload: false });
      preloadLazyModules();
      await vi.runAllTimersAsync();
      expect(wanted).toHaveBeenCalledTimes(1);
      expect(skipped).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
