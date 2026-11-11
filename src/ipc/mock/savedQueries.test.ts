import { beforeEach, describe, expect, it } from 'vitest';

import type { NewSavedQuery } from '../bindings';
import { mockBackend, mockClient } from '../mockClient';
import { unwrap } from '../result';

const { commands } = mockClient;

const draft = (patch: Partial<NewSavedQuery> = {}): NewSavedQuery => ({
  name: 'q',
  sql: 'SELECT 1',
  description: '',
  tags: [],
  folderId: null,
  connectionId: null,
  database: null,
  snippetTrigger: null,
  ...patch,
});

const library = () => unwrap(commands.listSavedQueries());

beforeEach(() => {
  mockBackend.reset();
  mockBackend.setLatency(0);
});

describe('mock saved queries', () => {
  it('starts with folders, nested ones, queries of every scope and snippets', async () => {
    const { folders, queries } = await library();
    expect(folders.length).toBeGreaterThan(2);
    expect(folders.some((f) => f.parentId !== null)).toBe(true);
    expect(queries.some((q) => q.connectionId === null)).toBe(true);
    expect(queries.some((q) => q.connectionId !== null)).toBe(true);
    expect(queries.some((q) => q.lastUsedAt !== null)).toBe(true);
    const snippets = await unwrap(commands.listSnippets());
    expect(snippets.map((s) => s.trigger)).toContain('lastrows');
  });

  it('creates, reads whole, updates and deletes a query, announcing each change', async () => {
    let changes = 0;
    mockClient.events.subscribe('savedQueriesChanged', () => {
      changes += 1;
    });
    const created = await unwrap(
      commands.createSavedQuery(draft({ name: '  Orders ', tags: ['a', 'A', ' b '] })),
    );
    expect(created.name).toBe('Orders');
    expect(created.tags).toEqual(['a', 'b']);
    expect(changes).toBe(1);
    const updated = await unwrap(
      commands.updateSavedQuery(created.id, {
        name: 'Orders 2',
        sql: null,
        description: 'd',
        tags: [],
        folderId: null,
        connectionId: null,
        database: 'ignored',
        snippetTrigger: null,
      }),
    );
    expect(updated.sql).toBe('SELECT 1');
    expect(updated.database).toBeNull();
    await unwrap(commands.touchSavedQuery(created.id));
    expect(changes).toBe(2);
    expect((await unwrap(commands.getSavedQuery(created.id)))?.lastUsedAt).not.toBeNull();
    await unwrap(commands.deleteSavedQuery(created.id));
    expect(await unwrap(commands.getSavedQuery(created.id))).toBeNull();
    const again = await commands.deleteSavedQuery(created.id);
    expect(again.status === 'error' && again.error.code).toBe('savedQueryNotFound');
  });

  it('cuts long statements in the list and returns them whole from get', async () => {
    const long = `SELECT '${'é'.repeat(1000)}'`;
    const created = await unwrap(commands.createSavedQuery(draft({ sql: long })));
    const listed = (await library()).queries.find((q) => q.id === created.id);
    expect(listed?.sqlTruncated).toBe(true);
    expect(listed?.sql.length).toBe(400);
    expect((await unwrap(commands.getSavedQuery(created.id)))?.sql).toBe(long);
  });

  it('validates names, triggers, folders and connections', async () => {
    const code = async (patch: Partial<NewSavedQuery>) => {
      const result = await commands.createSavedQuery(draft(patch));
      return result.status === 'error' ? result.error.code : 'ok';
    };
    expect(await code({ name: '  ' })).toBe('invalidArgument');
    expect(await code({ name: 'x'.repeat(121) })).toBe('invalidArgument');
    expect(await code({ snippetTrigger: '1abc' })).toBe('invalidArgument');
    expect(await code({ snippetTrigger: 'a b' })).toBe('invalidArgument');
    expect(await code({ snippetTrigger: '  ' })).toBe('ok');
    expect(await code({ folderId: 'nope' })).toBe('queryFolderNotFound');
    expect(await code({ connectionId: 'nope' })).toBe('connectionNotFound');
    expect(await code({ tags: Array.from({ length: 13 }, (_, i) => `t${String(i)}`) })).toBe(
      'invalidArgument',
    );
  });

  it('moves folders without cycles and within the depth limit', async () => {
    const a = await unwrap(commands.createQueryFolder('A', null));
    const b = await unwrap(commands.createQueryFolder('B', a.id));
    const c = await unwrap(commands.createQueryFolder('C', b.id));
    for (const target of [c.id, a.id]) {
      const result = await commands.moveQueryFolder(a.id, target);
      expect(result.status === 'error' && result.error.code).toBe('invalidArgument');
    }
    expect((await unwrap(commands.moveQueryFolder(c.id, null))).parentId).toBeNull();
    let parent: string | null = null;
    for (let depth = 1; depth <= 8; depth++) {
      parent = (await unwrap(commands.createQueryFolder(`l${String(depth)}`, parent))).id;
    }
    const deep = await commands.createQueryFolder('too deep', parent);
    expect(deep.status).toBe('error');
  });

  it('deletes a folder with what it holds and reports the counts', async () => {
    const outer = await unwrap(commands.createQueryFolder('outer', null));
    const inner = await unwrap(commands.createQueryFolder('inner', outer.id));
    await unwrap(commands.createSavedQuery(draft({ name: 'one', folderId: outer.id })));
    await unwrap(commands.createSavedQuery(draft({ name: 'two', folderId: inner.id })));
    const before = (await library()).queries.length;
    expect(await unwrap(commands.deleteQueryFolder(outer.id))).toEqual({ folders: 2, queries: 2 });
    expect((await library()).queries).toHaveLength(before - 2);
  });

  it('searches name, text, description and tags, name first, with the scope filter', async () => {
    const hits = await unwrap(commands.searchSavedQueries('revenue', null));
    const { queries } = await library();
    const names = hits.map((id) => queries.find((q) => q.id === id)?.name);
    expect(names[0]).toBe('Revenue per month');
    expect(await unwrap(commands.searchSavedQueries('  ', null))).toEqual([]);
    const scoped = await unwrap(commands.searchSavedQueries('orders', 'conn-reporting'));
    for (const id of scoped) {
      const found = queries.find((q) => q.id === id);
      expect([null, 'conn-reporting']).toContain(found?.connectionId);
    }
    expect(scoped.length).toBeLessThan(
      (await unwrap(commands.searchSavedQueries('orders', null))).length,
    );
  });

  it('keeps the queries of a deleted connection as global ones', async () => {
    const bound = (await library()).queries.filter((q) => q.connectionId === 'conn-local-pg');
    expect(bound.length).toBeGreaterThan(0);
    await unwrap(commands.deleteConnection('conn-local-pg'));
    const after = (await library()).queries;
    for (const query of bound) {
      const kept = after.find((q) => q.id === query.id);
      expect(kept?.connectionId).toBeNull();
      expect(kept?.database).toBeNull();
    }
  });

  it('duplicates without the trigger word', async () => {
    const snippet = (await unwrap(commands.listSnippets()))[0];
    expect(snippet).toBeDefined();
    const copy = await unwrap(commands.duplicateSavedQuery(snippet?.id ?? '', '(copy)'));
    expect(copy.name.endsWith('(copy)')).toBe(true);
    expect(copy.snippetTrigger).toBeNull();
  });

  it('exports to a file and imports it back without duplicating', async () => {
    await unwrap(commands.exportSavedQueries('/home/ana/library.json'));
    const before = await library();
    const again = await unwrap(commands.importSavedQueries('/home/ana/library.json'));
    expect(again).toEqual({ folders: 0, queries: 0, skipped: before.queries.length });
    mockBackend.clearSavedQueries();
    expect((await library()).queries).toHaveLength(0);
    const restored = await unwrap(commands.importSavedQueries('/home/ana/library.json'));
    expect(restored.queries).toBe(before.queries.length);
    expect(restored.folders).toBe(before.folders.length);
    // Imported queries are global, whatever their scope was.
    expect((await library()).queries.every((q) => q.connectionId === null)).toBe(true);
    const bad = await commands.importSavedQueries('/home/ana/missing.json');
    expect(bad.status === 'error' && bad.error.code).toBe('fileNotFound');
    mockBackend.setFile('/home/ana/other.json', '{"format":"x"}');
    const refused = await commands.importSavedQueries('/home/ana/other.json');
    expect(refused.status).toBe('error');
    const notJson = await commands.exportSavedQueries('/home/ana/library.txt');
    expect(notJson.status).toBe('error');
  });
});
