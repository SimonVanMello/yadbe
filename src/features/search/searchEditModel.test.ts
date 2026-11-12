import { describe, expect, it } from 'vitest';

import type { SearchEdit, SearchEditInfo } from '../../ipc';
import { consoleErrorOffset } from './consoleText';
import {
  afterApply,
  docKey,
  documentError,
  duplicateTarget,
  hitBlock,
  hitRefOf,
  rebase,
  stage,
  unstage,
} from './searchEditModel';

const guard = (seqNo: string) => ({ seqNo, primaryTerm: '1' });

const replace = (id: string, source = '{}'): SearchEdit => ({
  kind: 'replace',
  index: 'orders',
  id,
  routing: null,
  guard: guard('3'),
  source,
});

const info: SearchEditInfo = {
  readOnly: false,
  indices: [
    { index: 'orders', dataStream: null, closed: false, writeBlock: null, refreshDisabled: false },
    {
      index: '.ds-logs-1',
      dataStream: 'logs',
      closed: false,
      writeBlock: null,
      refreshDisabled: false,
    },
    { index: 'old', dataStream: null, closed: true, writeBlock: null, refreshDisabled: false },
    {
      index: 'full',
      dataStream: null,
      closed: false,
      writeBlock: 'index.blocks.write',
      refreshDisabled: false,
    },
  ],
  dataStreams: ['logs'],
  createTargets: ['logs', 'orders'],
};

describe('search document edits', () => {
  it('reads a hit with its exact version and routing', () => {
    const hit = hitRefOf(
      '{"_index":"orders","_id":"o-1","_seq_no":9007199254740993,"_primary_term":2,"_routing":"eu","_source":{"a":1}}',
    );
    expect(hit).toEqual({
      index: 'orders',
      id: 'o-1',
      routing: 'eu',
      guard: { seqNo: '9007199254740993', primaryTerm: '2' },
      hasSource: true,
    });
    expect(hitRefOf('{"_index":"orders","_id":"x"}')?.hasSource).toBe(false);
    expect(hitRefOf('not json')).toBeNull();
  });

  it('stages one edit per document and keeps what an apply left', () => {
    let list = stage([], replace('a', '{"v":1}'));
    list = stage(list, replace('b'));
    list = stage(list, replace('a', '{"v":2}'));
    expect(list.map((p) => p.key)).toEqual([docKey('orders', 'a'), docKey('orders', 'b')]);
    expect(list[0]?.edit).toMatchObject({ source: '{"v":2}' });
    // Two creates without id are two documents.
    const auto: SearchEdit = {
      kind: 'create',
      index: 'orders',
      id: null,
      routing: null,
      source: '{}',
    };
    list = stage(stage(list, auto), auto);
    expect(list).toHaveLength(4);
    // Editing a document created in this batch stays a create.
    const created = stage([], { ...auto, id: 'n1' });
    const edited = stage(created, { ...replace('n1', '{"x":1}') });
    expect(edited[0]?.edit).toMatchObject({ kind: 'create', id: 'n1', source: '{"x":1}' });

    expect(
      afterApply(list, {
        applied: [list[0], list[1]].map((_, i) => ({
          edit: i,
          index: 'orders',
          id: '',
          result: 'updated',
          guard: null,
        })),
      }),
    ).toEqual(list.slice(2));
    expect(unstage(list, docKey('orders', 'b'))).toHaveLength(3);
    const rebased = rebase(list, 1, guard('8'));
    expect(rebased[1]?.edit).toMatchObject({ guard: guard('8') });
    expect(rebased[0]).toBe(list[0]);
  });

  it('says why a hit cannot be changed', () => {
    const hit = (index: string, hasSource = true) => ({
      index,
      id: '1',
      routing: null,
      guard: null,
      hasSource,
    });
    expect(hitBlock(info, hit('orders'))).toBeNull();
    expect(hitBlock(info, hit('.ds-logs-1'))).toEqual({ kind: 'dataStream', name: 'logs' });
    expect(hitBlock(info, hit('old'))).toEqual({ kind: 'closed', index: 'old' });
    expect(hitBlock(info, hit('full'))?.kind).toBe('writeBlock');
    expect(hitBlock(info, hit('orders', false))).toEqual({ kind: 'noSource' });
    expect(hitBlock({ ...info, readOnly: true }, hit('orders'))).toEqual({
      kind: 'readOnlyConnection',
    });
    expect(duplicateTarget(info, hit('.ds-logs-1'))).toBe('logs');
    expect(duplicateTarget(info, hit('orders'))).toBe('orders');
  });

  it('checks a document as the backend will', () => {
    expect(documentError('{"a": 1}')).toBeNull();
    expect(documentError('[1]')).toBe('notObject');
    expect(documentError('{\n  "a": }')).toMatchObject({ line: 2 });
  });

  it('maps an error position to an offset of the console text', () => {
    const text = 'GET /_search\n{\n  "query": {"mtch": {}}\n}';
    expect(consoleErrorOffset(text, 3, 13)).toBe(text.indexOf('"mtch"'));
    expect(consoleErrorOffset(text, 9, 1)).toBeNull();
  });
});
