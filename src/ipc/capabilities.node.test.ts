// @vitest-environment node
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const capabilities = JSON.parse(
  readFileSync(new URL('../../src-tauri/capabilities/default.json', import.meta.url), 'utf8'),
) as { identifier: string; windows: string[]; permissions: string[] };

describe('window capabilities', () => {
  it('grants the main window only the core defaults', () => {
    expect(capabilities.windows).toEqual(['main']);
    expect(capabilities.permissions).toEqual(['core:default']);
  });
});
