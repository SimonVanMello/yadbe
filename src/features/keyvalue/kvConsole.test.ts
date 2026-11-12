import { describe, expect, it } from 'vitest';

import { bytesId, decodeBase64, hexDump, isUtf8 } from './kvBytes';
import { consoleLines } from './kvConsoleActions';
import { formatTtl } from './kvFormat';
import { initialMode } from './StringViewer';

const t = (key: string, params?: Record<string, string | number>) =>
  `${key}${params ? ` ${JSON.stringify(params)}` : ''}`;

describe('the lines a console run sends', () => {
  const text = 'PING\nGET a\nGET b\nDBSIZE';

  it('sends everything without a selection', () => {
    expect(consoleLines(text, { anchor: 3, head: 3 }, 'auto')).toEqual({ text, firstLine: 0 });
  });

  it('sends the whole lines a selection touches', () => {
    // From the middle of line 2 to the middle of line 3.
    expect(consoleLines(text, { anchor: 7, head: 13 }, 'auto')).toEqual({
      text: 'GET a\nGET b',
      firstLine: 1,
    });
    // A selection ending at the start of a line leaves that line out.
    expect(consoleLines(text, { anchor: 5, head: 11 }, 'auto').text).toBe('GET a');
  });

  it('sends the line under the cursor', () => {
    expect(consoleLines(text, { anchor: 12, head: 12 }, 'line')).toEqual({
      text: 'GET b',
      firstLine: 2,
    });
  });
});

describe('values', () => {
  it('names bytes stably and decodes them', () => {
    expect(bytesId({ text: 'a', base64: null })).toBe('t:a');
    expect(bytesId({ text: '\\xff', base64: '/w==' })).toBe('b:/w==');
    expect([...decodeBase64('/wA=')]).toEqual([255, 0]);
    expect(isUtf8(new Uint8Array([0xff]))).toBe(false);
  });

  it('dumps bytes in hex with their offset and printable form', () => {
    const dump = hexDump(new TextEncoder().encode('{"a":1}'));
    expect(dump).toBe('00000000  7b 22 61 22 3a 31 7d                             {"a":1}');
  });

  it('opens JSON as JSON, text as text and the rest as hex', () => {
    const encode = (s: string) => new TextEncoder().encode(s);
    expect(initialMode(encode(' {"a": [1]}'), true)).toBe('json');
    expect(initialMode(encode('{"a": [1'), false)).toBe('text');
    expect(initialMode(encode('hello'), true)).toBe('text');
    expect(initialMode(new Uint8Array([0xff, 0xd8]), true)).toBe('hex');
  });

  it('writes a time to live short', () => {
    expect(formatTtl(400, t)).toBe('keyValue.ttl.lessThanSecond');
    expect(formatTtl(42_000, t)).toBe('keyValue.ttl.seconds {"s":42}');
    expect(formatTtl(61_000, t)).toBe('keyValue.ttl.minutes {"m":1,"s":"01"}');
    expect(formatTtl(2 * 86_400_000 + 3_600_000, t)).toBe('keyValue.ttl.days {"d":2,"h":1}');
  });
});
