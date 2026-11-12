import { describe, expect, it } from 'vitest';

import { mockBackend, mockClient } from '../mockClient';
import { unwrap } from '../result';

describe('the mock search document edits', () => {
  const { commands } = mockClient;

  async function connected() {
    mockBackend.reset();
    mockBackend.setLatency(0);
    await unwrap(commands.connect('conn-search', null));
  }

  it('applies one document at a time, journals and reverts', async () => {
    await connected();
    const info = await unwrap(commands.searchEditInfo('conn-search', 'orders'));
    expect(info.createTargets).toEqual(['orders']);
    const doc = await unwrap(commands.searchGetDocument('conn-search', 'orders', 'o-10000', null));
    expect(doc.found).toBe(true);
    const guard = doc.guard ?? { seqNo: '0', primaryTerm: '1' };
    const changes = {
      target: 'orders',
      edits: [
        {
          kind: 'replace' as const,
          index: 'orders',
          id: 'o-10000',
          routing: null,
          guard,
          source: '{"status":"edited"}',
        },
        { kind: 'create' as const, index: 'orders', id: 'new-1', routing: null, source: '{}' },
      ],
    };
    const preview = await unwrap(commands.searchPreviewChanges('conn-search', changes));
    expect(preview.requests[0]?.text.split('\n')[0]).toBe(
      'PUT /orders/_doc/o-10000?if_seq_no=0&if_primary_term=1&refresh=wait_for',
    );
    expect(preview.requests[1]?.text.split('\n')[0]).toBe(
      'PUT /orders/_doc/new-1?op_type=create&refresh=wait_for',
    );
    const outcome = await unwrap(commands.searchApplyChanges('conn-search', changes));
    expect(outcome.applied).toHaveLength(2);
    expect(outcome.revertible).toBe(true);

    // The same edit again meets the new version: a conflict, the create an existing id.
    const again = await unwrap(commands.searchApplyChanges('conn-search', changes));
    expect(again.applied).toHaveLength(0);
    expect(again.stopped?.reason.kind === 'conflict' && again.stopped.reason.conflict.kind).toBe(
      'changed',
    );

    const reverted = await unwrap(
      commands.searchApplyRevert('conn-search', outcome.journalId ?? 0),
    );
    expect(reverted.stopped).toBeNull();
    const back = await unwrap(commands.searchGetDocument('conn-search', 'orders', 'o-10000', null));
    expect(back.source).toContain('"status": "paid"');
    const gone = await unwrap(commands.searchGetDocument('conn-search', 'orders', 'new-1', null));
    expect(gone.found).toBe(false);
  });

  it('refuses data stream edits and stops at the first failure', async () => {
    await connected();
    const info = await unwrap(commands.searchEditInfo('conn-search', 'logs-web'));
    expect(info.dataStreams).toEqual(['logs-web']);
    const backing = '.ds-logs-web-2025.11.12-000001';
    const preview = await unwrap(
      commands.searchPreviewChanges('conn-search', {
        target: 'logs-web',
        edits: [
          {
            kind: 'delete',
            index: backing,
            id: '.ds-0',
            routing: null,
            guard: { seqNo: '0', primaryTerm: '1' },
          },
        ],
      }),
    );
    expect(preview.refused[0]?.reason).toEqual({ kind: 'dataStream', name: 'logs-web' });

    const outcome = await unwrap(
      commands.searchApplyChanges('conn-search', {
        target: 'products',
        edits: [
          {
            kind: 'delete',
            index: 'products',
            id: 'SKU-001',
            routing: null,
            guard: { seqNo: '0', primaryTerm: '1' },
          },
          {
            kind: 'delete',
            index: 'products',
            id: 'SKU-002',
            routing: null,
            guard: { seqNo: '5', primaryTerm: '1' },
          },
          {
            kind: 'delete',
            index: 'products',
            id: 'SKU-003',
            routing: null,
            guard: { seqNo: '0', primaryTerm: '1' },
          },
        ],
      }),
    );
    expect(outcome.applied.map((a) => a.id)).toEqual(['SKU-001']);
    expect(outcome.stopped?.edit).toBe(1);
    const third = await unwrap(
      commands.searchGetDocument('conn-search', 'products', 'SKU-003', null),
    );
    expect(third.found).toBe(true);
  });
});
