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
  it('grants only the main window the custom title bar and the file dialogs need', () => {
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
      // Open and save dialogs (SQLite files, SQL scripts): no file system access of their own,
      // scripts are read and written by the `read_text_file` / `write_text_file` commands.
      'dialog:allow-open',
      'dialog:allow-save',
    ]);
  });

  it('draws its own title bar and shows the window once the UI is ready', () => {
    const main = config.app.windows.find((window) => window.label === 'main');
    expect(main?.decorations).toBe(false);
    expect(main?.visible).toBe(false);
  });
});
