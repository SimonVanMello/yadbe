import { describe, expect, it } from 'vitest';

import type { DocEdit } from '../bindings';
import { mockBackend, mockClient } from '../mockClient';
import { unwrap } from '../result';

const MONGO = 'conn-catalog-mongo';
const id = (n: number) => `{"$numberInt":"${String(n)}"}`;

describe('the mock document edits', () => {
  const { commands } = mockClient;

  async function connected() {
    mockBackend.reset();
    mockBackend.setLatency(0);
    await unwrap(commands.connect(MONGO, null));
  }

  async function customer(n: number) {
    const page = await unwrap(
      commands.mongoFetchPage(
        'tab-1',
        MONGO,
        'catalog',
        'customers',
        { filter: '', projection: '', sort: '', pageSize: 100 },
        0,
      ),
    );
    const row = page.ids.indexOf(id(n));
    const [doc] = await unwrap(commands.mongoFetchDocuments(page.documents.documentsId, row, 1));
    return doc ?? '';
  }

  const set = (edits: DocEdit[]) => ({ database: 'catalog', collection: 'customers', edits });

  it('applies in one transaction, journals and reverts', async () => {
    await connected();
    const before = await customer(1);
    const changes = set([
      {
        kind: 'update',
        id: id(1),
        fields: [{ path: ['vip'], original: 'true', value: 'false' }],
      },
      { kind: 'insert', document: '{"_id":1000,"name":"New"}' },
    ]);
    const preview = await unwrap(commands.mongoPreviewChanges(MONGO, changes));
    expect(preview.atomic).toBe(true);
    expect(preview.lines[0]?.text).toBe('const session = db.getMongo().startSession()');
    expect(preview.lines.at(-1)?.text).toBe('session.commitTransaction()');
    const outcome = await unwrap(commands.mongoApplyChanges(MONGO, changes));
    expect(outcome.status).toBe('applied');
    expect(outcome.applied).toEqual([0, 1]);
    expect(await customer(1)).toContain('"vip":false');
    const entry = outcome.journalId;
    if (entry === null) throw new Error('journaled');
    const revert = await unwrap(commands.mongoApplyRevert(MONGO, entry));
    expect(revert.status).toBe('applied');
    expect(await customer(1)).toBe(before);
  });

  it('reports the scripted conflict and applies nothing in a transaction', async () => {
    await connected();
    const outcome = await unwrap(
      commands.mongoApplyChanges(
        MONGO,
        set([
          {
            kind: 'update',
            id: id(1),
            fields: [{ path: ['vip'], original: 'true', value: 'false' }],
          },
          {
            kind: 'update',
            id: id(2),
            fields: [
              { path: ['email'], original: '"bruno1@example.com"', value: '"b@example.com"' },
            ],
          },
        ]),
      ),
    );
    expect(outcome.status).toBe('conflicted');
    expect(outcome.applied).toEqual([]);
    expect(outcome.conflicts[0]?.kind).toBe('changed');
    expect(outcome.conflicts[0]?.current).toContain('theirs@example.com');
    expect(await customer(1)).toContain('"vip":true');
  });
});
