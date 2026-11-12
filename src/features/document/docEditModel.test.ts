import { describe, expect, it } from 'vitest';

import { parseJson } from '../grid/jsonTree';
import {
  addDocument,
  cellOf,
  compactJson,
  deleteDocuments,
  duplicateOf,
  editableText,
  editorText,
  effective,
  fieldTypeOf,
  keepMine,
  NO_EDITS,
  pendingCount,
  replaceDocument,
  setField,
  toChangeSet,
  typedValue,
  undelete,
  withoutApplied,
  type Target,
} from './docEditModel';
import { overlayOf } from './docOverlay';

const ID = '{"$oid":"64b7f0c2a1b2c3d4e5f60718"}';
const DOC = `{"_id":${ID},"qty":{"$numberInt":"5"},"tags":["x","y"],"dims":{"w":{"$numberInt":"1"}},"old":null}`;
const target: Target = { id: ID, original: DOC };

function must<T>(value: T | null): T {
  if (value === null) throw new Error('refused');
  return value;
}

describe('pending document edits', () => {
  it('keeps the value seen at each path, and drops a change set back', () => {
    let edits = must(setField(NO_EDITS, target, ['qty'], '{"$numberInt":"6"}'));
    edits = must(setField(edits, target, ['note'], '"new"'));
    edits = must(setField(edits, target, ['old'], null));
    const edit = edits.documents.get(ID);
    expect([...(edit?.fields.values() ?? [])]).toEqual([
      { path: ['qty'], original: '{"$numberInt":"5"}', value: '{"$numberInt":"6"}' },
      { path: ['note'], original: null, value: '"new"' },
      { path: ['old'], original: 'null', value: null },
    ]);
    // Back to what was read: no change left for that path.
    edits = must(setField(edits, target, ['qty'], '{"$numberInt":"5"}'));
    expect(edits.documents.get(ID)?.fields.size).toBe(2);
    expect(pendingCount(edits)).toBe(1);
  });

  it('edits a changed field from inside, and a whole value replaces what is inside it', () => {
    let edits = must(setField(NO_EDITS, target, ['dims'], '{"w":{"$numberInt":"2"}}'));
    edits = must(setField(edits, target, ['dims', 'h'], '{"$numberInt":"3"}'));
    const fields = [...(edits.documents.get(ID)?.fields.values() ?? [])];
    expect(fields).toEqual([
      {
        path: ['dims'],
        original: '{"w":{"$numberInt":"1"}}',
        value: '{"w":{"$numberInt":"2"},"h":{"$numberInt":"3"}}',
      },
    ]);
    edits = must(setField(NO_EDITS, target, ['dims', 'w'], '{"$numberInt":"9"}'));
    edits = must(setField(edits, target, ['dims'], '{}'));
    expect([...(edits.documents.get(ID)?.fields.keys() ?? [])]).toEqual(['["dims"]']);
  });

  it('changes array elements in place only', () => {
    expect(setField(NO_EDITS, target, ['tags', 1], '"z"')).not.toBeNull();
    expect(setField(NO_EDITS, target, ['tags', 5], '"z"')).toBeNull();
    expect(setField(NO_EDITS, target, ['tags', 1], null)).toBeNull();
  });

  it('shows the document as it will be', () => {
    let edits = must(setField(NO_EDITS, target, ['tags', 1], '"z"'));
    edits = must(setField(edits, target, ['old'], null));
    const edit = edits.documents.get(ID);
    if (!edit) throw new Error('edit');
    expect(compactJson(must(effective(edit)))).toBe(
      `{"_id":${ID},"qty":{"$numberInt":"5"},"tags":["x","z"],"dims":{"w":{"$numberInt":"1"}}}`,
    );
    const deleted = deleteDocuments(edits, [target]);
    const gone = deleted.documents.get(ID);
    expect(gone && effective(gone)).toBeNull();
    expect(undelete(deleted, ID).documents.get(ID)?.deleted).toBe(false);
  });

  it('replaces a document edited as JSON, and the same text drops it', () => {
    const changed = replaceDocument(NO_EDITS, target, '{"qty":7}');
    expect(changed.documents.get(ID)?.replacement).toBe('{"qty":7}');
    expect(replaceDocument(NO_EDITS, target, DOC).documents.size).toBe(0);
  });

  it('builds the change set in order and forgets what was applied', () => {
    let edits = must(setField(NO_EDITS, target, ['qty'], '{"$numberInt":"6"}'));
    edits = addDocument(edits, '{"_id":1,"a":true}');
    const { changes, refs } = toChangeSet(edits, 'shop', 'items');
    expect(changes.edits.map((e) => e.kind)).toEqual(['update', 'insert']);
    expect(refs[0]).toEqual({ kind: 'document', id: ID });
    expect(pendingCount(withoutApplied(edits, refs, [1]))).toBe(1);
    expect(pendingCount(withoutApplied(edits, refs, [0, 1]))).toBe(0);
  });

  it('keeps mine over what the server holds now', () => {
    const edits = must(setField(NO_EDITS, target, ['qty'], '{"$numberInt":"6"}'));
    const current = DOC.replace('"5"', '"8"');
    const rebased = keepMine(edits, {
      edit: 0,
      kind: 'changed',
      id: ID,
      current,
      fields: [
        { path: ['qty'], seen: '{"$numberInt":"5"}', now: '{"$numberInt":"8"}', yours: null },
      ],
    });
    const field = rebased.documents.get(ID)?.fields.get('["qty"]');
    expect(field?.original).toBe('{"$numberInt":"8"}');
    expect(rebased.documents.get(ID)?.original).toBe(current);
    // A change already equal to theirs has nothing left to do.
    const same = keepMine(edits, {
      edit: 0,
      kind: 'changed',
      id: ID,
      current: DOC.replace('"5"', '"6"'),
      fields: [],
    });
    expect(same.documents.size).toBe(0);
    expect(
      keepMine(edits, { edit: 0, kind: 'deleted', id: ID, current: null, fields: [] }).documents
        .size,
    ).toBe(0);
  });

  it('duplicates with a new ObjectId first', () => {
    const copy = parseJson(duplicateOf(DOC));
    if (copy.type !== 'object') throw new Error('object');
    expect(copy.entries[0]?.[0]).toBe('_id');
    expect(compactJson(copy.entries[0]?.[1] ?? { type: 'null' })).not.toBe(ID);
    expect(copy.entries.map(([k]) => k)).toEqual(['_id', 'qty', 'tags', 'dims', 'old']);
  });
});

