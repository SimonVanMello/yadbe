import { describe, expect, it } from 'vitest';

import { analyzeValue, extensionFor, hexDump, hexToBytes, parseXml } from './prettyValue';

describe('hexDump', () => {
  it('writes offsets, two groups of bytes and printable ASCII', () => {
    expect(hexDump('48656c6c6f00ff')).toEqual([
      `00000000  48 65 6c 6c 6f 00 ff${' '.repeat(30)}|Hello..|`,
    ]);
    const lines = hexDump('41'.repeat(20));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe(
      '00000000  41 41 41 41 41 41 41 41  41 41 41 41 41 41 41 41  |AAAAAAAAAAAAAAAA|',
    );
    expect(lines[1]?.startsWith('00000010  41 41 41 41 ')).toBe(true);
  });

  it('stops at the limit', () => {
    expect(hexDump('00'.repeat(100), 32)).toHaveLength(2);
  });

  it('decodes bytes', () => {
    expect([...hexToBytes('00ff10')]).toEqual([0, 255, 16]);
  });
});

describe('parseXml', () => {
  it('reads elements, attributes, text and comments', () => {
    expect(parseXml('<a x="1"><!-- c --><b>t</b>  <c/></a>')).toEqual([
      {
        type: 'element',
        name: 'a',
        attributes: [['x', '1']],
        children: [
          { type: 'comment', text: 'c' },
          {
            type: 'element',
            name: 'b',
            attributes: [],
            children: [{ type: 'text', text: 't' }],
          },
          { type: 'element', name: 'c', attributes: [], children: [] },
        ],
      },
    ]);
  });

  it('refuses what is not well-formed XML', () => {
    expect(parseXml('<a><b></a>')).toBeNull();
    expect(parseXml('plain text')).toBeNull();
  });
});

describe('analyzeValue', () => {
  it('offers JSON first for JSON values and JSON-looking text', () => {
    const json = analyzeValue({ kind: 'json', value: '{"a": 1}' });
    expect(json?.modes).toEqual(['json', 'text']);
    expect(analyzeValue({ kind: 'text', value: ' [1, 2]' })?.preferred).toBe('json');
    expect(analyzeValue({ kind: 'text', value: '[not json' })?.modes).toEqual(['text']);
  });

  it('explains a JSON column that does not parse', () => {
    const bad = analyzeValue({ kind: 'json', value: '{"a": }' });
    expect(bad?.modes).toEqual(['text']);
    expect(bad?.jsonError).toMatch(/position/);
  });

  it('shows arrays as JSON with exact numbers', () => {
    const array = analyzeValue({
      kind: 'array',
      value: [{ kind: 'int', value: '9007199254740993' }, { kind: 'null' }],
    });
    expect(array?.json).toEqual({
      type: 'array',
      items: [{ type: 'number', raw: '9007199254740993' }, { type: 'null' }],
    });
  });

  it('offers XML, hex for binary, and nothing for NULL', () => {
    expect(analyzeValue({ kind: 'text', value: '<a/>' })?.modes).toEqual(['xml', 'text']);
    const bytes = analyzeValue({ kind: 'bytes', value: 'cafe' });
    expect(bytes?.preferred).toBe('hex');
    expect(bytes?.text).toBe('cafe');
    expect(analyzeValue({ kind: 'null' })).toBeNull();
    expect(analyzeValue({ kind: 'bool', value: false })?.text).toBe('false');
  });

  it('names saved files by mode', () => {
    expect(extensionFor('json')).toBe('json');
    expect(extensionFor('hex')).toBe('bin');
  });
});
