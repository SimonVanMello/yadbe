import { describe, expect, it } from 'vitest';

import { flattenDocuments, nodeJson, nodeKey, pathText, type DocNode } from './docTree';

const s = (text: string): DocNode => ({
  type: 'scalar',
  kind: 'string',
  text: JSON.stringify(text),
  json: JSON.stringify(text),
  label: null,
});

const doc: DocNode = {
  type: 'object',
  entries: [
    ['name', s('Ana')],
    ['address', { type: 'object', entries: [['city', s('Lyon')]] }],
    ['tags', { type: 'array', items: [s('a'), s('b')] }],
  ],
};

describe('the documents view model', () => {
  it('opens a document on its fields and nothing deeper', () => {
    const rows = flattenDocuments([doc, doc], 0, { depth: 1, overrides: new Map() });
    expect(rows.map((row) => `${String(row.depth)}:${row.label ?? '#'}`)).toEqual([
      '0:#',
      '1:name',
      '1:address',
      '1:tags',
      '0:#',
      '1:name',
      '1:address',
      '1:tags',
    ]);
    expect(rows[2]?.open).toBe(false);
    expect(rows[3]?.size).toBe(2);
  });

  it('follows what the user opened and closed', () => {
    const overrides = new Map([
      [nodeKey(0, ['tags']), true],
      [nodeKey(1, []), false],
    ]);
    const rows = flattenDocuments([doc, doc], 0, { depth: 1, overrides });
    expect(rows.map((row) => pathText(row.path))).toEqual([
      '',
      'name',
      'address',
      'tags',
      'tags.0',
      'tags.1',
      '',
    ]);
    expect(rows.at(-1)?.document).toBe(1);
  });

  it('writes nodes back as JSON, keeping key order', () => {
    expect(nodeJson(doc)).toBe('{"name":"Ana","address":{"city":"Lyon"},"tags":["a","b"]}');
    expect(nodeJson({ type: 'array', items: [] }, 2)).toBe('[]');
    expect(nodeJson({ type: 'object', entries: [['a', s('x')]] }, 2)).toBe('{\n  "a": "x"\n}');
  });
});
