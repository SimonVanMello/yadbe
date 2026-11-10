import { beforeEach, describe, expect, it } from 'vitest';

import { createMockFiles } from './mockFiles';

let files: ReturnType<typeof createMockFiles>;
beforeEach(() => {
  files = createMockFiles();
});

describe('the mock disk', () => {
  it('writes a script and reads it back', async () => {
    expect(await files.commands.writeTextFile('/home/ana/q/new.sql', 'select 1;')).toEqual({
      status: 'ok',
      data: null,
    });
    expect(await files.commands.readTextFile('/home/ana/q/new.sql')).toEqual({
      status: 'ok',
      data: 'select 1;',
    });
  });

  it('answers a missing file with the typed not-found error', async () => {
    const result = await files.commands.readTextFile('/home/ana/q/gone.sql');
    expect(result).toMatchObject({ status: 'error', error: { code: 'fileNotFound' } });
  });

  it('refuses relative paths and files that are not scripts, like the backend', async () => {
    expect(await files.commands.readTextFile('notes.sql')).toMatchObject({
      status: 'error',
      error: { code: 'invalidArgument' },
    });
    expect(await files.commands.writeTextFile('/home/ana/.ssh/id_rsa', 'x')).toMatchObject({
      status: 'error',
      error: { code: 'invalidArgument' },
    });
  });

  it('lets tests change a file behind the app’s back, and starts over on reset', () => {
    files.set('/home/ana/q/a.sql', 'one');
    expect(files.get('/home/ana/q/a.sql')).toBe('one');
    files.set('/home/ana/q/a.sql', null);
    expect(files.get('/home/ana/q/a.sql')).toBeUndefined();
    files.set('/home/ana/q/b.sql', 'two');
    files.reset();
    expect(files.get('/home/ana/q/b.sql')).toBeUndefined();
    expect(files.get('/home/ana/queries/orders-report.sql')).toContain('select');
  });
});
