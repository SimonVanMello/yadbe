import { describe, expect, it } from 'vitest';

import type { Engine, EngineFamily } from '../../ipc';
import { HIGHLIGHT_CHARS, highlightRuns as runsOf, mergePieces } from './historyHighlight';

const FAMILY: Partial<Record<Engine, EngineFamily>> = {
  mongodb: 'document',
  redis: 'keyValue',
  elasticsearch: 'search',
};

/** The runs of `text` for `engine`, with the family the backend gives that engine. */
function highlightRuns(engine: Engine, text: string) {
  return runsOf(engine, FAMILY[engine] ?? 'sql', text);
}

/** The text of the runs that carry a colour class. */
function colored(engine: Engine, text: string): string[] {
  return highlightRuns(engine, text)
    .filter((run) => run.className !== null)
    .map((run) => text.slice(run.from, run.to));
}

describe('highlightRuns', () => {
  it('covers the whole text with contiguous runs, whatever the family', () => {
    const samples: [Engine, string][] = [
      ['postgres', "SELECT 'a', 1 FROM t -- c"],
      ['mssql', 'SELECT TOP 1 [x] FROM dbo.T'],
      ['mongodb', 'db.users.find({ age: { $gt: 3 } }).limit(2)'],
      ['redis', 'SET "k" 42 # note'],
      ['elasticsearch', 'GET /idx/_search\n{ "q": 1 }'],
    ];
    for (const [engine, text] of samples) {
      const runs = highlightRuns(engine, text);
      expect(runs.at(0)?.from).toBe(0);
      expect(runs.at(-1)?.to).toBe(text.length);
      runs.forEach((run, i) => {
        if (i > 0) expect(run.from).toBe(runs[i - 1]?.to);
      });
    }
  });

  it('colours SQL keywords, strings, numbers and comments', () => {
    const found = colored('postgres', "SELECT 'x', 12 FROM t -- tail");
    expect(found).toEqual(expect.arrayContaining(['SELECT', "'x'", '12', 'FROM', '-- tail']));
    expect(found).not.toContain('t');
  });

  it('uses the dialect of the engine', () => {
    expect(colored('mssql', 'SELECT TOP 5 * FROM dbo.T')).toContain('TOP');
  });

  it('colours mongosh as JavaScript', () => {
    const found = colored('mongodb', "db.users.find({ name: 'a' }, { _id: 0 })");
    expect(found).toEqual(expect.arrayContaining(["'a'", '0']));
  });

  it('colours the command, strings and numbers of a Redis line', () => {
    expect(colored('redis', 'SET "k v" 42')).toEqual(['SET', '"k v"', '42']);
    expect(colored('redis', '# note')).toEqual(['# note']);
  });

  it('colours the method of a search request, its keys and values, not the path', () => {
    const found = colored('elasticsearch', 'POST /idx/_search\n{ "size": 3, "q": "a", "t": true }');
    expect(found).toEqual(expect.arrayContaining(['POST', '"size"', '3', '"a"', 'true']));
    expect(found).not.toContain('/idx/_search');
  });

  it('only parses the start of a long entry', () => {
    const long = `SELECT ${'a, '.repeat(HIGHLIGHT_CHARS)}z FROM t`;
    expect(highlightRuns('postgres', long).at(-1)?.to).toBe(HIGHLIGHT_CHARS);
  });

  it('memoizes by engine and text', () => {
    expect(highlightRuns('postgres', 'SELECT 1')).toBe(highlightRuns('postgres', 'SELECT 1'));
    expect(highlightRuns('postgres', 'SELECT 1')).not.toBe(highlightRuns('mysql', 'SELECT 1'));
  });
});

describe('mergePieces', () => {
  it('keeps the syntax class around a match', () => {
    const text = 'SELECT orders FROM t';
    const pieces = mergePieces(text, highlightRuns('postgres', text), [[7, 10]]);
    expect(pieces.map((p) => p.text).join('')).toBe(text);
    expect(pieces.filter((p) => p.match).map((p) => p.text)).toEqual(['ord']);
    expect(pieces[0]).toMatchObject({ text: 'SELECT', match: false });
    expect(pieces[0]?.className).toEqual(expect.any(String));
  });

  it('splits a token that a match cuts in two', () => {
    const text = "SELECT 'abc'";
    const pieces = mergePieces(text, highlightRuns('postgres', text), [[8, 10]]);
    expect(pieces.map((p) => [p.text, p.match])).toEqual([
      ['SELECT', false],
      [' ', false],
      ["'", false],
      ['ab', true],
      ["c'", false],
    ]);
    expect(pieces[2]?.className).toBe(pieces[4]?.className);
  });
});
