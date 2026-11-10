import { getNonce } from 'get-nonce';
import { afterEach, describe, expect, it } from 'vitest';

import { shareStyleNonce, styleNonce } from './cspNonce';

describe('style nonce', () => {
  afterEach(() => {
    document.head.querySelectorAll('style').forEach((style) => {
      style.remove();
    });
  });

  it('is absent when the page has no nonce (tauri dev, browser)', () => {
    document.head.append(document.createElement('style'));
    expect(styleNonce()).toBeNull();
  });

  it('is read from the page and handed to the libraries that inject styles', () => {
    const style = document.createElement('style');
    style.setAttribute('nonce', 'abc123');
    document.head.append(style);
    expect(styleNonce()).toBe('abc123');
    shareStyleNonce();
    expect(getNonce()).toBe('abc123');
  });
});
