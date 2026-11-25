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
      // With a JS close-requested listener, @tauri-apps/api closes the window by destroying it.
      'core:window:allow-destroy',
      'core:window:allow-start-dragging',
      'core:window:allow-is-maximized',
      'core:window:allow-set-title',
      // Open and save dialogs (SQLite files, SQL scripts): no file system access of their own,
      // scripts are read and written by the `read_text_file` / `write_text_file` commands.
      'dialog:allow-open',
      'dialog:allow-save',
    ]);
  });

  it('grants every window command the native window calls, the close guard included', () => {
    const source = readFileSync(new URL('./nativeWindow.ts', import.meta.url), 'utf8');
    const called = new Set(
      [...source.matchAll(/getCurrentWindow\(\)\s*\.(\w+)\(/g)].map((match) => match[1] ?? ''),
    );
    expect(called).toContain('onCloseRequested');
    // Events go through `core:default`; only commands need a window permission.
    const commands = [...called].filter((name) => !/^on[A-Z]/.test(name));
    // Once a close-requested listener exists, Tauri leaves the close to JavaScript, and the
    // listener's wrapper destroys the window: without `destroy` nothing closes it (M4-16).
    const api = readFileSync(
      new URL('../../node_modules/@tauri-apps/api/window.js', import.meta.url),
      'utf8',
    );
    expect(api).toMatch(/async onCloseRequested\(handler\)[\s\S]*?await this\.destroy\(\)/);
    commands.push('destroy');
    for (const command of commands) {
      const kebab = command.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
      expect(capabilities.permissions).toContain(`core:window:allow-${kebab}`);
    }
  });

  it('draws its own title bar and shows the window once the UI is ready', () => {
    const main = config.app.windows.find((window) => window.label === 'main');
    expect(main?.decorations).toBe(false);
    expect(main?.visible).toBe(false);
  });
});
