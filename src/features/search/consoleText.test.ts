import { describe, expect, it } from 'vitest';

import { parseMockConsole } from '../../ipc/mock/search';
import { requestAt, requestLines, runLines } from './consoleText';
import { jsonDocument } from './jsonView';

const TEXT =
  '# orders\nGET /orders/_search\n{\n  "size": 1\n}\n\npost _bulk\n{"index":{}}\n{"n":1}\n';

describe('search console text', () => {
  it('finds request lines in any case', () => {
    expect(requestLines(TEXT)).toEqual([1, 6]);
    expect(requestAt(TEXT, 3)).toBe(1);
    expect(requestAt(TEXT, 0)).toBeNull();
    expect(requestAt(TEXT, 8)).toBe(6);
  });

  it('runs the cursor line, the selected lines, or everything', () => {
    const at = (offset: number) => ({ anchor: offset, head: offset });
    expect(runLines(TEXT, at(TEXT.indexOf('"size"')), false)).toEqual({ from: 3, to: 3 });
    const from = TEXT.indexOf('GET');
    const to = TEXT.indexOf('post');
    // A selection ending at the start of a line leaves that line out.
    expect(runLines(TEXT, { anchor: from, head: to }, false)).toEqual({ from: 1, to: 5 });
    expect(runLines(TEXT, at(0), true)).toBeNull();
  });

  it('is read by the mock like the backend reads it', () => {
    const parsed = parseMockConsole(TEXT);
    if (!Array.isArray(parsed)) throw new Error('parsed');
    expect(parsed.map((r) => [r.method, r.path, r.line, r.endLine])).toEqual([
      ['GET', '/orders/_search', 1, 4],
      ['POST', '/_bulk', 6, 8],
    ]);
    expect(parsed[0]?.body).toBe('{\n  "size": 1\n}');
    expect(parsed[1]?.body).toBe('{"index":{}}\n{"n":1}\n');
    const broken = parseMockConsole('{ "a": 1 }\nGET /');
    expect(Array.isArray(broken) ? null : broken.line).toBe(0);
  });
});

describe('plain JSON documents', () => {
  it('keeps numbers as written and marks ids and dates', () => {
    const node = jsonDocument(
      '{"_id":"1","n":9007199254740993,"at":"2025-01-06T09:30:00Z","x":[true,null]}',
    );
    if (node.type !== 'object') throw new Error('object');
    const [id, n, at, x] = node.entries.map(([, value]) => value);
    expect(id).toMatchObject({ kind: 'id', text: '"1"' });
    expect(n).toMatchObject({ kind: 'number', text: '9007199254740993' });
    expect(at).toMatchObject({ kind: 'date' });
    expect(x).toMatchObject({ type: 'array' });
    expect(jsonDocument('not json')).toMatchObject({ type: 'scalar', kind: 'other' });
  });
});
