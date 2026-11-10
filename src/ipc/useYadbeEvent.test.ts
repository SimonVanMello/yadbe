import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { mockBackend } from './mockClient';
import { useYadbeEvent } from './useYadbeEvent';

beforeEach(() => {
  mockBackend.reset();
});

describe('useYadbeEvent', () => {
  it('delivers events to the latest handler and unsubscribes on unmount', () => {
    const first = vi.fn();
    const second = vi.fn();
    const { rerender, unmount } = renderHook(
      ({ handler }) => {
        useYadbeEvent('appReady', handler);
      },
      { initialProps: { handler: first } },
    );

    act(() => {
      mockBackend.emit('appReady', { appVersion: '1' });
    });
    expect(first).toHaveBeenCalledWith({ appVersion: '1' });

    rerender({ handler: second });
    act(() => {
      mockBackend.emit('appReady', { appVersion: '2' });
    });
    expect(second).toHaveBeenCalledWith({ appVersion: '2' });
    expect(first).toHaveBeenCalledTimes(1);
    expect(mockBackend.events.listenerCount('appReady')).toBe(1);

    unmount();
    expect(mockBackend.events.listenerCount('appReady')).toBe(0);
  });
});
