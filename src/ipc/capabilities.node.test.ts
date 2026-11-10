// @vitest-environment node
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const capabilities = JSON.parse(
  readFileSync(new URL('../../src-tauri/capabilities/default.json', import.meta.url), 'utf8'),
) as { identifier: string; windows: string[]; permissions: string[] };

const config = JSON.parse(
  readFileSync(new URL('../../src-tauri/tauri.conf.json', import.meta.url), 'utf8'),
) as { app: { windows: { label: string; decorations?: boolean; visible?: boolean }[] } };

describe('window capabilities', () => {
  it('grants only the main window the custom title bar and the open dialog need', () => {
    expect(capabilities.windows).toEqual(['main']);
    expect(capabilities.permissions).toEqual([
      'core:default',
      'core:window:allow-show',
      'core:window:allow-minimize',
      'core:window:allow-toggle-maximize',
      'core:window:allow-internal-toggle-maximize',
      'core:window:allow-close',
      'core:window:allow-start-dragging',
      'core:window:allow-is-maximized',
      'core:window:allow-set-title',
      // Open dialog only (SQLite files): no save dialog, no file system access.
      'dialog:allow-open',
    ]);
  });

  it('draws its own title bar and shows the window once the UI is ready', () => {
    const main = config.app.windows.find((window) => window.label === 'main');
    expect(main?.decorations).toBe(false);
    expect(main?.visible).toBe(false);
  });
});
