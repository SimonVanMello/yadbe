import { describe, expect, it } from 'vitest';

import { describeCell, displayLength, DISPLAY_CHARS } from './cellDisplay';
import { isNumericKind } from './cellJson';

describe('describeCell', () => {
  it('tells NULL, the empty string and whitespace apart', () => {
    expect(describeCell(null, 'text')).toEqual({ type: 'null' });
    expect(describeCell('', 'text')).toEqual({ type: 'empty' });
    expect(describeCell('  ', 'text')).toEqual({
      type: 'marked',
      parts: [{ text: '··', mark: true }],
    });
  });

  it('marks leading and trailing whitespace and line breaks', () => {
    expect(describeCell(' a b\tc\n', 'text')).toEqual({
      type: 'marked',
      parts: [
        { text: '·', mark: true },
        { text: 'a b', mark: false },
        { text: '→', mark: true },
        { text: 'c', mark: false },
        { text: '↵', mark: true },
      ],
    });
    expect(describeCell('one\r\ntwo', 'text')).toEqual({
      type: 'marked',
      parts: [
        { text: 'one', mark: false },
        { text: '␍↵', mark: true },
        { text: 'two', mark: false },
      ],
    });
  });

  it('leaves ordinary text and numbers alone', () => {
    expect(describeCell('hello world', 'text')).toEqual({ type: 'plain', text: 'hello world' });
    expect(describeCell('-12.50', 'decimal')).toEqual({ type: 'plain', text: '-12.50' });
  });

  it('shows arrays as plain JSON', () => {
    const text = JSON.stringify([{ kind: 'int', value: '9007199254740993' }, { kind: 'null' }]);
    expect(describeCell(text, 'array')).toEqual({
      type: 'plain',
      text: '[9007199254740993, null]',
    });
  });

  it('prefixes binary', () => {
    expect(describeCell('00ff', 'bytes')).toEqual({ type: 'plain', text: '0x00ff' });
  });

  it('caps what a single-line cell draws', () => {
    const long = 'x'.repeat(5000) + '   ';
    const shown = describeCell(long, 'text');
    expect(shown).toEqual({ type: 'plain', text: 'x'.repeat(DISPLAY_CHARS) });
  });

  it('measures the display length for auto-fit', () => {
    expect(displayLength(null, 'int', 'NULL')).toBe(4);
    expect(displayLength('abcd', 'bytes', 'NULL')).toBe(6);
    expect(displayLength('[{"kind":"text","value":"a"}]', 'array', 'NULL')).toBe(5);
    expect(displayLength('x'.repeat(9000), 'text', 'NULL')).toBe(DISPLAY_CHARS);
  });

  it('knows the numeric kinds', () => {
    expect(isNumericKind('int')).toBe(true);
    expect(isNumericKind('float')).toBe(true);
    expect(isNumericKind('text')).toBe(false);
  });
});
