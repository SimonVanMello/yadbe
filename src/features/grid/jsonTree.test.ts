import { describe, expect, it } from 'vitest';

import { countNodes, JsonSyntaxError, parseJson, stringifyJson, tryParseJson } from './jsonTree';

describe('parseJson', () => {
  it('keeps numbers exactly as written', () => {
    const tree = parseJson('{"big": 12345678901234567890.25, "n": -0.0e-7}');
    expect(tree).toEqual({
      type: 'object',
      entries: [
        ['big', { type: 'number', raw: '12345678901234567890.25' }],
        ['n', { type: 'number', raw: '-0.0e-7' }],
      ],
    });
  });

  it('reads every value type and escapes', () => {
    const tree = parseJson(' [true, false, null, "a\\"b\\u00e9", [], {}] ');
    expect(stringifyJson(tree)).toBe('[true, false, null, "a\\"bé", [], {}]');
  });

  it('pretty-prints with indentation', () => {
    expect(stringifyJson(parseJson('{"a":[1,{"b":2}]}'), 2)).toBe(
      '{\n  "a": [\n    1,\n    {\n      "b": 2\n    }\n  ]\n}',
    );
  });

  it('rejects invalid JSON with a position', () => {
    expect(() => parseJson('{"a" 1}')).toThrow(JsonSyntaxError);
    expect(() => parseJson('[1,]')).toThrow(/position 3/);
    expect(() => parseJson('1 2')).toThrow(/after the value/);
    expect(() => parseJson('"tab\there"')).toThrow();
    expect(() => parseJson('01')).toThrow();
    expect(tryParseJson('nope')).toBeNull();
  });

  it('refuses absurd nesting instead of overflowing the stack', () => {
    expect(() => parseJson('['.repeat(10_000) + ']'.repeat(10_000))).toThrow(/deep/);
  });

  it('counts nodes up to a limit', () => {
    const tree = parseJson('[1, [2, 3], {"a": 4}]');
    expect(countNodes(tree)).toBe(7);
    expect(countNodes(tree, 3)).toBe(3);
  });
});
