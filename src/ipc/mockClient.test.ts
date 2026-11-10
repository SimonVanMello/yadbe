import { beforeEach, describe, expect, it, vi } from 'vitest';

import { mockBackend, mockClient } from './mockClient';
import { unwrap, YadbeIpcError } from './result';

beforeEach(() => {
  mockBackend.reset();
});

describe('mock client', () => {
  it('answers app_info like the real command', async () => {
    const info = await unwrap(mockClient.commands.appInfo());
    expect(info).toEqual({ appVersion: '0.1.0', os: 'linux', arch: 'x86_64' });
  });

  it('delivers events to subscribers until they unsubscribe', () => {
    const handler = vi.fn();
    const unsubscribe = mockClient.events.subscribe('appReady', handler);
    mockBackend.emit('appReady', { appVersion: '1.2.3' });
    expect(handler).toHaveBeenCalledWith({ appVersion: '1.2.3' });
    unsubscribe();
    mockBackend.emit('appReady', { appVersion: '1.2.4' });
    expect(handler).toHaveBeenCalledTimes(1);
    expect(mockBackend.events.listenerCount('appReady')).toBe(0);
  });
});

describe('unwrap', () => {
  it('throws the typed backend error', async () => {
    const error = {
      code: 'internal' as const,
      message: { en: 'Boom', fr: 'Boum' },
      action: null,
      detail: null,
    };
    await expect(unwrap(Promise.resolve({ status: 'error' as const, error }))).rejects.toThrow(
      YadbeIpcError,
    );
  });
});
