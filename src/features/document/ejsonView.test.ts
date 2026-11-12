import { describe, expect, it } from 'vitest';

import type { DocNode } from '../documents/docTree';
import { ejsonDocument } from './ejsonView';

function scalars(node: DocNode): Record<string, [string, string | null, string]> {
  if (node.type !== 'object') throw new Error('an object');
  return Object.fromEntries(
    node.entries.map(([key, value]) => {
      if (value.type !== 'scalar') return [key, [value.type, null, '']];
      return [key, [value.text, value.label, value.json]];
    }),
  );
}

describe('MongoDB documents in the documents view', () => {
  it('shows canonical Extended JSON the relaxed way', () => {
    const doc = ejsonDocument(
      JSON.stringify({
        _id: { $oid: '5f2b8c9e1c9d440000a1b2c3' },
        n: { $numberInt: '42' },
        big: { $numberLong: '9223372036854775807' },
        price: { $numberDecimal: '19.90' },
        ratio: { $numberDouble: '3.0' },
        at: { $date: { $numberLong: '1700000000123' } },
        id: { $binary: { base64: 'EjRWeJASNFZ4kBI0VniQEg==', subType: '04' } },
        re: { $regularExpression: { pattern: '^a', options: 'i' } },
        s: 'text',
        none: null,
      }),
    );
    expect(scalars(doc)).toEqual({
      _id: [
        "ObjectId('5f2b8c9e1c9d440000a1b2c3')",
        'objectId',
        '{"$oid":"5f2b8c9e1c9d440000a1b2c3"}',
      ],
      n: ['42', null, '42'],
      big: ['9223372036854775807', 'long', '9223372036854775807'],
      price: ['19.90', 'decimal', '{"$numberDecimal":"19.90"}'],
      ratio: ['3', 'double', '3.0'],
      at: ['2023-11-14T22:13:20.123Z', 'date', '{"$date":"2023-11-14T22:13:20.123Z"}'],
      id: [
        "UUID('12345678-9012-3456-7890-123456789012')",
        'uuid',
        '{"$binary":{"base64":"EjRWeJASNFZ4kBI0VniQEg==","subType":"04"}}',
      ],
      re: ['/^a/i', 'regex', '{"$regularExpression":{"pattern":"^a","options":"i"}}'],
      s: ['"text"', null, '"text"'],
      none: ['null', null, 'null'],
    });
  });

  it('keeps documents, arrays and query operators as trees', () => {
    const doc = ejsonDocument('{"a":{"$gt":1},"b":[{"c":{"$numberInt":"2"}}]}');
    expect(doc.type).toBe('object');
    if (doc.type !== 'object') return;
    expect(doc.entries[0]?.[1].type).toBe('object');
    const b = doc.entries[1]?.[1];
    expect(b?.type).toBe('array');
  });
});
