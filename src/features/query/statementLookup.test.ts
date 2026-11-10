import { describe, expect, it, vi } from 'vitest';

import { StatementLookup, worthHighlighting } from './statementLookup';

const first = { from: 0, to: 9 };
const second = { from: 10, to: 20 };

describe('StatementLookup', () => {
  it('asks the backend once per offset and document version', async () => {
    const lookup = new StatementLookup();
    const fetch = vi.fn(() => Promise.resolve(first));
    await lookup.at(1, 3, fetch);
    await lookup.at(1, 3, fetch);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('answers an offset inside a known statement without asking again', async () => {
    const lookup = new StatementLookup();
    const fetch = vi.fn(() => Promise.resolve(first));
    await lookup.at(1, 3, fetch);
    expect(await lookup.at(1, 7, fetch)).toEqual(first);
    expect(await lookup.at(1, 9, fetch)).toEqual(first);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('asks again for another statement and for a new document version', async () => {
    const lookup = new StatementLookup();
    const fetch = vi.fn((range) => () => Promise.resolve(range));
    const askFirst = fetch(first);
    const askSecond = fetch(second);
    await lookup.at(1, 3, askFirst);
    expect(await lookup.at(1, 15, askSecond)).toEqual(second);
    expect(await lookup.at(1, 15, askSecond)).toEqual(second);
    await lookup.at(2, 3, askFirst);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('remembers that there is no statement between paragraphs', async () => {
    const lookup = new StatementLookup();
    const fetch = vi.fn(() => Promise.resolve(null));
    expect(await lookup.at(1, 9, fetch)).toBeNull();
    expect(await lookup.at(1, 9, fetch)).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('forgets everything on reset', async () => {
    const lookup = new StatementLookup();
    const fetch = vi.fn(() => Promise.resolve(first));
    await lookup.at(1, 3, fetch);
    lookup.reset();
    await lookup.at(1, 3, fetch);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});

describe('worthHighlighting', () => {
  it('skips a script that is a single statement', () => {
    expect(worthHighlighting({ from: 0, to: 8 }, 'select 1;')).toBe(false);
    expect(worthHighlighting({ from: 2, to: 10 }, '\n\nselect 1;\n')).toBe(false);
  });

  it('highlights one statement among several', () => {
    expect(worthHighlighting({ from: 0, to: 8 }, 'select 1;\nselect 2;')).toBe(true);
    expect(worthHighlighting({ from: 10, to: 18 }, 'select 1;\nselect 2;')).toBe(true);
  });
});
