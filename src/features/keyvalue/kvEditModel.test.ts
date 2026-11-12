import { describe, expect, it } from 'vitest';

import type { KvBytes, KvConflict, KvEdit } from '../../ipc';
import {
  bytesValue,
  cellBytes,
  overlayOf,
  parseHex,
  pendingCount,
  rebase,
  rowIdentity,
  upsert,
} from './kvEditModel';
import { jsonAt, validScore } from './kvEditForms';

const t = (text: string): KvBytes => ({ text, base64: null });
const key = t('user:1');

describe('pending key edits', () => {
  it('keeps one edit per field, with what the server held first', () => {
    let edits: KvEdit[] = [];
    edits = upsert(edits, {
      op: 'hashSet',
      key,
      field: t('name'),
      original: t('Ada'),
      value: t('A'),
    });
    edits = upsert(edits, {
      op: 'hashSet',
      key,
      field: t('name'),
      original: t('A'),
      value: t('B'),
    });
    expect(edits).toEqual([
      { op: 'hashSet', key, field: t('name'), original: t('Ada'), value: t('B') },
    ]);
    // Back to the original: nothing left to apply.
    edits = upsert(edits, {
      op: 'hashSet',
      key,
      field: t('name'),
      original: t('B'),
      value: t('Ada'),
    });
    expect(edits).toEqual([]);
    // Added then removed: nothing happened.
    edits = upsert(edits, { op: 'hashSet', key, field: t('x'), original: null, value: t('1') });
    edits = upsert(edits, { op: 'hashDelete', key, field: t('x'), original: t('1') });
    expect(edits).toEqual([]);
    // Changed then removed: the removal checks the server's value.
    edits = upsert(edits, { op: 'listSet', key, index: 2, original: t('a'), value: t('b') });
    edits = upsert(edits, { op: 'listRemove', key, index: 2, original: t('b') });
    expect(edits).toEqual([{ op: 'listRemove', key, index: 2, original: t('a') }]);
    edits = upsert(edits, { op: 'listPush', key, head: false, values: [t('1'), t('2')] });
    expect(pendingCount(edits)).toBe(3);
  });

  it('draws changed, removed and added rows over the grid', () => {
    const overlay = overlayOf([
      { op: 'hashSet', key, field: t('name'), original: t('Ada'), value: t('Grace') },
      { op: 'hashDelete', key, field: t('old'), original: t('x') },
      { op: 'hashSet', key, field: t('city'), original: null, value: t('Paris') },
      { op: 'hashRename', key, field: t('plan'), to: t('tier'), value: t('pro') },
    ]);
    const name = overlay.rows.get(rowIdentity('hash', [t('name'), t('Ada')]));
    expect(name?.state).toBe('modified');
    expect(name?.cells.get(1)).toBe('Grace');
    expect(name?.titles.get(1)).toBe('Ada');
    expect(overlay.rows.get(rowIdentity('hash', [t('old')]))?.state).toBe('deleted');
    expect(overlay.rows.get(rowIdentity('hash', [t('plan')]))?.cells.get(0)).toBe('tier');
    expect(overlay.added).toEqual([['city', 'Paris']]);
    expect(rowIdentity('list', [t('4'), t('v')])).toBe('i:4');
    expect(rowIdentity('zset', [t('0'), t('m'), t('1')])).toBe(rowIdentity('set', [t('m')]));
  });

  it('keeps mine over what the server holds now, when it can', () => {
    const conflict = (patch: Partial<KvConflict>): KvConflict => ({
      edit: 0,
      key,
      kind: 'changed',
      expected: 'Ada',
      current: t('Grace'),
      actualType: null,
      rebasable: true,
      ...patch,
    });
    const edit: KvEdit = {
      op: 'hashSet',
      key,
      field: t('name'),
      original: t('Ada'),
      value: t('Lin'),
    };
    expect(rebase(edit, conflict({}))).toEqual({ ...edit, original: t('Grace') });
    expect(rebase(edit, conflict({ kind: 'missing', current: null, rebasable: false }))).toBeNull();
    const ttl: KvEdit = { op: 'expire', key, original: null, ttl: { kind: 'persist' } };
    expect(rebase(ttl, conflict({ current: t('1700000000000') }))).toEqual({
      ...ttl,
      original: 1_700_000_000_000,
    });
  });

  it('reads binary cells and hexadecimal exactly', () => {
    expect(cellBytes('ff00', 'bytes')).toEqual({ text: '\\xff\\x00', base64: '/wA=' });
    expect(cellBytes('ff00', 'text')).toEqual(t('ff00'));
    expect(bytesValue(new TextEncoder().encode('été'))).toEqual(t('été'));
    expect(parseHex('ff 00\n7f')).toEqual(new Uint8Array([0xff, 0, 0x7f]));
    expect(parseHex('f')).toBeNull();
    expect(parseHex('zz')).toBeNull();
  });

  it('checks scores and JSON paths before staging', () => {
    expect(validScore('-inf')).toBe(true);
    expect(validScore('1.5e3')).toBe(true);
    expect(validScore('')).toBe(false);
    expect(validScore('abc')).toBe(false);
    const doc = { name: 'Ada', items: [{ id: 1 }], 'a b': true };
    expect(jsonAt(doc, '$')).toBe(doc);
    expect(jsonAt(doc, '$.items[0].id')).toBe(1);
    expect(jsonAt(doc, "$['a b']")).toBe(true);
    expect(jsonAt(doc, '$.missing')).toBeUndefined();
    expect(jsonAt(doc, 'name')).toBeUndefined();
  });
});