describe('the field editor', () => {
  it('keeps the type a value had', () => {
    const value = (text: string) => parseJson(text);
    expect(fieldTypeOf(value('{"$numberInt":"5"}'))).toBe('int');
    expect(fieldTypeOf(value('{"$numberLong":"5"}'))).toBe('long');
    expect(fieldTypeOf(value('{"$numberDouble":"5.0"}'))).toBe('double');
    expect(fieldTypeOf(value('{"$numberDecimal":"5.10"}'))).toBe('decimal');
    expect(fieldTypeOf(value('{"$oid":"64b7f0c2a1b2c3d4e5f60718"}'))).toBe('objectId');
    expect(fieldTypeOf(value('{"$date":{"$numberLong":"0"}}'))).toBe('date');
    expect(fieldTypeOf(value('[1]'))).toBe('json');
    expect(editorText(value('{"$date":{"$numberLong":"0"}}'), 'date')).toBe(
      '1970-01-01T00:00:00.000Z',
    );
    expect(editorText(value('{"$numberLong":"9007199254740993"}'), 'long')).toBe(
      '9007199254740993',
    );
  });

  it('writes typed Extended JSON and refuses what is not of the type', () => {
    expect(typedValue('int', '6')).toEqual({ ok: true, json: '{"$numberInt":"6"}' });
    expect(typedValue('int', '3000000000').ok).toBe(false);
    expect(typedValue('long', '9007199254740993')).toEqual({
      ok: true,
      json: '{"$numberLong":"9007199254740993"}',
    });
    expect(typedValue('double', '5')).toEqual({ ok: true, json: '{"$numberDouble":"5.0"}' });
    expect(typedValue('double', 'NaN')).toEqual({ ok: true, json: '{"$numberDouble":"NaN"}' });
    expect(typedValue('decimal', '1.10')).toEqual({ ok: true, json: '{"$numberDecimal":"1.10"}' });
    expect(typedValue('date', '1970-01-01T00:00:01Z')).toEqual({
      ok: true,
      json: '{"$date":{"$numberLong":"1000"}}',
    });
    expect(typedValue('objectId', 'nope').ok).toBe(false);
    expect(typedValue('string', 'a"b')).toEqual({ ok: true, json: '"a\\"b"' });
    expect(typedValue('json', '{"a":').ok).toBe(false);
  });

  it('shows documents relaxed where nothing is lost', () => {
    expect(
      editableText(
        '{"a":{"$numberInt":"1"},"b":{"$numberLong":"2"},"c":{"$numberDouble":"2.0"},"d":{"$numberDouble":"2.5"}}',
      ),
    ).toBe(
      '{\n  "a": 1,\n  "b": {\n    "$numberLong": "2"\n  },\n  "c": {\n    "$numberDouble": "2.0"\n  },\n  "d": 2.5\n}',
    );
  });
});

describe('the grid overlay of a page', () => {
  it('marks changed cells, deleted rows and new documents', () => {
    const columns = ['_id', 'qty', 'tags'].map((name) => ({
      name,
      typeName: '',
      kind: 'text' as const,
    }));
    let edits = must(setField(NO_EDITS, target, ['qty'], '{"$numberInt":"6"}'));
    const other: Target = { id: '{"$numberInt":"2"}', original: '{"_id":{"$numberInt":"2"}}' };
    edits = deleteDocuments(edits, [other]);
    edits = addDocument(edits, '{"_id":3,"qty":4}');
    const overlay = overlayOf(edits, [ID, other.id, null], columns, (text) => `was ${text ?? '-'}`);
    expect(overlay.rows.get(0)?.state).toBe('modified');
    expect(overlay.rows.get(0)?.cells.get(1)).toEqual({ text: '6', kind: 'int' });
    expect(overlay.rows.get(0)?.titles.get(1)).toBe('was 5');
    expect(overlay.rows.get(1)?.state).toBe('deleted');
    expect(overlay.added).toEqual([
      [cellOf(parseJson('3')), cellOf(parseJson('4')), { text: '', kind: 'missing' }],
    ]);
  });
});
