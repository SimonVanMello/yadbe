import { describe, expect, it } from 'vitest';

import { detectPlatform, formatShortcut } from './platform';

describe('platform', () => {
  it('detects the OS from the user agent', () => {
    expect(detectPlatform('Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5)')).toBe('mac');
    expect(detectPlatform('Mozilla/5.0 (Windows NT 10.0; Win64; x64)')).toBe('windows');
    expect(detectPlatform('Mozilla/5.0 (X11; Linux x86_64)')).toBe('linux');
  });

  it('formats shortcuts per platform', () => {
    expect(formatShortcut('Mod+Shift+K', 'mac')).toEqual(['⌘', '⇧', 'K']);
    expect(formatShortcut('Mod+Shift+K', 'windows')).toEqual(['Ctrl', 'Shift', 'K']);
    expect(formatShortcut('Mod+Enter', 'linux')).toEqual(['Ctrl', 'Enter']);
  });
});
